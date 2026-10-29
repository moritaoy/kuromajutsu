// ============================================================
// Workspace の実行系（docs/spec.md §13.5 / §13.8）
//
// 承認 → Magentic 実行、ゲートの記録、人間レビューでの停止と再開、`update_ledger` との連携、
// Orchestrator の完了判定を担う。`WorkspaceService` が委譲する。
// ============================================================

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentManager } from "../agent/manager.js";
import type {
  AgentState,
  AppConfig,
  GateCheckResult,
  GateResult,
  HumanReview,
  MagenticConfig,
  Phase,
  ReviewComment,
  RoleDefinition,
  ScheduledStep,
  WorkPlan,
  Workspace,
  WorkspaceReport,
} from "../types/index.js";
import { WorkspaceError } from "./errors.js";
import { buildCommandPolicy, checkCommand, getWorkspaceConfig } from "./gate-commands.js";
import type { GateCommandRunner } from "./gate-runner.js";
import {
  autoChecksOf,
  deriveGateStatus,
  failedAttemptsSinceRetry,
  hasHumanCheck,
  isRetryLimitExceeded,
  newGateResult,
  recordCheckResult,
  remapGateChecks,
} from "./gates.js";
import { guardLedgerUpdate, type IncomingPhase } from "./ledger-guard.js";
import {
  buildResumePrompt,
  buildWorkspaceInjectionBlock,
  type ResumeReason,
} from "./orchestrator-prompt.js";
import { finalGate, toTaskLedgerInput } from "./plan.js";
import { buildWorkspaceReport } from "./report.js";
import {
  prepareReviewFiles,
  renderReviewDoc,
  reviewFileName,
  reviewFilesDirName,
  REVIEW_FILE_MAX_BYTES,
} from "./review-doc.js";
import { extractJson, parseReviewDoc } from "./schema.js";
import type { WorkspaceStore } from "./store.js";
import { hasErrors, validateWorkPlan, type ValidationContext } from "./validator.js";

// --------------------------------------------------
// 型
// --------------------------------------------------

export interface WorkspaceRunnerDeps {
  /** `command` チェックの実行（既定は ShellGateCommandRunner） */
  gateRunner: GateCommandRunner;
  /** mermaid のランタイム（JS のソース）。無ければ undefined */
  mermaidRuntime: () => string | undefined;
  /** 現在時刻（ISO 8601） */
  now: () => string;
  /** 再開時に旧 Orchestrator の終了を待つ上限（ミリ秒。既定 30000。§13.8.4） */
  resumeWait_ms: number;
}

export interface WorkspaceRunnerHelpers {
  validationContext(): ValidationContext;
  /** 計画で使える職種（orchestrator / planner を除き、ヘルスチェックが無いか通過したもの） */
  availableRoles(): RoleDefinition[];
}

/** emit の関数（service の EventEmitter に委譲する） */
export type RunnerEmit = (event: string, data: unknown) => void;

export interface GateCheckOutcome {
  gateId: string;
  attempt: number;
  gateStatus: GateResult["status"];
  failedAttempts: number;
  maxRetries: number;
  retryLimitExceeded: boolean;
  pendingChecks: { checkIndex: number; method: "agent-review" | "command" | "human" }[];
  /** retryLimitExceeded のとき、Orchestrator への指示 */
  instruction?: string;
}

export interface RunGateCheckResult extends GateCheckOutcome {
  groupId: string;
  results: {
    checkIndex: number;
    text: string;
    command: string;
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    duration_ms: number;
    stdoutTail: string;
    stderrTail: string;
  }[];
}

export interface ReportGateResultResult
  extends Pick<
    GateCheckOutcome,
    "gateId" | "attempt" | "gateStatus" | "failedAttempts" | "maxRetries" | "retryLimitExceeded" | "instruction"
  > {
  registered: true;
  checkIndex: number;
}

export interface RequestHumanReviewResult {
  registered: true;
  gateId: string;
  reviewVersion: number;
  reviewFile: string;
  status: "waiting_human";
  next: string;
}

export interface LedgerUpdateInput {
  phases?: IncomingPhase[];
  scheduledSteps?: ScheduledStep[];
  irregular?: boolean;
  reason?: string;
}

interface RunState {
  /** 完了を待っている Orchestrator の Agent ID */
  watchedAgentId?: string;
  /** 実行中の `run_gate_check` の中断用（中断・シャットダウンで実行中のコマンドを止める） */
  gateAborts: Set<AbortController>;
}

const DEFAULT_MAX_RETRIES = 2;

/** 差し戻し上限超過のとき Orchestrator に返す指示（§13.5.6） */
const RETRY_LIMIT_INSTRUCTION =
  "差し戻し上限に達しました。作業を打ち切り、report_result を status=success、summary=「差し戻し上限超過で一時停止」で呼んで終了してください。" +
  "人が判断したあと、サーバーが新しい Orchestrator で再開します。";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const bullets = (items: string[]): string => items.map((x) => `- ${x}`).join("\n");

/** reviews/ 配下のファイル名に使える ID か */
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --------------------------------------------------
// WorkspaceRunner
// --------------------------------------------------

export class WorkspaceRunner {
  /** groupId → workspaceId（Magentic 親グループのみ） */
  private readonly groupIndex = new Map<string, string>();
  private readonly runs = new Map<string, RunState>();
  /** 完了を待っている Orchestrator: agentId → workspaceId */
  private readonly watched = new Map<string, string>();
  /**
   * 全 Workspace の Orchestrator の完了を受ける 1 つのリスナー。
   * 待っている Orchestrator があるときだけ登録する（実行中の Workspace が増えても
   * EventEmitter のリスナー数が増えず、待ちが無ければ登録も残らない）。
   */
  private completedListener?: (agent: AgentState) => void;

  constructor(
    private readonly config: AppConfig,
    private readonly manager: AgentManager,
    private readonly store: WorkspaceStore,
    private readonly emit: RunnerEmit,
    private readonly helpers: WorkspaceRunnerHelpers,
    private readonly deps: WorkspaceRunnerDeps,
  ) {
    for (const ws of store.list()) {
      if (ws.groupId) this.groupIndex.set(ws.groupId, ws.id);
    }
  }

  // ----------------------------------------------------
  // 参照
  // ----------------------------------------------------

