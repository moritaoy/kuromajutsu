// ============================================================
// Workspace サービス（docs/spec.md §13.2 / §13.7）
//
// 計画生成（Planner Agent の起動・出力の検証・1 回リトライ）、再計画、中断を担う。
// 承認以降の実行（running / waiting_human）は `WorkspaceRunner`（run.ts）に委譲する。
// ============================================================

import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentManager } from "../agent/manager.js";
import type {
  AgentState,
  AppConfig,
  Phase,
  PlanTarget,
  ReviewComment,
  RoleDefinition,
  ScheduledStep,
  ValidationIssue,
  WorkPlan,
  Workspace,
} from "../types/index.js";
import { WorkspaceError, type WorkspaceErrorCode } from "./errors.js";
import { buildCommandPolicy, getWorkspaceConfig } from "./gate-commands.js";
import { ShellGateCommandRunner } from "./gate-runner.js";
import { computeMaxIterations } from "./plan.js";
import { buildPlannerPrompt, extractPlannerOutput } from "./planner.js";
import { loadMermaidRuntime } from "./review-doc.js";
import {
  WorkspaceRunner,
  type LedgerUpdateInput,
  type ReportGateResultResult,
  type RequestHumanReviewResult,
  type RunGateCheckResult,
  type WorkspaceRunnerDeps,
} from "./run.js";
import type { WorkPlanInput } from "./schema.js";
import type { WorkspaceStore } from "./store.js";
import { autoFixWorkPlan, validateWorkPlan, type ValidationContext } from "./validator.js";

// --------------------------------------------------
// エラー
// --------------------------------------------------

export { WorkspaceError, type WorkspaceErrorCode };

// --------------------------------------------------
// 内部型
// --------------------------------------------------

/** 計画の手順に使えない職種（Workspace が内部で自動起動する専用ロール） */
const RESERVED_ROLE_IDS = new Set(["orchestrator", "planner"]);

/** 指示の最大文字数 */
const MAX_INSTRUCTION_LENGTH = 100_000;

/** 計画生成の最大試行回数（初回 + 自動リトライ 1 回。§13.7） */
const MAX_PLAN_ATTEMPTS = 2;

interface PlanningJob {
  workspaceId: string;
  groupId: string;
  /** 生成する revision の番号 */
  revision: number;
  attempt: number;
  previousPlan?: WorkPlan;
  additionalInstruction?: string;
  targets?: PlanTarget[];
  agentId?: string;
  /** abort 済み。以後の完了イベントは無視する */
  cancelled: boolean;
}

// --------------------------------------------------
// WorkspaceService
// --------------------------------------------------

export class WorkspaceService extends EventEmitter {
  /** 計画生成中のジョブ: workspaceId → job */
  private readonly jobs = new Map<string, PlanningJob>();
  /** Planner の完了待ち: agentId → job（共有リスナー 1 本で受ける） */
  private readonly watchedPlanners = new Map<string, PlanningJob>();
  private plannerListener?: (agent: AgentState) => void;

  /** 承認以降の実行系（§13.8） */
  private readonly runner: WorkspaceRunner;

  /**
   * @param deps テスト用の差し替え（既定: `ShellGateCommandRunner` / 同梱の mermaid / 現在時刻 / 再開時の待ち 30 秒）
   */
  constructor(
    private readonly config: AppConfig,
    private readonly manager: AgentManager,
    private readonly store: WorkspaceStore,
    deps: Partial<WorkspaceRunnerDeps> = {},
  ) {
    super();
    store.on("workspace:created", (ws: Workspace) => this.emit("workspace:created", ws));
    store.on("workspace:updated", (ws: Workspace) => this.emit("workspace:updated", ws));
    this.runner = new WorkspaceRunner(
      config,
      manager,
      store,
      (event, data) => this.emit(event, data),
      {
        validationContext: () => this.validationContext(),
        availableRoles: () => this.availableRoleDefinitions(),
      },
      {
        gateRunner: deps.gateRunner ?? new ShellGateCommandRunner(),
        mermaidRuntime: deps.mermaidRuntime ?? loadMermaidRuntime,
        now: deps.now ?? (() => new Date().toISOString()),
        resumeWait_ms: deps.resumeWait_ms ?? 30_000,
      },
    );
  }

  // ----------------------------------------------------
  // 参照
  // ----------------------------------------------------

  list(): Workspace[] {
    return this.store.list();
  }