  findByGroupId(groupId: string): Workspace | undefined {
    const id = this.groupIndex.get(groupId);
    return id ? this.store.get(id) : undefined;
  }

  // ----------------------------------------------------
  // 承認（§13.8.1）
  // ----------------------------------------------------

  approve(id: string, opts: { maxIterations?: number } = {}): Workspace {
    const ws = this.require(id);
    if (ws.status !== "review") {
      throw new WorkspaceError(
        "INVALID_STATE",
        `承認できるのは review の Workspace のみです（現在: ${ws.status}）`,
      );
    }
    const plan = ws.revisions[ws.revisions.length - 1];
    if (!plan) throw new WorkspaceError("INVALID_STATE", "承認する計画（revision）がありません");

    const { maxIterations } = opts;
    if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
      throw new WorkspaceError("INVALID_REQUEST", "maxIterations は 1 以上の整数にしてください");
    }

    const issues = validateWorkPlan(plan, this.helpers.validationContext());
    if (hasErrors(issues)) {
      const n = issues.filter((i) => i.level === "error" && i.autoFixed !== true).length;
      throw new WorkspaceError("VALIDATION_FAILED", `計画に検証エラーが ${n} 件あるため承認できません`, issues);
    }

    const role = this.requireOrchestrator();
    const approvedPlan: WorkPlan = structuredClone(plan);
    if (maxIterations !== undefined) approvedPlan.maxIterations = maxIterations;

    // Magentic グループ・台帳・設定・Orchestrator を用意する（失敗したら巻き戻す）
    let group;
    try {
      group = this.manager.createGroup(`Workspace ${id}: ${plan.title}`, "magentic");
    } catch (e) {
      throw new WorkspaceError("ORCHESTRATOR_UNAVAILABLE", `グループを作成できません: ${errorMessage(e)}`);
    }
    group.workspaceId = id;
    this.groupIndex.set(group.id, id);
    // group:created の時点では workspaceId が未設定のため、設定後に通知し直す
    this.manager.emit("group:updated", group);

    let agent: AgentState;
    try {
      this.manager.updateTaskLedger(group.id, toTaskLedgerInput(approvedPlan));
      const magenticConfig = this.buildMagenticConfig(
        { ...ws, groupId: group.id, approvedRevision: plan.revision, status: "running" },
        approvedPlan,
      );
      this.manager.setMagenticConfig(group.id, magenticConfig);
      agent = this.manager.startMagenticOrchestrator(group.id, role, magenticConfig.task, {
        workingDirectory: ws.workspacePath,
      });
    } catch (e) {
      this.groupIndex.delete(group.id);
      this.deleteGroupQuietly(group.id);
      throw new WorkspaceError("ORCHESTRATOR_UNAVAILABLE", `Orchestrator を起動できません: ${errorMessage(e)}`);
    }

    const updated = this.store.update(id, (w) => {
      w.status = "running";
      delete w.statusReason;
      w.approvedRevision = plan.revision;
      w.groupId = group.id;
      w.revisions[w.revisions.length - 1].maxIterations = approvedPlan.maxIterations;
      w.gateResults = approvedPlan.steps
        .filter((s) => s.kind === "gate")
        .map((g) => {
          const r = newGateResult(g.id, g.phaseId);
          r.status = deriveGateStatus(r, g);
          return r;
        });
    });