  get(id: string): Workspace | undefined {
    return this.store.get(id);
  }

  /** Magentic 親グループの ID から Workspace を引く（Workspace に紐付かないグループは undefined） */
  findByGroupId(groupId: string): Workspace | undefined {
    return this.runner.findByGroupId(groupId);
  }

  /** 最新 revision の検証結果。revision が無ければ [] */
  getValidation(id: string): ValidationIssue[] {
    const ws = this.require(id);
    const plan = ws.revisions[ws.revisions.length - 1];
    if (!plan) return [];
    return validateWorkPlan(plan, this.validationContext());
  }

  // ----------------------------------------------------
  // 操作
  // ----------------------------------------------------

  create(input: { instruction: string; workspacePath?: string }): Workspace {
    const instruction = this.requireInstruction(input.instruction);
    const workspacePath = this.resolveWorkspacePath(input.workspacePath);
    this.requirePlanner();

    const ws = this.store.create({ instruction, workspacePath });
    this.startPlanning(ws, {});
    return this.store.get(ws.id) ?? ws;
  }

  replan(id: string, input: { instruction: string; targets?: PlanTarget[] }): Workspace {
    const ws = this.require(id);
    const additional = this.requireInstruction(input.instruction);
    if (ws.status !== "review") {
      throw new WorkspaceError(
        "INVALID_STATE",
        `再計画できるのは review の Workspace のみです（現在: ${ws.status}）`,
      );
    }
    this.requirePlanner();
    const previousPlan = ws.revisions[ws.revisions.length - 1];
    if (!previousPlan) {
      throw new WorkspaceError("INVALID_STATE", "再計画の元になる計画（revision）がありません");
    }

    this.store.update(id, (w) => {
      w.status = "planning";
      delete w.statusReason;
    });
    this.startPlanning(this.require(id), {
      previousPlan,
      additionalInstruction: additional,
      targets: input.targets,
    });
    return this.require(id);
  }

  // ----------------------------------------------------
  // 承認・実行（§13.8。WorkspaceRunner に委譲）
  // ----------------------------------------------------

  /** 承認して Magentic 実行を開始する（検証エラーがあれば VALIDATION_FAILED） */
  approve(id: string, opts: { maxIterations?: number } = {}): Workspace {
    return this.runner.approve(id, opts);
  }

  /** ゲートの `command` チェックをすべて実行して記録する（MCP `run_gate_check`） */
  runGateCheck(groupId: string, gateId: string): Promise<RunGateCheckResult> {
    return this.runner.runGateCheck(groupId, gateId);
  }

  /** ゲートの `agent-review` チェックの結果を記録する（MCP `report_gate_result`） */
  reportGateResult(
    groupId: string,
    gateId: string,
    checkIndex: number,
    passed: boolean,
    note?: string,
  ): ReportGateResultResult {
    return this.runner.reportGateResult(groupId, gateId, checkIndex, passed, note);
  }

  /** 人間レビューを依頼する（MCP `request_human_review`） */
  requestHumanReview(groupId: string, gateId: string, reviewDocPath: string): RequestHumanReviewResult {
    return this.runner.requestHumanReview(groupId, gateId, reviewDocPath);
  }

  /** 人間レビューの結果（承認 / 差し戻し）を記録し、すぐ返す（Orchestrator の再開は非同期。`workspace:resumed`） */
  resolveHumanReview(
    id: string,
    gateId: string,
    input: { decision: "approve" | "request_changes"; comment?: string; comments?: ReviewComment[] },
  ): Workspace {
    return this.runner.resolveHumanReview(id, gateId, input);
  }

  /** 差し戻し上限超過後に、指示を付けて再試行する（すぐ返す。再開は非同期） */
  retry(id: string, input: { instruction?: string } = {}): Workspace {
    return this.runner.retry(id, input);
  }

  /** Orchestrator の異常終了（failed / orchestrator_failed）から、指示を付けて再開する（すぐ返す。再開は非同期） */
  recover(id: string, input: { instruction?: string } = {}): Workspace {
    return this.runner.recover(id, input);
  }

  /** `recover` できるか（Magentic グループ・設定がサーバーのメモリに残っている orchestrator_failed のみ） */
  canRecover(id: string): boolean {
    return this.runner.canRecover(id);
  }

  /** サーバーの終了時: 実行中のゲートの command を中断する */
  shutdown(): void {
    this.runner.shutdown();
  }

  /** ゲート変更（イレギュラー）を確認済みにする */
  ackIrregular(id: string, gateChangeId: string): Workspace {
    return this.runner.ackIrregular(id, gateChangeId);
  }

  /**
   * `update_ledger` の内容をゲートの不変性の規則で検証・正規化する。
   * 拒否のときは WorkspaceError（コード付き）を投げる。受理のときは正規化済みの値を返す。
   */
  applyLedgerUpdate(
    groupId: string,
    args: LedgerUpdateInput,
  ): { phases: Phase[]; scheduledSteps: ScheduledStep[] } {
    return this.runner.applyLedgerUpdate(groupId, args);
  }

  /**
   * レビュー資料のファイル（`reviews/` 配下の相対パス）の実パスを返す（配信用。§13.9.1）。
   * `..` を含む / 絶対パス / NUL・バックスラッシュを含む → INVALID_REQUEST。
   * 存在しない / ディレクトリ / 実パスが `reviews/` の外 → NOT_FOUND。
   */
  resolveReviewFile(id: string, file: string): string {
    const ws = this.require(id);
    if (
      file === "" ||
      file.includes("\0") ||
      file.includes("\\") ||
      isAbsolute(file) ||
      file.split("/").some((seg) => seg === "..")
    ) {
      throw new WorkspaceError("INVALID_REQUEST", "ファイルのパスが不正です");
    }
    const notFound = () => new WorkspaceError("NOT_FOUND", `レビュー資料が見つかりません: ${file}`);
    let real: string;
    let root: string;
    try {
      root = realpathSync(join(this.store.workspaceDir(ws.id), "reviews"));
      real = realpathSync(resolve(root, file));
    } catch {
      throw notFound();
    }
    const rel = relative(root, real);
    if (rel === "" || rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) throw notFound();
    if (!statSync(real).isFile()) throw notFound();
    return real;
  }

  abort(id: string): Workspace {
    const ws = this.require(id);
    if (ws.status === "running" || ws.status === "waiting_human") {
      return this.runner.abortRun(id);
    }
    if (ws.status !== "planning" && ws.status !== "review") {
      throw new WorkspaceError(
        "INVALID_STATE",
        `この状態の Workspace は中断できません（現在: ${ws.status}）`,
      );
    }

    if (ws.status === "planning") {
      const job = this.jobs.get(id);
      if (job) {
        // 先にリスナーを外す（停止した Agent の完了イベントを無視する）
        job.cancelled = true;
        this.detach(job);
        this.jobs.delete(id);
        if (job.agentId) this.manager.killAgent(job.agentId);
        this.deleteGroupQuietly(job.groupId);
      }
    }

    return this.store.update(id, (w) => {
      w.status = "aborted";
      w.statusReason = { code: "user_abort", message: "ユーザーが中断しました" };
    });
  }

  // ----------------------------------------------------
  // 計画生成
  // ----------------------------------------------------

  private startPlanning(
    ws: Workspace,
    opts: { previousPlan?: WorkPlan; additionalInstruction?: string; targets?: PlanTarget[] },
  ): void {
    let group;
    try {
      group = this.manager.createGroup(`Workspace ${ws.id} 計画生成`, "concurrent");
    } catch (e) {
      this.finishFailed(ws.id, opts.previousPlan !== undefined, errorMessage(e));
      return;
    }
    group.workspaceId = ws.id;
    // group:created の時点では workspaceId が未設定のため、設定後に通知し直す
    this.manager.emit("group:updated", group);

    const job: PlanningJob = {
      workspaceId: ws.id,
      groupId: group.id,
      revision: ws.revisions.length + 1,
      attempt: 1,
      previousPlan: opts.previousPlan,
      additionalInstruction: opts.additionalInstruction,
      targets: opts.targets,
      cancelled: false,
    };
    this.jobs.set(ws.id, job);
    this.launchAttempt(job, undefined);
  }