    this.watch(id, agent);
    this.failIfNotStarted(id, agent);
    return this.store.get(id) ?? updated;
  }

  // ----------------------------------------------------
  // ゲートの記録（MCP ツールから呼ばれる。§13.5.2）
  // ----------------------------------------------------

  /**
   * 合格済み（`passed`）のゲートには結果を記録できない。承認済み・合格済みの成果物を直すときは、
   * 修正フェーズを追加して出口を再チェック（人間レビュー済みなら再レビュー）する（§13.5.6）。
   */
  private rejectIfPassed(ws: Workspace, gateId: string): void {
    if (ws.gateResults.find((g) => g.gateId === gateId)?.status === "passed") {
      throw new WorkspaceError(
        "GATE_ALREADY_PASSED",
        `ゲート ${gateId} は合格済みです。合格済みの成果物の修正は、修正フェーズを追加して行い、その出口ゲートで再チェック（人間レビュー済みなら再レビュー）してください`,
      );
    }
  }

  /** `command` チェックをすべて実行して記録する（§2.2.12） */
  async runGateCheck(groupId: string, gateId: string): Promise<RunGateCheckResult> {
    const ws = this.locateRunning(groupId);
    const step = this.gateStep(groupId, gateId);
    this.rejectIfPassed(ws, gateId);

    const commands = (step.checks ?? []).flatMap((c, checkIndex) =>
      c.method === "command" ? [{ checkIndex, text: c.text, command: c.command ?? "" }] : [],
    );
    if (commands.length === 0) {
      throw new WorkspaceError("NO_COMMAND_CHECK", `ゲート ${gateId} には command チェックがありません`);
    }

    const wsConfig = getWorkspaceConfig(this.config);
    const policy = buildCommandPolicy(wsConfig);
    for (const c of commands) {
      const check = checkCommand(c.command, policy);
      if (!check.allowed) {
        throw new WorkspaceError(
          "COMMAND_DENIED",
          `ゲート ${gateId} の checks[${c.checkIndex}] の command は実行できません: ${check.reason}`,
        );
      }
    }

    const recorded: GateCheckResult[] = [];
    const out: RunGateCheckResult["results"] = [];
    // 中断（abort）・シャットダウンで実行中のコマンドを止める
    const controller = new AbortController();
    const aborts = this.stateOf(ws.id).gateAborts;
    aborts.add(controller);
    try {
      await this.runCommands(ws, commands, wsConfig, controller.signal, recorded, out);
    } finally {
      aborts.delete(controller);
    }

    // 実行中に中断された場合などは記録しない
    const latest = this.store.get(ws.id);
    if (controller.signal.aborted || !latest || latest.status !== "running") {
      throw new WorkspaceError("WORKSPACE_NOT_RUNNING", `Workspace ${ws.id} は実行中ではありません`);
    }

    const outcome = this.record(ws.id, groupId, step, recorded);
    return { groupId, ...outcome, results: out };
  }

  /** command を配列順にすべて実行する（中断されたら残りは実行しない） */
  private async runCommands(
    ws: Workspace,
    commands: { checkIndex: number; text: string; command: string }[],
    wsConfig: ReturnType<typeof getWorkspaceConfig>,
    signal: AbortSignal,
    recorded: GateCheckResult[],
    out: RunGateCheckResult["results"],
  ): Promise<void> {
    for (const c of commands) {
      if (signal.aborted) return;
      const r = await this.deps.gateRunner.run(c.command, {
        cwd: ws.workspacePath,
        timeout_ms: wsConfig.gateCommands.timeout_ms,
        maxOutput_bytes: wsConfig.gateCommands.maxOutput_bytes,
        signal,
      });
      const passed = r.exitCode === 0 && !r.timedOut;
      recorded.push({
        checkIndex: c.checkIndex,
        method: "command",
        passed,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        duration_ms: r.duration_ms,
        stdoutTail: r.stdoutTail,
        stderrTail: r.stderrTail,
        at: this.deps.now(),
      });
      out.push({
        checkIndex: c.checkIndex,
        text: c.text,
        command: c.command,
        passed,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        duration_ms: r.duration_ms,
        stdoutTail: r.stdoutTail,
        stderrTail: r.stderrTail,
      });
    }
  }

  /** `agent-review` チェックの結果を記録する（§2.2.13） */
  reportGateResult(
    groupId: string,
    gateId: string,
    checkIndex: number,
    passed: boolean,
    note?: string,
  ): ReportGateResultResult {
    const ws = this.locateRunning(groupId);
    const step = this.gateStep(groupId, gateId);
    this.rejectIfPassed(ws, gateId);

    const check = Number.isInteger(checkIndex) ? (step.checks ?? [])[checkIndex] : undefined;
    if (!check) {
      throw new WorkspaceError(
        "CHECK_NOT_FOUND",
        `ゲート ${gateId} に checkIndex ${checkIndex} のチェックはありません`,
      );
    }
    if (check.method !== "agent-review") {
      throw new WorkspaceError(
        "CHECK_METHOD_MISMATCH",
        `checkIndex ${checkIndex} の method は ${check.method} です。report_gate_result は agent-review のチェックにだけ使えます` +
          (check.method === "command"
            ? "（command は run_gate_check、human は人間レビューで記録されます）"
            : "（human は人間レビューでのみ決まります）"),
      );
    }

    const result: GateCheckResult = {
      checkIndex,
      method: "agent-review",
      passed,
      ...(note !== undefined ? { note } : {}),
      at: this.deps.now(),
    };
    const o = this.record(ws.id, groupId, step, [result]);
    return {
      registered: true,
      gateId,
      checkIndex,
      attempt: o.attempt,
      gateStatus: o.gateStatus,
      failedAttempts: o.failedAttempts,
      maxRetries: o.maxRetries,
      retryLimitExceeded: o.retryLimitExceeded,
      ...(o.instruction !== undefined ? { instruction: o.instruction } : {}),
    };
  }

  /** 人間レビューを依頼する（§2.2.14 / §13.6.2） */
  requestHumanReview(groupId: string, gateId: string, reviewDocPath: string): RequestHumanReviewResult {
    const ws = this.locateRunning(groupId);
    const step = this.gateStep(groupId, gateId);

    if (!hasHumanCheck(step)) {
      throw new WorkspaceError("NO_HUMAN_CHECK", `ゲート ${gateId} には human チェックがありません`);
    }
    const gate = ws.gateResults.find((g) => g.gateId === gateId);
    if (!gate || gate.status !== "auto_passed") {
      throw new WorkspaceError(
        "AUTO_CHECKS_NOT_PASSED",
        `ゲート ${gateId} の自動チェックがすべて合格していません（現在: ${gate?.status ?? "未登録"}）`,
      );
    }
    if (!SAFE_FILE_ID.test(gateId) || gateId.includes("..")) {
      throw new WorkspaceError(
        "REVIEW_DOC_INVALID",
        `ゲート ID にレビュー資料のファイル名に使えない文字が含まれています: ${gateId}`,
      );
    }

    // ReviewDoc の取得と検証
    const raw = this.loadReviewDoc(ws, groupId, reviewDocPath);
    const version = ws.humanReviews.filter((r) => r.gateId === gateId).length + 1;
    const parsed = parseReviewDoc(isRecord(raw) ? { ...raw, version } : raw);
    if (!parsed.ok) {
      throw new WorkspaceError("REVIEW_DOC_INVALID", `ReviewDoc が不正です: ${parsed.errors.join(" / ")}`);
    }

    // file 節の複製・HTML 生成・保存
    const reviewsDir = this.store.reviewsDir(ws.id);
    const filesDirName = reviewFilesDirName(gateId, version);
    const fileName = reviewFileName(gateId, version);
    let html: string;
    try {
      const doc = prepareReviewFiles(parsed.value, {
        workspacePath: ws.workspacePath,
        outDir: join(reviewsDir, filesDirName),
        publicBase: `./${filesDirName}`,
      });
      const hasMermaid = [doc.previousFeedback, ...doc.sections].some((s) => s?.kind === "mermaid");
      html = renderReviewDoc(doc, hasMermaid ? { mermaidRuntime: this.deps.mermaidRuntime() } : {});
      writeFileSync(join(reviewsDir, fileName), html, "utf-8");
    } catch (e) {
      throw new WorkspaceError("REVIEW_DOC_INVALID", `レビュー資料を生成できません: ${errorMessage(e)}`);
    }

    const docFile = `reviews/${fileName}`;
    const review: HumanReview = {
      gateId,
      version,
      status: "pending",
      docFile,
      comments: [],
      requestedAt: this.deps.now(),
    };
    this.store.update(ws.id, (w) => {
      w.humanReviews.push(review);
      const g = w.gateResults.find((x) => x.gateId === gateId);
      if (g) g.status = "waiting_human";
      w.status = "waiting_human";
      w.statusReason = {
        code: "human_review",
        gateId,
        message: `ゲート ${gateId} の人間レビュー待ちです（資料 v${version}）`,
      };
    });

    console.error(`[workspace] waiting_human: ${ws.id} ${gateId}`);
    this.emit("workspace:human_review_requested", { workspaceId: ws.id, review });

    return {
      registered: true,
      gateId,
      reviewVersion: version,
      reviewFile: docFile,
      status: "waiting_human",
      next: "report_result を status=success, summary=「人間レビュー待ちで一時停止」で呼んで終了してください",
    };
  }

  // ----------------------------------------------------
  // 人の操作
  // ----------------------------------------------------

  /**
   * 人間レビューの結果（承認 / 差し戻し）を記録し、Workspace を `running` にして **すぐ返す**。
   * 旧 Orchestrator の終了待ちと新 Orchestrator の起動は非同期で行う（完了は `workspace:resumed`、
   * 失敗は `failed`（`orchestrator_failed`））。
   */
  resolveHumanReview(
    id: string,
    gateId: string,
    input: {
      decision: "approve" | "request_changes";
      comment?: string;
      comments?: ReviewComment[];
    },
  ): Workspace {
    if (input.decision !== "approve" && input.decision !== "request_changes") {
      throw new WorkspaceError("INVALID_REQUEST", 'decision は "approve" か "request_changes" にしてください');
    }
    const ws = this.require(id);
    if (
      ws.status !== "waiting_human" ||
      ws.statusReason?.code !== "human_review" ||
      ws.statusReason.gateId !== gateId
    ) {
      throw new WorkspaceError(
        "INVALID_STATE",
        `ゲート ${gateId} は人間レビュー待ちではありません（現在: ${ws.status}${
          ws.statusReason?.gateId ? `, ${ws.statusReason.code}:${ws.statusReason.gateId}` : ""
        }）`,
      );
    }
    let reviewIndex = -1;
    ws.humanReviews.forEach((r, i) => {
      if (r.gateId === gateId && r.status === "pending") reviewIndex = i;
    });
    if (reviewIndex < 0) {
      throw new WorkspaceError("INVALID_STATE", `ゲート ${gateId} に保留中の人間レビューがありません`);
    }

    const now = this.deps.now();
    const approve = input.decision === "approve";
    const comments: ReviewComment[] = [];
    if (!approve) {
      for (const c of input.comments ?? []) {
        comments.push(c.sectionId !== undefined ? { sectionId: c.sectionId, text: c.text } : { text: c.text });
      }
      if (input.comment !== undefined && input.comment.trim() !== "") comments.push({ text: input.comment });
    }

    const gateStep = this.ledgerGateStep(ws.groupId, gateId);
    let resolved!: HumanReview;
    this.store.update(id, (w) => {
      const r = w.humanReviews[reviewIndex];
      r.status = approve ? "approved" : "changes_requested";
      r.resolvedAt = now;
      if (!approve) r.comments = comments;
      resolved = structuredClone(r);
      const g = w.gateResults.find((x) => x.gateId === gateId);
      if (g) {
        // 差し戻し後は自動チェックをやり直す（human のみのゲートはやり直す自動チェックがない）
        g.status = approve
          ? "passed"
          : gateStep && autoChecksOf(gateStep).length === 0
            ? "auto_passed"
            : "pending";
      }
      w.status = "running";
      delete w.statusReason;
    });

    this.setGateStepStatus(ws.groupId, gateId, approve ? "completed" : "in_progress");
    this.emit("workspace:human_review_resolved", { workspaceId: id, review: resolved });

    this.startResume(
      id,
      approve ? { kind: "approved", gateId } : { kind: "changes_requested", gateId, comments },
    );
    return this.require(id);
  }

  /** 差し戻し上限超過後の再試行（人の指示を付けて `running` にし、すぐ返す。再開は非同期。§13.8.5） */
  retry(id: string, input: { instruction?: string }): Workspace {
    const ws = this.require(id);
    if (ws.status !== "waiting_human" || ws.statusReason?.code !== "gate_retry_exceeded") {
      throw new WorkspaceError(
        "INVALID_STATE",
        `再試行できるのは差し戻し上限超過で停止している Workspace のみです（現在: ${ws.status}${
          ws.statusReason ? `, ${ws.statusReason.code}` : ""
        }）`,
      );
    }
    const gateId = ws.statusReason.gateId ?? "";
    const now = this.deps.now();
    const text = input.instruction ?? "";

    this.store.update(id, (w) => {
      const g = w.gateResults.find((x) => x.gateId === gateId);
      if (g) {
        const last = g.attempts[g.attempts.length - 1];
        if (last && last.closedAt === undefined) last.closedAt = now;
        g.retryInstructions.push({ text, at: now, afterAttempt: last?.attempt ?? 0 });
        g.status = "pending";
      }
      w.status = "running";
      delete w.statusReason;
    });

    this.startResume(id, { kind: "retry", gateId, instruction: input.instruction });
    return this.require(id);
  }

  /** イレギュラー（ゲート変更）を確認済みにする */
  ackIrregular(id: string, gateChangeId: string): Workspace {
    const ws = this.require(id);
    if (!ws.gateChanges.some((c) => c.id === gateChangeId)) {
      throw new WorkspaceError("NOT_FOUND", `イレギュラーが見つかりません: ${gateChangeId}`);
    }
    const now = this.deps.now();
    return this.store.update(id, (w) => {
      const c = w.gateChanges.find((x) => x.id === gateChangeId);
      if (c && c.acknowledgedAt === undefined) c.acknowledgedAt = now;
    });
  }

  /** 実行中（running / waiting_human）の中断: Orchestrator とグループ配下の Agent を停止する */
  abortRun(id: string): Workspace {
    const ws = this.require(id);
    this.unwatch(id);
    const updated = this.store.update(id, (w) => {
      w.status = "aborted";
      w.statusReason = { code: "user_abort", message: "ユーザーが中断しました" };
    });
    // 実行中のゲートの command も止める
    for (const c of this.runs.get(id)?.gateAborts ?? []) c.abort();
    if (ws.groupId) {
      // 完了を報告済みでもプロセスが残っていることがあるため、全 Agent に停止を試みる
      // （killAgent はプロセスが無ければ何もしない）
      for (const agent of this.agentsOfRun(ws.groupId)) this.manager.killAgent(agent.agentId);
    }
    return updated;
  }

  /** サーバーの終了時: 実行中のゲートの command をすべて中断する */
  shutdown(): void {
    for (const state of this.runs.values()) {
      for (const c of state.gateAborts) c.abort();
    }
    const runner = this.deps.gateRunner as GateCommandRunner & { killAll?: () => void };
    runner.killAll?.();
  }

  // ----------------------------------------------------
  // update_ledger との連携（§13.5.5）
  // ----------------------------------------------------

  applyLedgerUpdate(
    groupId: string,
    args: LedgerUpdateInput,
  ): { phases: Phase[]; scheduledSteps: ScheduledStep[] } {
    const ws = this.locate(groupId);
    if (ws.status !== "running" && ws.status !== "waiting_human") {
      throw new WorkspaceError("WORKSPACE_NOT_RUNNING", `Workspace ${ws.id} は実行中ではありません`);
    }
    const plan = this.approvedPlan(ws);
    const ledger = this.manager.getLedger(groupId)?.taskLedger;
    const currentSteps = ledger?.scheduledSteps ?? [];

    const result = guardLedgerUpdate({
      current: { phases: ledger?.phases ?? plan.phases, scheduledSteps: currentSteps },
      incoming: { phases: args.phases, scheduledSteps: args.scheduledSteps ?? currentSteps },
      approvedPlan: plan,
      gateResults: ws.gateResults,
      irregular: args.irregular,
      reason: args.reason,
      commandPolicy: buildCommandPolicy(getWorkspaceConfig(this.config)),
    });
    if (!result.ok) throw new WorkspaceError(result.code, result.message);

    const at = this.deps.now();
    let n = nextGateChangeNumber(ws);
    const changes = result.gateChanges.map((c) => ({ ...c, id: `gc-${n++}`, at }));
    const newGates = result.scheduledSteps.filter(
      (s) => s.kind === "gate" && !ws.gateResults.some((g) => g.gateId === s.stepId),
    );

    // checks が変わったゲートは、記録済みの結果を新しい checkIndex に付け替えて GateResult.status を再導出する
    // （passed を維持しない。attempt の履歴は残す）。人間レビュー待ち（waiting_human）の status はそのまま
    const rederived = new Map<string, GateResult>();
    for (const c of changes) {
      if (!c.after) continue;
      const g = ws.gateResults.find((x) => x.gateId === c.gateId);
      const step = result.scheduledSteps.find((s) => s.stepId === c.gateId);
      if (!g || !step) continue;
      const remapped = remapGateChecks(g, c.before.checks ?? [], c.after.checks ?? []);
      if (g.status !== "waiting_human") remapped.status = deriveGateStatus(remapped, step);
      rederived.set(c.gateId, remapped);
    }

    if (changes.length > 0 || newGates.length > 0) {
      this.store.update(ws.id, (w) => {
        w.gateChanges.push(...changes);
        for (const g of newGates) {
          const r = newGateResult(g.stepId, g.phaseId ?? "");
          r.status = deriveGateStatus(r, g);
          w.gateResults.push(r);
        }
        for (const [gateId, remapped] of rederived) {
          const i = w.gateResults.findIndex((x) => x.gateId === gateId);
          if (i >= 0) w.gateResults[i] = remapped;
        }
      });
    }
    // 台帳のゲートの状態も合わせる（合格 → completed、合格でなくなったら completed を in_progress に戻す）
    const scheduledSteps = result.scheduledSteps.map((s) => {
      const status = rederived.get(s.stepId)?.status;
      if (status === undefined || status === "waiting_human") return s;
      if (status === "passed") return { ...s, status: "completed" as const };
      return s.status === "completed" ? { ...s, status: "in_progress" as const } : s;
    });

    for (const change of changes) this.emit("workspace:irregular", { workspaceId: ws.id, change });
    for (const p of result.phasePlanned) {
      this.emit("workspace:phase_planned", { workspaceId: ws.id, phaseId: p.phaseId, addedSteps: p.addedSteps });
    }
    const r = result.replanned;
    if (r.added.length > 0 || r.changed.length > 0 || r.removed.length > 0) {
      this.emit("workspace:replanned", { workspaceId: ws.id, added: r.added, changed: r.changed, removed: r.removed });
    }

    return { phases: result.phases, scheduledSteps };
  }

  // ----------------------------------------------------
  // 再開（§13.8.4〜13.8.6）
  // ----------------------------------------------------

  /**
   * 旧 Orchestrator の終了を確認（最大 `resumeWait_ms`、超過時は停止）し、
   * 再開プロンプトで新しい Orchestrator を同じ Magentic グループに起動する。
   * 呼び出し時点で Workspace は `running` になっている。失敗したら `failed` にする。
   */
  private startResume(id: string, reason: ResumeReason): void {
    this.resume(id, reason).catch((e) => {
      console.error(`[workspace] 再開の処理に失敗しました (${id}): ${errorMessage(e)}`);
    });
  }

  private async resume(id: string, reason: ResumeReason): Promise<void> {
    // 旧 Orchestrator の完了イベントは処理しない（再開の一部として扱う）
    this.unwatch(id);
    try {
      const ws0 = this.require(id);
      const groupId = ws0.groupId;
      const group = groupId ? this.manager.getGroup(groupId) : undefined;
      if (!groupId || !group) throw new Error("Magentic グループが見つかりません");

      const oldId = group.orchestratorAgentId;
      if (oldId && this.manager.getAgent(oldId)) {
        await this.manager.waitForAgents([oldId], "all", this.deps.resumeWait_ms);
        // 終了していなければ停止する。完了を報告済みでもプロセスが残っていれば止める
        this.manager.killAgent(oldId);
      }

      // 待っている間に中断された場合は何もしない
      const ws = this.store.get(id);
      if (!ws || ws.status !== "running") return;

      const plan = this.approvedPlan(ws);
      const role = this.requireOrchestrator();
      const magentic = this.manager.getMagenticConfig(groupId);
      if (!magentic) throw new Error("Magentic 設定が見つかりません");

      const injection = buildWorkspaceInjectionBlock({
        workspace: ws,
        plan,
        gateCommandNote: this.gateCommandNote(),
      });
      const resumePrompt = buildResumePrompt({
        workspace: ws,
        plan,
        ledger: this.manager.getLedger(groupId),
        agentSummaries: this.agentSummaries(groupId),
        reason,
      });
      this.manager.setMagenticConfig(groupId, {
        ...magentic,
        currentIteration: this.iterationsOf(groupId),
        promptAppendix: `${injection}\n${resumePrompt}`,
      });

      const agent = this.manager.startMagenticOrchestrator(groupId, role, magentic.task, {
        workingDirectory: ws.workspacePath,
      });
      this.watch(id, agent);
      this.emit("workspace:resumed", {
        workspaceId: id,
        reason: reason.kind,
        orchestratorAgentId: agent.agentId,
      });
      this.failIfNotStarted(id, agent);
    } catch (e) {
      this.markFailed(id, "orchestrator_failed", `Orchestrator を再開できませんでした: ${errorMessage(e)}`);
    }
  }

  // ----------------------------------------------------
  // Orchestrator の完了（§13.8.8）
  // ----------------------------------------------------

  private watch(id: string, agent: AgentState): void {
    this.unwatch(id);
    this.watched.set(agent.agentId, id);
    this.stateOf(id).watchedAgentId = agent.agentId;
    if (!this.completedListener) {
      this.completedListener = (completed: AgentState): void => {
        const workspaceId = this.watched.get(completed.agentId);
        if (workspaceId !== undefined) this.onOrchestratorCompleted(workspaceId, completed);
      };
      this.manager.on("agent:completed", this.completedListener);
    }
  }

  private unwatch(id: string): void {
    const state = this.runs.get(id);
    if (state?.watchedAgentId !== undefined) {
      this.watched.delete(state.watchedAgentId);
      state.watchedAgentId = undefined;
    }
    if (this.watched.size === 0 && this.completedListener) {
      this.manager.off("agent:completed", this.completedListener);
      this.completedListener = undefined;
    }
  }

  /** プロセスの起動に失敗した場合、manager は完了イベントを出さずに failed にする */
  private failIfNotStarted(id: string, agent: AgentState): void {
    if (agent.status === "failed" && agent.result === null) {
      this.onOrchestratorCompleted(id, agent);
    }
  }

  /**
   * `agent:completed` のリスナーから呼ばれるため、例外は外に出さず
   * （report_result の呼び出し側を壊さない）、失敗として確定する。
   */
  private onOrchestratorCompleted(id: string, agent: AgentState): void {
    this.unwatch(id);
    try {
      this.decideEnd(id, agent);
    } catch (e) {
      console.error(`[workspace] Orchestrator 完了の処理に失敗しました (${id}): ${errorMessage(e)}`);
      try {
        this.markFailed(id, "orchestrator_failed", `完了の処理に失敗しました: ${errorMessage(e)}`);
      } catch {
        // 保存に失敗した場合はこれ以上できない
      }
    }
  }

  private decideEnd(id: string, agent: AgentState): void {
    const ws = this.store.get(id);
    // 保留中の人間判断（waiting_human）、中断済みなどは何もしない
    if (!ws || ws.status !== "running") return;

    const plan = this.approvedPlan(ws);
    const groupId = ws.groupId ?? agent.groupId;
    const result = agent.result;
    const finalId = finalGate(plan)?.id;
    const finalPassed = ws.gateResults.find((g) => g.gateId === finalId)?.status === "passed";

    if (result?.status === "success" && finalPassed) {
      // レポートの生成に失敗しても、最終ゲートは合格しているので done にする（report は省略）
      let report: WorkspaceReport | undefined;
      try {
        report = buildWorkspaceReport({
          workspace: ws,
          plan,
          ledger: this.manager.getLedger(groupId),
          agents: this.agentsOfRun(groupId),
          finalResponse: result.response,
          now: this.deps.now(),
        });
      } catch (e) {
        console.error(`[workspace] 完了レポートを生成できませんでした (${id}): ${errorMessage(e)}`);
      }
      this.store.update(id, (w) => {
        w.status = "done";
        delete w.statusReason;
        if (report) w.report = report;
      });
      return;
    }

    if (this.iterationsOf(groupId) >= plan.maxIterations) {
      this.markFailed(id, "max_iterations", `反復が maxIterations（${plan.maxIterations}）に達しました`);
      return;
    }

    let message: string;
    if (!result) {
      message = "Orchestrator が結果を報告せずに終了しました";
    } else if (result.status !== "success") {
      message = `Orchestrator が ${result.status} で終了しました: ${result.errorMessage ?? result.summary}`;
    } else {
      message = `最終ゲート（${finalId ?? "なし"}）が合格しないまま Orchestrator が終了しました`;
    }
    this.markFailed(id, "orchestrator_failed", message);
  }

  private markFailed(
    id: string,
    code: "orchestrator_failed" | "max_iterations",
    message: string,
  ): void {
    this.store.update(id, (w) => {
      w.status = "failed";
      w.statusReason = { code, message };
    });
  }

  /** 通算の反復回数（Progress Ledger の履歴 + 現在、反復番号、MagenticConfig の値の最大） */
  private iterationsOf(groupId: string): number {
    const ledger = this.manager.getLedger(groupId);
    const counted = (ledger?.progressHistory.length ?? 0) + (ledger?.progressLedger ? 1 : 0);
    return Math.max(
      counted,
      ledger?.progressLedger?.iteration ?? 0,
      this.manager.getMagenticConfig(groupId)?.currentIteration ?? 0,
    );
  }

  // ----------------------------------------------------
  // ゲートの記録（共通）
  // ----------------------------------------------------

  /** 結果を記録し、状態・Ledger・イベントを更新する */
  private record(
    id: string,
    groupId: string,
    step: ScheduledStep,
    results: GateCheckResult[],
  ): GateCheckOutcome {
    const gateId = step.stepId;
    const maxRetries = step.onFail?.maxRetries ?? DEFAULT_MAX_RETRIES;
    let next!: GateResult;
    let exceeded = false;

    this.store.update(id, (w) => {
      let index = w.gateResults.findIndex((g) => g.gateId === gateId);
      if (index < 0) {
        w.gateResults.push(newGateResult(gateId, step.phaseId ?? ""));
        index = w.gateResults.length - 1;
      }
      let g = w.gateResults[index];
      for (const r of results) g = recordCheckResult(g, step, r);
      w.gateResults[index] = g;
      next = structuredClone(g);

      exceeded = g.status === "failed" && isRetryLimitExceeded(g, maxRetries);
      if (exceeded) {
        w.status = "waiting_human";
        w.statusReason = {
          code: "gate_retry_exceeded",
          gateId,
          message: `ゲート ${gateId} の不合格が続き、差し戻し上限（${maxRetries} 回）を超えました`,
        };
      }
    });

    this.syncGateStep(groupId, gateId, next.status);
    this.emit("workspace:gate_result", { workspaceId: id, gateResult: next });
    if (exceeded) {
      console.error(`[workspace] waiting_human: ${id} ${gateId} (gate_retry_exceeded)`);
      this.emit("workspace:gate_retry_exceeded", { workspaceId: id, gateId });
    }

    const last = next.attempts[next.attempts.length - 1];
    const have = new Set((last?.checks ?? []).map((c) => c.checkIndex));
    const pendingChecks: GateCheckOutcome["pendingChecks"] = [
      ...autoChecksOf(step).filter((a) => !have.has(a.checkIndex)),
      ...(next.status === "passed"
        ? []
        : (step.checks ?? []).flatMap((c, checkIndex) =>
            c.method === "human" ? [{ checkIndex, method: "human" as const }] : [],
          )),
    ].sort((a, b) => a.checkIndex - b.checkIndex);

    return {
      gateId,
      attempt: last?.attempt ?? 0,
      gateStatus: next.status,
      failedAttempts: failedAttemptsSinceRetry(next),
      maxRetries,
      retryLimitExceeded: exceeded,
      pendingChecks,
      ...(exceeded ? { instruction: RETRY_LIMIT_INSTRUCTION } : {}),
    };
  }

  // ----------------------------------------------------
  // Task Ledger の操作
  // ----------------------------------------------------

  private ledgerGateStep(groupId: string | undefined, gateId: string): ScheduledStep | undefined {
    if (!groupId) return undefined;
    const matches = (this.manager.getLedger(groupId)?.taskLedger?.scheduledSteps ?? []).filter(
      (s) => s.stepId === gateId,
    );
    // 重複があれば、最初のものを採って検証をすり抜けさせず、エラーにする
    if (matches.length > 1) {
      throw new WorkspaceError(
        "DUPLICATE_STEP_ID",
        `台帳に stepId ${gateId} の Step が ${matches.length} 件あります。重複を解消してください`,
      );
    }
    return matches.find((s) => s.kind === "gate");
  }

  /** ゲートの Step を現在の Task Ledger から引く */
  private gateStep(groupId: string, gateId: string): ScheduledStep {
    const step = this.ledgerGateStep(groupId, gateId);
    if (!step) {
      throw new WorkspaceError("GATE_NOT_FOUND", `ゲートが見つかりません: ${gateId}（kind: "gate" の stepId を指定してください）`);
    }
    return step;
  }

  /** ゲートの Ledger 上の状態をサーバーが更新する（合格 → completed。completed だったものが戻る → in_progress） */
  private syncGateStep(groupId: string, gateId: string, status: GateResult["status"]): void {
    const cur = this.ledgerGateStep(groupId, gateId);
    if (!cur) return;
    if (status === "passed") this.setGateStepStatus(groupId, gateId, "completed");
    else if (cur.status === "completed") this.setGateStepStatus(groupId, gateId, "in_progress");
  }

  private setGateStepStatus(
    groupId: string | undefined,
    gateId: string,
    status: ScheduledStep["status"],
  ): void {
    if (!groupId) return;
    const ledger = this.manager.getLedger(groupId)?.taskLedger;
    const steps = ledger?.scheduledSteps;
    if (!ledger || !steps) return;
    const matches = steps.filter((s) => s.stepId === gateId);
    if (matches.length > 1) {
      throw new WorkspaceError(
        "DUPLICATE_STEP_ID",
        `台帳に stepId ${gateId} の Step が ${matches.length} 件あります。重複を解消してください`,
      );
    }
    const cur = matches[0];
    if (!cur || cur.status === status) return;
    this.manager.updateTaskLedger(groupId, {
      facts: ledger.facts,
      plan: ledger.plan,
      scheduledSteps: steps.map((s) => (s.stepId === gateId ? { ...s, status } : s)),
      ...(ledger.phases ? { phases: ledger.phases } : {}),
    });
  }

  // ----------------------------------------------------
  // MagenticConfig（§13.8.1）
  // ----------------------------------------------------

  private buildMagenticConfig(ws: Workspace, plan: WorkPlan): MagenticConfig {
    const spec = plan.spec;
    const factLines = (label: string, items: string[]): string[] =>
      items.length > 0 ? [`${label}:`, bullets(items)] : [];
    const context = [
      `Workspace ID: ${ws.id}`,
      ...factLines("前提（AI が置いたもの）", spec.assumptions),
      ...factLines("与えられた事実", plan.facts.given),
      ...factLines("調査が必要な事項", plan.facts.toInvestigate),
      ...factLines("導出すべき事項", plan.facts.toDerive),
      ...factLines("推測・仮定", plan.facts.assumptions),
    ].join("\n");

    return {
      task: `${ws.instruction}\n\n目的: ${plan.goal}`,
      completionCriteria: bullets(spec.completion),
      scope: [`作業ディレクトリ: ${ws.workspacePath}`, ...(spec.scope.length > 0 ? [bullets(spec.scope)] : [])].join("\n"),
      ...(spec.constraints.length > 0 ? { constraints: bullets(spec.constraints) } : {}),
      context,
      availableRoles: this.helpers.availableRoles().map((r) => r.id),
      maxIterations: plan.maxIterations,
      currentIteration: 0,
      promptAppendix: buildWorkspaceInjectionBlock({
        workspace: ws,
        plan,
        gateCommandNote: this.gateCommandNote(),
      }),
    };
  }

  /** command チェックの実行に関する補足（禁止パターン・許可リスト・タイムアウト） */
  private gateCommandNote(): string {
    const gc = getWorkspaceConfig(this.config).gateCommands;
    const parts = [
      "sudo / git push / git reset --hard / ルート削除 / curl|sh などの禁止パターンに当たる command は実行されません（COMMAND_DENIED）",
    ];
    if (gc.deny.length > 0) parts.push(`追加の禁止パターン: ${gc.deny.join(", ")}`);
    if (gc.allow.length > 0) parts.push(`許可リスト（前方一致）にある command のみ実行できます: ${gc.allow.join(", ")}`);
    parts.push(`1 command のタイムアウトは ${Math.round(gc.timeout_ms / 1000)} 秒`);
    return parts.join("。") + "。";
  }

  // ----------------------------------------------------
  // ReviewDoc の取得
  // ----------------------------------------------------

  /** `agent:<agentId>` または作業ディレクトリ内の JSON ファイルから ReviewDoc（未検証）を読む */
  private loadReviewDoc(ws: Workspace, groupId: string, path: string): unknown {
    let text: string;
    if (path.startsWith("agent:")) {
      const agentId = path.slice("agent:".length);
      const agent = this.manager.getAgent(agentId);
      const inRun =
        agent !== undefined &&
        (agent.groupId === groupId || this.manager.getGroup(agent.groupId)?.parentGroupId === groupId);
      const response = inRun && agent.result?.status === "success" ? agent.result.response : undefined;
      if (!response) {
        throw new WorkspaceError(
          "REVIEW_DOC_NOT_FOUND",
          `Agent ${agentId} の report_result の response が見つかりません（この Workspace の Agent が status: success で結果を報告している必要があります）`,
        );
      }
      text = response;
    } else {
      text = this.readWorkspaceFile(ws.workspacePath, path);
    }

    const json = extractJson(text);
    if (json === undefined) {
      throw new WorkspaceError("REVIEW_DOC_INVALID", "ReviewDoc の JSON を取り出せません（JSON のみを出力してください）");
    }
    return json;
  }

  /** 作業ディレクトリ内（実パスで判定）の通常ファイルを読む。外・不在は REVIEW_DOC_NOT_FOUND */
  private readWorkspaceFile(workspacePath: string, path: string): string {
    const notFound = (): WorkspaceError =>
      new WorkspaceError("REVIEW_DOC_NOT_FOUND", `作業ディレクトリ内に ReviewDoc のファイルが見つかりません: ${path}`);
    let root: string;
    let real: string;
    try {
      root = realpathSync(workspacePath);
      real = realpathSync(resolve(root, path));
    } catch {
      throw notFound();
    }
    const rel = relative(root, real);
    if (rel === "" || rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) throw notFound();
    const st = statSync(real);
    if (!st.isFile()) throw notFound();
    if (st.size > REVIEW_FILE_MAX_BYTES) {
      throw new WorkspaceError("REVIEW_DOC_INVALID", `ReviewDoc のファイルが大きすぎます（上限 5 MiB）: ${path}`);
    }
    return readFileSync(real, "utf-8");
  }

  // ----------------------------------------------------
  // Agent の集計
  // ----------------------------------------------------

  /** Magentic グループと、その子グループの Agent */
  private agentsOfRun(groupId: string): AgentState[] {
    const ids = new Set<string>([groupId]);
    for (const g of this.manager.listGroups()) {
      if (g.parentGroupId === groupId) ids.add(g.id);
    }
    return [...ids].flatMap((gid) => this.manager.getAgentsByGroup(gid));
  }

  /** 完了したサブ Agent の結果の要約（Orchestrator 自身は除く） */
  private agentSummaries(groupId: string) {
    return this.agentsOfRun(groupId)
      .filter((a) => a.result !== null && a.role !== "orchestrator")
      .map((a) => ({
        agentId: a.agentId,
        role: a.role,
        summary: a.result?.summary ?? "",
        editedFiles: [...(a.result?.editedFiles ?? a.editedFiles)],
        createdFiles: [...(a.result?.createdFiles ?? a.createdFiles)],
      }));
  }

  // ----------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------

  private stateOf(id: string): RunState {
    let s = this.runs.get(id);
    if (!s) {
      s = { gateAborts: new Set() };
      this.runs.set(id, s);
    }
    return s;
  }

  private require(id: string): Workspace {
    const ws = this.store.get(id);
    if (!ws) throw new WorkspaceError("NOT_FOUND", `Workspace が見つかりません: ${id}`);
    return ws;
  }

  /** groupId から Workspace を引く。無ければ NOT_WORKSPACE_GROUP */
  private locate(groupId: string): Workspace {
    const ws = this.findByGroupId(groupId);
    if (!ws) {
      throw new WorkspaceError(
        "NOT_WORKSPACE_GROUP",
        `グループ ${groupId} は Workspace に紐付いていません`,
      );
    }
    return ws;
  }

  private locateRunning(groupId: string): Workspace {
    const ws = this.locate(groupId);
    if (ws.status !== "running") {
      throw new WorkspaceError(
        "WORKSPACE_NOT_RUNNING",
        `Workspace ${ws.id} は実行中ではありません（現在: ${ws.status}）`,
      );
    }
    return ws;
  }

  private approvedPlan(ws: Workspace): WorkPlan {
    const plan =
      ws.revisions.find((r) => r.revision === ws.approvedRevision) ??
      ws.revisions[ws.revisions.length - 1];
    if (!plan) throw new WorkspaceError("INVALID_STATE", `Workspace ${ws.id} に承認済みの計画がありません`);
    return plan;
  }

  /** orchestrator 職種があり、ヘルスチェックで利用不可と判定されていないこと */
  private requireOrchestrator(): RoleDefinition {
    const role = this.config.roles.find((r) => r.id === "orchestrator");
    if (!role) {
      throw new WorkspaceError("ORCHESTRATOR_UNAVAILABLE", "orchestrator 職種が定義されていません");
    }
    const health = this.manager.getHealthCheckResult("orchestrator");
    if (health && !health.available) {
      throw new WorkspaceError(
        "ORCHESTRATOR_UNAVAILABLE",
        "orchestrator 職種がヘルスチェックを通過していません",
      );
    }
    return role;
  }

  private deleteGroupQuietly(groupId: string): void {
    try {
      if (this.manager.getGroup(groupId)?.status === "active") this.manager.deleteGroup(groupId);
    } catch {
      // 巻き戻しの失敗は無視する
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 次の GateChange 番号（既存の `gc-<n>` の最大 + 1） */
function nextGateChangeNumber(ws: Workspace): number {
  let max = 0;
  for (const c of ws.gateChanges) {
    const m = /^gc-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