  /** Planner Agent を 1 つ起動し、完了を待ち受ける */
  private launchAttempt(job: PlanningJob, validationErrors: string[] | undefined): void {
    const ws = this.store.get(job.workspaceId);
    if (!ws) return;

    const prompt = buildPlannerPrompt({
      instruction: ws.instruction,
      workspacePath: ws.workspacePath,
      roles: this.availableRoleDefinitions(),
      // request（サーバーが付与する指示の記録）は Planner の出力の形ではないので渡さない
      previousPlan: job.previousPlan ? { ...job.previousPlan, request: undefined } : undefined,
      additionalInstruction: job.additionalInstruction,
      targets: job.targets,
      validationErrors,
    });

    let agent: AgentState;
    try {
      agent = this.manager.startAgent(job.groupId, this.requirePlanner(), prompt, {
        workingDirectory: ws.workspacePath,
      });
    } catch (e) {
      this.finishPlanning(job, [errorMessage(e)]);
      return;
    }
    job.agentId = agent.agentId;

    this.emit("workspace:plan_generating", {
      workspaceId: ws.id,
      revision: job.revision,
      message:
        job.attempt === 1
          ? "計画を生成しています"
          : "計画の出力に不備があったため、再生成しています",
    });

    this.attach(job, agent.agentId);

    // プロセスの起動に失敗した場合、manager は完了イベントを出さずに failed にする
    if (agent.status === "failed" && agent.result === null) {
      this.onPlannerCompleted(job, agent);
    }
  }

  /**
   * Planner Agent の完了を処理する。`agent:completed` のリスナーから呼ばれるため、
   * 例外は外に出さず（report_result の呼び出し側を壊さない）、計画生成の失敗として確定する。
   */
  private onPlannerCompleted(job: PlanningJob, agent: AgentState): void {
    try {
      this.handlePlannerCompleted(job, agent);
    } catch (e) {
      try {
        this.finishPlanning(job, [errorMessage(e)]);
      } catch (e2) {
        console.error(
          `[workspace] 計画生成の失敗を確定できませんでした (${job.workspaceId}): ${errorMessage(e)} / ${errorMessage(e2)}`,
        );
      }
    }
  }

  private handlePlannerCompleted(job: PlanningJob, agent: AgentState): void {
    this.detach(job);
    if (job.cancelled || this.jobs.get(job.workspaceId) !== job) return;

    const result = agent.result;
    let errors: string[];
    if (!result) {
      errors = ["Planner が結果を報告せずに終了しました（report_result で WorkPlan JSON を報告してください）"];
    } else if (result.status !== "success") {
      errors = [`Planner が ${result.status} を報告しました: ${result.errorMessage ?? result.summary}`];
    } else {
      const parsed = extractPlannerOutput(result.response);
      if (parsed.ok) {
        this.completePlanning(job, parsed.value);
        return;
      }
      errors = parsed.errors;
    }

    if (job.attempt < MAX_PLAN_ATTEMPTS) {
      job.attempt += 1;
      this.launchAttempt(job, errors);
    } else {
      this.finishPlanning(job, errors);
    }
  }

  /** 正常な出力から revision を作って保存する */
  private completePlanning(job: PlanningJob, input: WorkPlanInput): void {
    const ws = this.store.get(job.workspaceId);
    if (!ws) return;

    const ctx = this.validationContext();
    const revision = ws.revisions.length + 1;
    // 解釈の作業ディレクトリは Workspace の作業ディレクトリに揃える
    // この revision を作らせた指示を保存する（初回は最初の指示、再計画は追加指示と対象）
    const request: NonNullable<WorkPlan["request"]> = {
      instruction: job.additionalInstruction ?? ws.instruction,
      ...(job.targets && job.targets.length > 0 ? { targets: structuredClone(job.targets) } : {}),
      at: new Date().toISOString(),
    };
    const draft: WorkPlan = {
      ...input,
      spec: { ...input.spec, workspace: ws.workspacePath },
      revision,
      maxIterations: 0,
      request,
    };
    const { plan: fixed } = autoFixWorkPlan(draft, ctx);
    // 自動修正でゲートが増えるため、修正後の計画で算出する
    fixed.maxIterations = computeMaxIterations(fixed);
    const validation = validateWorkPlan(fixed, ctx);

    this.jobs.delete(job.workspaceId);
    this.store.update(job.workspaceId, (w) => {
      w.revisions.push(fixed);
      w.status = "review";
      delete w.statusReason;
    });
    this.deleteGroupQuietly(job.groupId);
    this.emit("workspace:plan_ready", { workspaceId: job.workspaceId, revision, validation });
  }

  /** 計画生成の失敗確定。初回なら failed、再計画なら直前の revision で review に戻す */
  private finishPlanning(job: PlanningJob, errors: string[]): void {
    this.detach(job);
    this.jobs.delete(job.workspaceId);
    this.deleteGroupQuietly(job.groupId);
    const summary = errors.slice(0, 5).join(" / ");
    this.finishFailed(job.workspaceId, job.previousPlan !== undefined, summary);
  }

  private finishFailed(workspaceId: string, isReplan: boolean, summary: string): void {
    const message = `計画の生成に失敗しました: ${summary}`;
    this.store.update(workspaceId, (w) => {
      if (isReplan) {
        w.status = "review";
        delete w.statusReason;
      } else {
        w.status = "failed";
        w.statusReason = { code: "plan_failed", message };
      }
    });
    this.emit("workspace:plan_failed", { workspaceId, message });
  }

  /** 計画生成グループを削除する（履歴の Agent は残る）。削除済み・失敗は無視する */
  private deleteGroupQuietly(groupId: string): void {
    try {
      if (this.manager.getGroup(groupId)?.status === "active") {
        this.manager.deleteGroup(groupId);
      }
    } catch {
      // 削除できなくても計画生成の結果には影響しない
    }
  }

  /**
   * Planner の完了待ちを登録する。`agent:completed` のリスナーは 1 本を共有し、待ちが無くなれば外す
   * （計画生成中の Workspace が増えても EventEmitter のリスナー数が増えない）。
   */
  private attach(job: PlanningJob, agentId: string): void {
    this.watchedPlanners.set(agentId, job);
    if (!this.plannerListener) {
      this.plannerListener = (completed: AgentState): void => {
        const watched = this.watchedPlanners.get(completed.agentId);
        if (watched && watched.agentId === completed.agentId) this.onPlannerCompleted(watched, completed);
      };
      this.manager.on("agent:completed", this.plannerListener);
    }
  }

  private detach(job: PlanningJob): void {
    if (job.agentId !== undefined && this.watchedPlanners.get(job.agentId) === job) {
      this.watchedPlanners.delete(job.agentId);
    }
    if (this.watchedPlanners.size === 0 && this.plannerListener) {
      this.manager.off("agent:completed", this.plannerListener);
      this.plannerListener = undefined;
    }
  }

  // ----------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------

  private require(id: string): Workspace {
    const ws = this.store.get(id);
    if (!ws) throw new WorkspaceError("NOT_FOUND", `Workspace が見つかりません: ${id}`);
    return ws;
  }

  private requireInstruction(instruction: string): string {
    if (typeof instruction !== "string" || instruction.trim() === "") {
      throw new WorkspaceError("INVALID_INSTRUCTION", "指示が空です");
    }
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      throw new WorkspaceError(
        "INVALID_INSTRUCTION",
        `指示が長すぎます（上限 ${MAX_INSTRUCTION_LENGTH} 文字）`,
      );
    }
    return instruction;
  }

  /** 省略時は cwd。絶対パスに解決し、存在するディレクトリであることを確認する */
  private resolveWorkspacePath(input: string | undefined): string {
    const trimmed = (input ?? "").trim();
    const path = trimmed === "" ? process.cwd() : resolve(trimmed);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new WorkspaceError(
        "INVALID_WORKSPACE_PATH",
        `作業ディレクトリが存在しないか、ディレクトリではありません: ${path}`,
      );
    }
    return path;
  }

  /** planner 職種があり、ヘルスチェックで利用不可と判定されていないこと */
  private requirePlanner(): RoleDefinition {
    const role = this.config.roles.find((r) => r.id === "planner");
    if (!role) {
      throw new WorkspaceError("PLANNER_UNAVAILABLE", "planner 職種が定義されていません");
    }
    const health = this.manager.getHealthCheckResult("planner");
    if (health && !health.available) {
      throw new WorkspaceError(
        "PLANNER_UNAVAILABLE",
        "planner 職種がヘルスチェックを通過していません",
      );
    }
    return role;
  }

  /** 計画で使える職種（orchestrator / planner を除き、ヘルスチェックが無いか通過したもの） */
  private availableRoleDefinitions(): RoleDefinition[] {
    return this.config.roles.filter((r) => {
      if (RESERVED_ROLE_IDS.has(r.id)) return false;
      const health = this.manager.getHealthCheckResult(r.id);
      return health === undefined || health.available;
    });
  }

  private validationContext(): ValidationContext {
    return {
      availableRoles: new Set(this.availableRoleDefinitions().map((r) => r.id)),
      commandPolicy: buildCommandPolicy(getWorkspaceConfig(this.config)),
    };
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
