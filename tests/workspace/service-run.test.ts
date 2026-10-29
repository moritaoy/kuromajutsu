// ============================================================
// WorkspaceService 実行系テスト（承認 → Magentic 実行・ゲート・人間レビュー・再開・終了判定。
// docs/spec.md §13.5 / §13.8）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager.js";
import { WorkspaceStore } from "../../src/workspace/store.js";
import { WorkspaceService, WorkspaceError } from "../../src/workspace/service.js";
import type { GateCommandRunOptions, GateCommandRunResult, GateCommandRunner } from "../../src/workspace/gate-runner.js";
import type { AppConfig, ScheduledStep, WorkPlan, Workspace } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";
import { buildWorkspaceReport } from "../../src/workspace/report.js";

vi.mock("../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

// 完了レポートの生成失敗を再現できるようにする（既定は本物の実装）
vi.mock("../../src/workspace/report.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/workspace/report.js")>();
  return { ...mod, buildWorkspaceReport: vi.fn(mod.buildWorkspaceReport) };
});

const WORK_ROLE_IDS = ["research", "design", "impl-code", "impl-test", "code-review", "text-review", "text-writer"];

function createTestConfig(opts: { orchestrator?: boolean } = {}): AppConfig {
  const roles: AppConfig["roles"] = WORK_ROLE_IDS.map((id) => ({
    id,
    name: `職種 ${id}`,
    description: `${id} の説明`,
    provider: "cursor" as const,
    model: "composer-2.5-fast",
    systemPrompt: `あなたは ${id} です。`,
    healthCheckPrompt: "OK",
  }));
  roles.unshift({
    id: "planner",
    name: "計画立案者",
    description: "計画を作る",
    provider: "claude",
    model: "opus",
    systemPrompt: "あなたは Planner です。",
    healthCheckPrompt: "OK",
  });
  if (opts.orchestrator !== false) {
    roles.unshift({
      id: "orchestrator",
      name: "オーケストレーター",
      description: "統括",
      provider: "claude",
      model: "claude-fable-5-1",
      systemPrompt: "あなたは Orchestrator です。",
      healthCheckPrompt: "OK",
    });
  }
  return {
    dashboard: { port: 9696 },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 100 },
    log: { level: "info" },
    roles,
  };
}

/** コマンド → 結果 の Map を持つフェイク */
class FakeGateRunner implements GateCommandRunner {
  results = new Map<string, Partial<GateCommandRunResult>>();
  calls: { command: string; opts: GateCommandRunOptions }[] = [];
  /** 中断されるまで終わらないコマンド */
  hang = new Set<string>();
  killAllCalls = 0;
  killAll(): void {
    this.killAllCalls += 1;
  }
  async run(command: string, opts: GateCommandRunOptions): Promise<GateCommandRunResult> {
    this.calls.push({ command, opts });
    if (this.hang.has(command)) {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: null, signal: "SIGTERM", timedOut: false, duration_ms: 1, stdoutTail: "", stderrTail: "中断" };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      duration_ms: 5,
      stdoutTail: `out of ${command}`,
      stderrTail: "",
      ...this.results.get(command),
    };
  }
}

const EVENT_NAMES = [
  "workspace:created",
  "workspace:updated",
  "workspace:gate_result",
  "workspace:gate_retry_exceeded",
  "workspace:human_review_requested",
  "workspace:human_review_resolved",
  "workspace:resumed",
  "workspace:irregular",
  "workspace:phase_planned",
  "workspace:replanned",
];

function reviewDoc(version = 1): Record<string, unknown> {
  return {
    title: "設計レビュー",
    version,
    ...(version >= 2
      ? { previousFeedback: { id: "prev", heading: "前回の指摘への対応", kind: "markdown", body: "表を直しました" } }
      : {}),
    sections: [{ id: "conclusion", heading: "結論", kind: "markdown", body: "JWT を採用する" }],
  };
}

describe("WorkspaceService（実行系）", () => {
  let dir: string;
  let projDir: string;
  let config: AppConfig;
  let manager: AgentManager;
  let store: WorkspaceStore;
  let service: WorkspaceService;
  let runner: FakeGateRunner;
  let mermaid: ReturnType<typeof vi.fn>;
  let mockKill: ReturnType<typeof vi.fn>;
  let mockExecute: ReturnType<typeof vi.fn>;
  let events: { name: string; data: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  let tick: number;

  function setup(c: AppConfig = createTestConfig()): void {
    config = c;
    manager = new AgentManager(config);
    store = new WorkspaceStore(dir);
    runner = new FakeGateRunner();
    mermaid = vi.fn(() => undefined);
    tick = 0;
    service = new WorkspaceService(config, manager, store, {
      gateRunner: runner,
      mermaidRuntime: mermaid as () => string | undefined,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
      resumeWait_ms: 30,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockKill = (manager as any).executor.kill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecute = (manager as any).executor.execute;
    events = [];
    for (const name of EVENT_NAMES) service.on(name, (data) => events.push({ name, data }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kuromajutsu-run-"));
    projDir = join(dir, "proj");
    mkdirSync(projDir);
    setup();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const eventsOf = (name: string) => events.filter((e) => e.name === name).map((e) => e.data);

  /** review 状態の Workspace を直接作る（計画生成は service.test.ts で検証済み） */
  function reviewWorkspace(mutate?: (plan: WorkPlan) => void): Workspace {
    const ws = store.create({ instruction: "認証を追加して", workspacePath: projDir });
    const plan = makeAuthPlan();
    mutate?.(plan);
    return store.update(ws.id, (w) => {
      w.revisions.push(plan);
      w.status = "review";
    });
  }

  function running(mutate?: (plan: WorkPlan) => void) {
    const ws = reviewWorkspace(mutate);
    const approved = service.approve(ws.id);
    const groupId = approved.groupId as string;
    return { id: ws.id, groupId, orchestratorId: orchestratorOf(groupId) };
  }

  const orchestratorOf = (groupId: string): string =>
    manager.getGroup(groupId)?.orchestratorAgentId as string;

  const current = (id: string): Workspace => store.get(id) as Workspace;

  const steps = (groupId: string): ScheduledStep[] =>
    manager.getLedger(groupId)?.taskLedger?.scheduledSteps as ScheduledStep[];

  const stepStatus = (groupId: string, stepId: string): string | undefined =>
    steps(groupId).find((s) => s.stepId === stepId)?.status;

  /** Agent を完了させる（report_result 相当） */
  function finish(
    agentId: string,
    status: "success" | "failure" = "success",
    response = "完了",
    summary = "要約",
    errorMessage?: string,
  ): void {
    if (manager.getAgent(agentId)?.status === "queued") {
      manager.updateAgentState(agentId, { status: "running" });
    }
    manager.reportResult(agentId, { status, summary, response, errorMessage });
  }

  /** text-writer の Agent が ReviewDoc を報告する */
  function writerReports(groupId: string, doc: unknown): string {
    const child = manager.createGroup("レビュー資料の作成", "concurrent", groupId);
    const role = config.roles.find((r) => r.id === "text-writer")!;
    const agent = manager.startAgent(child.id, role, "資料を作って");
    finish(agent.agentId, "success", typeof doc === "string" ? doc : JSON.stringify(doc));
    return agent.agentId;
  }

  /** gate-P1（agent-review + human）の自動チェックを合格させて auto_passed にする */
  function autoPassP1(groupId: string): void {
    const r = service.reportGateResult(groupId, "gate-P1", 0, true, "矛盾なし");
    expect(r.gateStatus).toBe("auto_passed");
  }

  /** `workspace:resumed` を待つ（再開は非同期で行われる） */
  const nextResumed = (): Promise<void> =>
    new Promise((resolve) => {
      service.once("workspace:resumed", () => resolve());
    });
  const resolveAndResume = async (...args: Parameters<WorkspaceService["resolveHumanReview"]>): Promise<Workspace> => {
    const resumed = nextResumed();
    const out = service.resolveHumanReview(...args);
    await resumed;
    return out;
  };
  const retryAndResume = async (...args: Parameters<WorkspaceService["retry"]>): Promise<Workspace> => {
    const resumed = nextResumed();
    const out = service.retry(...args);
    await resumed;
    return out;
  };
  const until = async (pred: () => boolean, timeout = 2000): Promise<void> => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeout) throw new Error("until: タイムアウト");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const lastPrompt = (): string => {
    const calls = mockExecute.mock.calls;
    return calls[calls.length - 1][1].prompt as string;
  };

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof WorkspaceError ? e.code : `非 WorkspaceError: ${String(e)}`;
    }
    return undefined;
  };
  const codeOfAsync = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await fn();
    } catch (e) {
      return e instanceof WorkspaceError ? e.code : `非 WorkspaceError: ${String(e)}`;
    }
    return undefined;
  };

  // ----------------------------------------------------
  // approve
  // ----------------------------------------------------

  describe("approve", () => {
    it("magentic グループ・Task Ledger・Orchestrator を作って running にする", () => {
      const ws = reviewWorkspace();
      const out = service.approve(ws.id);

      expect(out.status).toBe("running");
      expect(out.approvedRevision).toBe(1);
      expect(out.groupId).toBeDefined();

      const group = manager.getGroup(out.groupId as string)!;
      expect(group.mode).toBe("magentic");
      expect(group.workspaceId).toBe(ws.id);
      expect(group.description).toContain(ws.id);

      const plan = out.revisions[0];
      const ledger = manager.getLedger(group.id)!.taskLedger!;
      expect(ledger.scheduledSteps).toHaveLength(plan.steps.length);
      const gate = ledger.scheduledSteps!.find((s) => s.stepId === "gate-P1")!;
      expect(gate.kind).toBe("gate");
      expect(gate.checks).toHaveLength(2);
      expect(gate.phaseId).toBe("P1");
      expect(ledger.phases?.map((p) => p.id)).toEqual(["P1", "P2", "P3", "PF"]);

      const agent = manager.getAgent(group.orchestratorAgentId as string)!;
      expect(agent.role).toBe("orchestrator");
      expect(agent.groupId).toBe(group.id);
    });

    it("Orchestrator のプロンプトに Workspace の注入ブロックと承認時の設定が含まれる", () => {
      const ws = reviewWorkspace();
      service.approve(ws.id);

      const [, options] = mockExecute.mock.calls[0];
      const prompt = options.prompt as string;
      expect(prompt).toContain("あなたは Orchestrator です。");
      expect(prompt).toContain("Workspace 実行ルール");
      expect(prompt).toContain("認証機能（JWT）の追加");
      expect(prompt).toContain("認証を追加して");
      expect(prompt).toContain("npm test が成功する"); // 完了条件
      expect(prompt).toContain("src/auth/**"); // スコープ
      expect(prompt).toContain(ws.id);
      expect(options.workingDirectory).toBe(projDir);
    });

    it("MagenticConfig は instruction + goal / 完了条件 / スコープ / 制約 / 利用可能な職種を持つ", () => {
      const ws = reviewWorkspace();
      const out = service.approve(ws.id);
      const cfg = manager.getMagenticConfig(out.groupId as string)!;

      expect(cfg.task).toContain("認証を追加して");
      expect(cfg.task).toContain("既存 API に JWT 認証を追加する");
      expect(cfg.completionCriteria).toContain("npm test が成功する");
      expect(cfg.completionCriteria).toContain("認証 API が仕様どおりに動く");
      expect(cfg.scope).toContain("src/auth/**");
      expect(cfg.scope).toContain(projDir);
      expect(cfg.constraints).toContain("TDD");
      expect(cfg.context).toContain("HS256 署名");
      expect(cfg.context).toContain("Express 製");
      expect(cfg.context).toContain(ws.id);
      expect(cfg.availableRoles).toEqual(expect.arrayContaining(["impl-code", "text-writer", "code-review"]));
      expect(cfg.availableRoles).not.toContain("orchestrator");
      expect(cfg.availableRoles).not.toContain("planner");
      expect(cfg.maxIterations).toBe(12);
      expect(cfg.promptAppendix).toContain("Workspace 実行ルール");
    });

    it("maxIterations を指定すると上書きし、計画（revision）にも反映する", () => {
      const ws = reviewWorkspace();
      const out = service.approve(ws.id, { maxIterations: 30 });
      expect(manager.getMagenticConfig(out.groupId as string)!.maxIterations).toBe(30);
      expect(out.revisions[0].maxIterations).toBe(30);
      expect(current(ws.id).revisions[0].maxIterations).toBe(30);
    });

    it("maxIterations が正の整数でなければ INVALID_REQUEST", () => {
      const ws = reviewWorkspace();
      expect(codeOf(() => service.approve(ws.id, { maxIterations: 0 }))).toBe("INVALID_REQUEST");
      expect(codeOf(() => service.approve(ws.id, { maxIterations: 1.5 }))).toBe("INVALID_REQUEST");
      expect(current(ws.id).status).toBe("review");
    });

    it("全ゲートの GateResult を初期化する（human のみのゲートは auto_passed）", () => {
      const ws = reviewWorkspace((p) => {
        const g = p.steps.find((s) => s.id === "gate-P3")!;
        g.checks = [{ text: "人が見る", method: "human" }];
      });
      const out = service.approve(ws.id);
      expect(out.gateResults.map((g) => g.gateId).sort()).toEqual(["gate-P1", "gate-P2", "gate-P3", "gate-final"]);
      const byId = new Map(out.gateResults.map((g) => [g.gateId, g]));
      expect(byId.get("gate-P1")).toMatchObject({ phaseId: "P1", status: "pending", attempts: [], retryInstructions: [] });
      expect(byId.get("gate-P3")?.status).toBe("auto_passed");
    });

    it("workspace:updated を emit する", () => {
      const ws = reviewWorkspace();
      events.length = 0;
      service.approve(ws.id);
      const updated = eventsOf("workspace:updated") as Workspace[];
      expect(updated.length).toBeGreaterThan(0);
      expect(updated[updated.length - 1].status).toBe("running");
    });

    it("review 以外では INVALID_STATE、存在しなければ NOT_FOUND", () => {
      const { id } = running();
      expect(codeOf(() => service.approve(id))).toBe("INVALID_STATE");
      expect(codeOf(() => service.approve("ws-nope"))).toBe("NOT_FOUND");
    });

    it("検証エラーがあれば VALIDATION_FAILED（issues 付き）で、状態は変わらない", () => {
      const ws = reviewWorkspace((p) => {
        p.steps.find((s) => s.id === "s1")!.role = "no-such-role";
      });
      let err: unknown;
      try {
        service.approve(ws.id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorkspaceError);
      const we = err as WorkspaceError;
      expect(we.code).toBe("VALIDATION_FAILED");
      expect(we.issues?.some((i) => i.rule === "V6" && i.level === "error")).toBe(true);
      expect(current(ws.id).status).toBe("review");
      expect(current(ws.id).groupId).toBeUndefined();
      expect(manager.listGroups()).toHaveLength(0);
    });

    it("orchestrator 職種が無ければ ORCHESTRATOR_UNAVAILABLE", () => {
      setup(createTestConfig({ orchestrator: false }));
      const ws = reviewWorkspace();
      expect(codeOf(() => service.approve(ws.id))).toBe("ORCHESTRATOR_UNAVAILABLE");
      expect(current(ws.id).status).toBe("review");
    });

    it("orchestrator のヘルスチェックが未通過なら ORCHESTRATOR_UNAVAILABLE", () => {
      manager.setHealthCheckResults([
        {
          roleId: "orchestrator",
          provider: "claude",
          modelValidation: { status: "unavailable", checkedAt: "" },
          healthCheck: { status: "failed", checkedAt: "" },
          available: false,
        } as never,
      ]);
      const ws = reviewWorkspace();
      expect(codeOf(() => service.approve(ws.id))).toBe("ORCHESTRATOR_UNAVAILABLE");
    });

    it("Orchestrator を起動できなければ（maxConcurrent 超過）ORCHESTRATOR_UNAVAILABLE で review に戻りグループも残らない", () => {
      setup({ ...createTestConfig(), agent: { defaultTimeout_ms: 300_000, maxConcurrent: 0 } });
      const ws = reviewWorkspace();
      expect(codeOf(() => service.approve(ws.id))).toBe("ORCHESTRATOR_UNAVAILABLE");
      expect(current(ws.id).status).toBe("review");
      expect(current(ws.id).groupId).toBeUndefined();
      expect(manager.listGroups().filter((g) => g.status === "active")).toHaveLength(0);
    });

    it("Orchestrator のプロセスを起動できなかったら failed（orchestrator_failed）", () => {
      mockExecute.mockImplementationOnce(() => {
        throw new Error("spawn に失敗");
      });
      const ws = reviewWorkspace();
      const out = service.approve(ws.id);
      expect(out.status).toBe("failed");
      expect(out.statusReason?.code).toBe("orchestrator_failed");
    });

    it("findByGroupId で Workspace を引ける。子グループは引けない（親グループの ID のみ）", () => {
      const { id, groupId } = running();
      expect(service.findByGroupId(groupId)?.id).toBe(id);
      expect(service.findByGroupId("grp-nope")).toBeUndefined();
    });

    it("再起動後（store.loadAll 後）に作ったサービスでも findByGroupId できる", () => {
      const { id, groupId } = running();
      const store2 = new WorkspaceStore(dir);
      store2.loadAll();
      const service2 = new WorkspaceService(config, new AgentManager(config), store2);
      expect(service2.findByGroupId(groupId)?.id).toBe(id);
    });
  });

  // ----------------------------------------------------
  // run_gate_check
  // ----------------------------------------------------

  describe("runGateCheck", () => {
    it("合格 → passed になり、Ledger のゲートが completed になる", async () => {
      const { id, groupId } = running();
      const out = await service.runGateCheck(groupId, "gate-P2");

      expect(out.gateId).toBe("gate-P2");
      expect(out.attempt).toBe(1);
      expect(out.gateStatus).toBe("passed");
      expect(out.failedAttempts).toBe(0);
      expect(out.maxRetries).toBe(2);
      expect(out.retryLimitExceeded).toBe(false);
      expect(out.pendingChecks).toEqual([]);
      expect(out.results).toEqual([
        expect.objectContaining({
          checkIndex: 0,
          text: "ビルドが成功する",
          command: "npm run build",
          passed: true,
          exitCode: 0,
          timedOut: false,
          stdoutTail: "out of npm run build",
        }),
      ]);
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0].command).toBe("npm run build");
      expect(runner.calls[0].opts.cwd).toBe(projDir);
      expect(runner.calls[0].opts.timeout_ms).toBe(600000);

      expect(current(id).gateResults.find((g) => g.gateId === "gate-P2")?.status).toBe("passed");
      expect(stepStatus(groupId, "gate-P2")).toBe("completed");
      expect(eventsOf("workspace:gate_result")).toEqual([
        expect.objectContaining({
          workspaceId: id,
          gateResult: expect.objectContaining({ gateId: "gate-P2", status: "passed" }),
        }),
      ]);
    });

    it("不合格 → failed（Ledger のゲートは完了にしない）", async () => {
      const { id, groupId } = running();
      runner.results.set("npm run build", { exitCode: 1, stderrTail: "error TS" });
      const out = await service.runGateCheck(groupId, "gate-P2");

      expect(out.gateStatus).toBe("failed");
      expect(out.failedAttempts).toBe(1);
      expect(out.retryLimitExceeded).toBe(false);
      expect(out.results[0]).toMatchObject({ passed: false, exitCode: 1, stderrTail: "error TS" });
      expect(out.instruction).toBeUndefined();
      expect(stepStatus(groupId, "gate-P2")).not.toBe("completed");
      expect(current(id).status).toBe("running");
    });

    it("タイムアウトは不合格", async () => {
      const { groupId } = running();
      runner.results.set("npm run build", { exitCode: null, timedOut: true });
      const out = await service.runGateCheck(groupId, "gate-P2");
      expect(out.results[0]).toMatchObject({ passed: false, timedOut: true });
    });

    it("複数の command は途中で不合格でもすべて実行する", async () => {
      const { groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [
          { text: "ビルド", method: "command", command: "npm run build" },
          { text: "テスト", method: "command", command: "npm test" },
        ];
      });
      runner.results.set("npm run build", { exitCode: 2 });
      const out = await service.runGateCheck(groupId, "gate-P3");
      expect(runner.calls.map((c) => c.command)).toEqual(["npm run build", "npm test"]);
      expect(out.results.map((r) => r.passed)).toEqual([false, true]);
      expect(out.results.map((r) => r.checkIndex)).toEqual([0, 1]);
      expect(out.gateStatus).toBe("failed");
      expect(out.attempt).toBe(1);
    });

    it("agent-review / human が残っていれば pendingChecks に出す（gateStatus は pending）", async () => {
      const { groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [
          { text: "レビュー", method: "agent-review" },
          { text: "テスト", method: "command", command: "npm test" },
          { text: "人が見る", method: "human" },
        ];
      });
      const out = await service.runGateCheck(groupId, "gate-P3");
      expect(out.gateStatus).toBe("pending");
      expect(out.pendingChecks).toEqual([
        { checkIndex: 0, method: "agent-review" },
        { checkIndex: 2, method: "human" },
      ]);
    });

    it("差し戻し上限（maxRetries: 2 → 3 回不合格）で retryLimitExceeded、waiting_human（gate_retry_exceeded）", async () => {
      const { id, groupId } = running();
      runner.results.set("npm run build", { exitCode: 1 });
      const a = await service.runGateCheck(groupId, "gate-P2");
      const b = await service.runGateCheck(groupId, "gate-P2");
      expect([a.failedAttempts, b.failedAttempts]).toEqual([1, 2]);
      expect(b.retryLimitExceeded).toBe(false);
      expect(current(id).status).toBe("running");

      const c = await service.runGateCheck(groupId, "gate-P2");
      expect(c.failedAttempts).toBe(3);
      expect(c.retryLimitExceeded).toBe(true);
      expect(c.instruction).toContain("report_result");
      expect(c.instruction).toContain("差し戻し上限超過で一時停止");

      const ws = current(id);
      expect(ws.status).toBe("waiting_human");
      expect(ws.statusReason).toMatchObject({ code: "gate_retry_exceeded", gateId: "gate-P2" });
      expect(eventsOf("workspace:gate_retry_exceeded")).toEqual([{ workspaceId: id, gateId: "gate-P2" }]);

      // 停止中は記録できない
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-P2"))).toBe("WORKSPACE_NOT_RUNNING");
    });

    it("onFail.maxRetries を尊重する", async () => {
      const { groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P2")!.onFail = { action: "rework", maxRetries: 0 };
      });
      runner.results.set("npm run build", { exitCode: 1 });
      const out = await service.runGateCheck(groupId, "gate-P2");
      expect(out.maxRetries).toBe(0);
      expect(out.retryLimitExceeded).toBe(true);
    });

    it("エラー: 非 Workspace グループ / 停止中 / ゲートなし / command なし / 禁止コマンド", async () => {
      const { groupId } = running();
      const normal = manager.createGroup("普通のグループ");
      expect(await codeOfAsync(() => service.runGateCheck(normal.id, "gate-P2"))).toBe("NOT_WORKSPACE_GROUP");
      expect(await codeOfAsync(() => service.runGateCheck("grp-nope", "gate-P2"))).toBe("NOT_WORKSPACE_GROUP");
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "nope"))).toBe("GATE_NOT_FOUND");
      // 作業 Step の ID はゲートではない
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "s1"))).toBe("GATE_NOT_FOUND");
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-final"))).toBe("NO_COMMAND_CHECK");

      config.workspace = {
        gateCommands: { deny: ["npm run build"], allow: [], timeout_ms: 600000, maxOutput_bytes: 1048576 },
      };
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-P2"))).toBe("COMMAND_DENIED");
      expect(runner.calls).toHaveLength(0);
    });

    it("running 以外（done など）では WORKSPACE_NOT_RUNNING", async () => {
      const { id, groupId } = running();
      service.abort(id);
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-P2"))).toBe("WORKSPACE_NOT_RUNNING");
    });

    it("ゲートは Ledger の現在の scheduledSteps から引く（Orchestrator が追加したゲートも実行できる）", async () => {
      const { groupId } = running();
      const current = structuredClone(steps(groupId));
      current.push({
        stepId: "gate-extra",
        role: "code-review",
        description: "追加ゲート",
        status: "pending",
        phaseId: "P3",
        kind: "gate",
        checks: [{ text: "lint", method: "command", command: "npm run lint" }],
      });
      const applied = service.applyLedgerUpdate(groupId, { scheduledSteps: current });
      const ledger = manager.getLedger(groupId)!.taskLedger!;
      manager.updateTaskLedger(groupId, {
        facts: ledger.facts,
        plan: ledger.plan,
        scheduledSteps: applied.scheduledSteps,
        phases: applied.phases,
      });
      const out = await service.runGateCheck(groupId, "gate-extra");
      expect(out.gateStatus).toBe("passed");
      expect(runner.calls[0].command).toBe("npm run lint");
    });
  });

  // ----------------------------------------------------
  // report_gate_result
  // ----------------------------------------------------

  describe("reportGateResult", () => {
    it("agent-review の合格を記録する（human ありなら auto_passed）", () => {
      const { id, groupId } = running();
      const out = service.reportGateResult(groupId, "gate-P1", 0, true, "矛盾なし");
      expect(out).toMatchObject({
        registered: true,
        gateId: "gate-P1",
        checkIndex: 0,
        attempt: 1,
        gateStatus: "auto_passed",
        failedAttempts: 0,
        maxRetries: 2,
        retryLimitExceeded: false,
      });
      const g = current(id).gateResults.find((x) => x.gateId === "gate-P1")!;
      expect(g.attempts[0].checks[0]).toMatchObject({ checkIndex: 0, method: "agent-review", passed: true, note: "矛盾なし" });
      expect(eventsOf("workspace:gate_result")).toHaveLength(1);
      // 人間レビューがあるのでゲートはまだ完了しない
      expect(stepStatus(groupId, "gate-P1")).not.toBe("completed");
    });

    it("human なしのゲートは合格で passed + Ledger completed", () => {
      const { groupId } = running();
      const out = service.reportGateResult(groupId, "gate-final", 0, true);
      expect(out.gateStatus).toBe("passed");
      expect(stepStatus(groupId, "gate-final")).toBe("completed");
    });

    it("不合格は failed", () => {
      const { id, groupId } = running();
      const out = service.reportGateResult(groupId, "gate-final", 0, false, "テストが足りない");
      expect(out.gateStatus).toBe("failed");
      expect(out.failedAttempts).toBe(1);
      expect(current(id).gateResults.find((g) => g.gateId === "gate-final")?.attempts[0].checks[0].note).toBe(
        "テストが足りない",
      );
    });

    it("不合格が続くと retryLimitExceeded で waiting_human", () => {
      const { id, groupId } = running();
      service.reportGateResult(groupId, "gate-final", 0, false);
      service.reportGateResult(groupId, "gate-final", 0, false);
      const out = service.reportGateResult(groupId, "gate-final", 0, false);
      expect(out.retryLimitExceeded).toBe(true);
      expect(out.instruction).toContain("差し戻し上限超過で一時停止");
      expect(current(id).status).toBe("waiting_human");
      expect(current(id).statusReason?.code).toBe("gate_retry_exceeded");
    });

    it("エラー: CHECK_NOT_FOUND / CHECK_METHOD_MISMATCH / GATE_NOT_FOUND / NOT_WORKSPACE_GROUP", () => {
      const { groupId } = running();
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P1", 9, true))).toBe("CHECK_NOT_FOUND");
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P1", -1, true))).toBe("CHECK_NOT_FOUND");
      // human チェック
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P1", 1, true))).toBe("CHECK_METHOD_MISMATCH");
      // command チェック
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P2", 0, true))).toBe("CHECK_METHOD_MISMATCH");
      expect(codeOf(() => service.reportGateResult(groupId, "nope", 0, true))).toBe("GATE_NOT_FOUND");
      const normal = manager.createGroup("普通");
      expect(codeOf(() => service.reportGateResult(normal.id, "gate-P1", 0, true))).toBe("NOT_WORKSPACE_GROUP");
    });
  });

  // ----------------------------------------------------
  // request_human_review → 差し戻し → 承認
  // ----------------------------------------------------

  describe("人間レビュー", () => {
    it("requestHumanReview: ReviewDoc を HTML にして保存し、waiting_human（human_review）にする", () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      const writerId = writerReports(groupId, reviewDoc());
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const out = service.requestHumanReview(groupId, "gate-P1", `agent:${writerId}`);
      expect(out).toMatchObject({
        registered: true,
        gateId: "gate-P1",
        reviewVersion: 1,
        reviewFile: "reviews/gate-P1-v1.html",
        status: "waiting_human",
      });
      expect(out.next).toContain("report_result");

      const file = join(dir, "workspaces", id, "reviews", "gate-P1-v1.html");
      expect(existsSync(file)).toBe(true);
      const html = readFileSync(file, "utf-8");
      expect(html).toContain("設計レビュー");
      expect(html).toContain("JWT を採用する");

      const ws = current(id);
      expect(ws.status).toBe("waiting_human");
      expect(ws.statusReason).toMatchObject({ code: "human_review", gateId: "gate-P1" });
      expect(ws.gateResults.find((g) => g.gateId === "gate-P1")?.status).toBe("waiting_human");
      expect(ws.humanReviews).toEqual([
        expect.objectContaining({
          gateId: "gate-P1",
          version: 1,
          status: "pending",
          docFile: "reviews/gate-P1-v1.html",
          comments: [],
        }),
      ]);
      expect(eventsOf("workspace:human_review_requested")).toEqual([
        { workspaceId: id, review: expect.objectContaining({ gateId: "gate-P1", version: 1 }) },
      ]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes(`[workspace] waiting_human: ${id} gate-P1`))).toBe(true);

      // Orchestrator が success で終了しても waiting_human のまま
      finish(orchestratorId, "success", "人間レビュー待ちで一時停止", "人間レビュー待ちで一時停止");
      expect(current(id).status).toBe("waiting_human");
    });

    it("差し戻し → 再開（コメントが再開プロンプトに入る）→ 2 回目は v2 → 承認で passed", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      const w1 = writerReports(groupId, reviewDoc(1));
      service.requestHumanReview(groupId, "gate-P1", `agent:${w1}`);
      finish(orchestratorId, "success", "一時停止");

      const resolved = await resolveAndResume(id, "gate-P1", {
        decision: "request_changes",
        comment: "全体的に根拠が足りない",
        comments: [{ sectionId: "spec", text: "仕様の表を直して" }],
      });
      expect(resolved.status).toBe("running");
      expect(resolved.statusReason).toBeUndefined();

      const ws1 = current(id);
      expect(ws1.humanReviews[0]).toMatchObject({
        status: "changes_requested",
        comments: [
          { sectionId: "spec", text: "仕様の表を直して" },
          { text: "全体的に根拠が足りない" },
        ],
      });
      expect(ws1.humanReviews[0].resolvedAt).toBeDefined();
      expect(ws1.gateResults.find((g) => g.gateId === "gate-P1")?.status).toBe("pending");
      expect(stepStatus(groupId, "gate-P1")).toBe("in_progress");

      // 新しい Orchestrator が同じグループで起動し、プロンプトに再開内容が入る
      const second = orchestratorOf(groupId);
      expect(second).not.toBe(orchestratorId);
      expect(manager.getGroup(groupId)?.status).toBe("active");
      const prompt = lastPrompt();
      expect(prompt).toContain("Workspace 実行ルール");
      expect(prompt).toContain("あなたは前の Orchestrator の続きを担当します");
      expect(prompt).toContain("人間レビューの差し戻し");
      expect(prompt).toContain("仕様の表を直して");
      expect(prompt).toContain("全体的に根拠が足りない");
      expect(eventsOf("workspace:human_review_resolved")).toEqual([
        { workspaceId: id, review: expect.objectContaining({ status: "changes_requested", gateId: "gate-P1" }) },
      ]);
      expect(eventsOf("workspace:resumed")).toEqual([
        { workspaceId: id, reason: "changes_requested", orchestratorAgentId: second },
      ]);

      // 差し戻し後は自動チェックをやり直す → v2 の資料
      autoPassP1(groupId);
      const w2 = writerReports(groupId, reviewDoc(2));
      const out2 = service.requestHumanReview(groupId, "gate-P1", `agent:${w2}`);
      expect(out2.reviewVersion).toBe(2);
      expect(out2.reviewFile).toBe("reviews/gate-P1-v2.html");
      expect(existsSync(join(dir, "workspaces", id, "reviews", "gate-P1-v1.html"))).toBe(true);
      expect(existsSync(join(dir, "workspaces", id, "reviews", "gate-P1-v2.html"))).toBe(true);
      expect(current(id).humanReviews).toHaveLength(2);
      finish(second, "success", "一時停止");
      expect(current(id).status).toBe("waiting_human");

      // 承認
      const approved = await resolveAndResume(id, "gate-P1", { decision: "approve" });
      expect(approved.status).toBe("running");
      const ws2 = current(id);
      expect(ws2.humanReviews[1].status).toBe("approved");
      expect(ws2.gateResults.find((g) => g.gateId === "gate-P1")?.status).toBe("passed");
      expect(stepStatus(groupId, "gate-P1")).toBe("completed");
      expect(lastPrompt()).toContain("人間レビューの承認");
      expect(orchestratorOf(groupId)).not.toBe(second);
      expect(eventsOf("workspace:resumed")).toHaveLength(2);
    });

    it("version が実際の件数と食い違う ReviewDoc は補正する（v1 が来ても 2 版目なら 2 にする）", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc(1))}`);
      finish(orchestratorId);
      await resolveAndResume(id, "gate-P1", { decision: "request_changes", comment: "直して" });
      autoPassP1(groupId);

      // version: 5 + previousFeedback あり → 2 に補正
      const doc = { ...reviewDoc(2), version: 5 };
      const out = service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, doc)}`);
      expect(out.reviewVersion).toBe(2);
      const html = readFileSync(join(dir, "workspaces", id, "reviews", "gate-P1-v2.html"), "utf-8");
      expect(html).toContain("v2");
    });

    it("2 版目に previousFeedback が無ければ REVIEW_DOC_INVALID", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc(1))}`);
      finish(orchestratorId);
      await resolveAndResume(id, "gate-P1", { decision: "request_changes", comment: "直して" });
      autoPassP1(groupId);

      const doc = reviewDoc(1); // previousFeedback なし
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, doc)}`))).toBe(
        "REVIEW_DOC_INVALID",
      );
      expect(current(id).status).toBe("running");
    });

    it("ReviewDoc を作業ディレクトリ内の JSON ファイルから読める", () => {
      const { id, groupId } = running();
      autoPassP1(groupId);
      writeFileSync(join(projDir, "review.json"), JSON.stringify(reviewDoc()));
      const out = service.requestHumanReview(groupId, "gate-P1", "review.json");
      expect(out.reviewFile).toBe("reviews/gate-P1-v1.html");
      expect(current(id).status).toBe("waiting_human");
    });

    it("作業ディレクトリ外のファイル（.. / 絶対パス / シンボリックリンク）は REVIEW_DOC_NOT_FOUND", () => {
      const { groupId } = running();
      autoPassP1(groupId);
      writeFileSync(join(dir, "outside.json"), JSON.stringify(reviewDoc()));
      symlinkSync(join(dir, "outside.json"), join(projDir, "link.json"));
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", "../outside.json"))).toBe("REVIEW_DOC_NOT_FOUND");
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", join(dir, "outside.json")))).toBe(
        "REVIEW_DOC_NOT_FOUND",
      );
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", "link.json"))).toBe("REVIEW_DOC_NOT_FOUND");
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", "missing.json"))).toBe("REVIEW_DOC_NOT_FOUND");
    });

    it("agent: の参照が不正 / 結果なし なら REVIEW_DOC_NOT_FOUND、JSON でない・スキーマ違反は REVIEW_DOC_INVALID", () => {
      const { groupId } = running();
      autoPassP1(groupId);
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", "agent:nope-1"))).toBe("REVIEW_DOC_NOT_FOUND");

      const child = manager.createGroup("c", "concurrent", groupId);
      const noResult = manager.startAgent(child.id, config.roles.find((r) => r.id === "text-writer")!, "x");
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${noResult.agentId}`))).toBe(
        "REVIEW_DOC_NOT_FOUND",
      );

      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, "JSON ではない文章")}`))).toBe(
        "REVIEW_DOC_INVALID",
      );
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, { title: "x", version: 1, sections: [] })}`))).toBe(
        "REVIEW_DOC_INVALID",
      );
    });

    it("エラー: NO_HUMAN_CHECK / AUTO_CHECKS_NOT_PASSED / GATE_NOT_FOUND / NOT_WORKSPACE_GROUP", () => {
      const { groupId } = running();
      const w = writerReports(groupId, reviewDoc());
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P3", `agent:${w}`))).toBe("NO_HUMAN_CHECK");
      // 自動チェックが未実施
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${w}`))).toBe("AUTO_CHECKS_NOT_PASSED");
      // 自動チェックが不合格
      service.reportGateResult(groupId, "gate-P1", 0, false);
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${w}`))).toBe("AUTO_CHECKS_NOT_PASSED");
      expect(codeOf(() => service.requestHumanReview(groupId, "nope", `agent:${w}`))).toBe("GATE_NOT_FOUND");
      const normal = manager.createGroup("普通");
      expect(codeOf(() => service.requestHumanReview(normal.id, "gate-P1", `agent:${w}`))).toBe("NOT_WORKSPACE_GROUP");
    });

    it("human のみのゲートは自動チェックなしで依頼できる", () => {
      const { groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [{ text: "人が見る", method: "human" }];
      });
      const w = writerReports(groupId, reviewDoc());
      const out = service.requestHumanReview(groupId, "gate-P3", `agent:${w}`);
      expect(out.reviewFile).toBe("reviews/gate-P3-v1.html");
    });

    it("human のみのゲートの差し戻しは、やり直す自動チェックがないので auto_passed に戻り、そのまま次の版を依頼できる", async () => {
      const { id, groupId, orchestratorId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [{ text: "人が見る", method: "human" }];
      });
      service.requestHumanReview(groupId, "gate-P3", `agent:${writerReports(groupId, reviewDoc(1))}`);
      finish(orchestratorId);
      await resolveAndResume(id, "gate-P3", { decision: "request_changes", comment: "直して" });
      expect(current(id).gateResults.find((g) => g.gateId === "gate-P3")?.status).toBe("auto_passed");
      const out = service.requestHumanReview(groupId, "gate-P3", `agent:${writerReports(groupId, reviewDoc(2))}`);
      expect(out.reviewVersion).toBe(2);
    });

    it("mermaid 節があるときだけ mermaid ランタイムを埋め込む", () => {
      const { id, groupId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      expect(mermaid).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, "workspaces", id, "reviews", "gate-P1-v1.html"), "utf-8")).not.toContain("/*MERMAID_RUNTIME*/");
    });

    it("mermaid 節がある資料はランタイムを埋め込む", () => {
      mermaid.mockReturnValue("/*MERMAID_RUNTIME*/");
      const { id, groupId } = running();
      autoPassP1(groupId);
      const doc = reviewDoc();
      (doc["sections"] as unknown[]).push({ id: "structure", heading: "構成", kind: "mermaid", body: "graph TD; A-->B" });
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, doc)}`);
      expect(mermaid).toHaveBeenCalled();
      expect(readFileSync(join(dir, "workspaces", id, "reviews", "gate-P1-v1.html"), "utf-8")).toContain("/*MERMAID_RUNTIME*/");
    });

    it("file 節のファイルは reviews/<gate>-v<n>.files/ に複製される", () => {
      const { id, groupId } = running();
      autoPassP1(groupId);
      mkdirSync(join(projDir, "mock"));
      writeFileSync(join(projDir, "mock", "ui.html"), "<h1>モック</h1>");
      const doc = reviewDoc();
      (doc["sections"] as unknown[]).push({ id: "mock", heading: "モック", kind: "file", path: "mock/ui.html" });
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, doc)}`);
      const copied = join(dir, "workspaces", id, "reviews", "gate-P1-v1.files", "ui.html");
      expect(readFileSync(copied, "utf-8")).toBe("<h1>モック</h1>");
    });

    it("作業ディレクトリ外を指す file 節は REVIEW_DOC_INVALID", () => {
      const { groupId } = running();
      autoPassP1(groupId);
      writeFileSync(join(dir, "secret.txt"), "secret");
      const doc = reviewDoc();
      (doc["sections"] as unknown[]).push({ id: "mock", heading: "x", kind: "file", path: "../secret.txt" });
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, doc)}`))).toBe(
        "REVIEW_DOC_INVALID",
      );
    });

    it("resolveHumanReview: waiting_human（human_review）の対象ゲート以外は INVALID_STATE", async () => {
      const { id, groupId, orchestratorId } = running();
      expect(await codeOfAsync(() => service.resolveHumanReview(id, "gate-P1", { decision: "approve" }))).toBe(
        "INVALID_STATE",
      );
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);
      expect(await codeOfAsync(() => service.resolveHumanReview(id, "gate-P3", { decision: "approve" }))).toBe(
        "INVALID_STATE",
      );
      expect(await codeOfAsync(() => service.resolveHumanReview("ws-nope", "gate-P1", { decision: "approve" }))).toBe(
        "NOT_FOUND",
      );
      expect(
        await codeOfAsync(() =>
          service.resolveHumanReview(id, "gate-P1", { decision: "maybe" as unknown as "approve" }),
        ),
      ).toBe("INVALID_REQUEST");
      expect(current(id).status).toBe("waiting_human");
    });

    it("旧 Orchestrator が終了していなければ待ち、残っていれば kill してから再開する", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      // 旧 Orchestrator は終了していない

      await resolveAndResume(id, "gate-P1", { decision: "approve" });
      expect(mockKill).toHaveBeenCalledWith(orchestratorId);
      expect(orchestratorOf(groupId)).not.toBe(orchestratorId);
      expect(current(id).status).toBe("running");
    });
  });

  // ----------------------------------------------------
  // retry（差し戻し上限超過 → 再開）
  // ----------------------------------------------------

  describe("retry", () => {
    async function exceed() {
      const r = running();
      runner.results.set("npm run build", { exitCode: 1 });
      for (let i = 0; i < 3; i++) await service.runGateCheck(r.groupId, "gate-P2");
      expect(current(r.id).status).toBe("waiting_human");
      finish(r.orchestratorId, "success", "差し戻し上限超過で一時停止");
      expect(current(r.id).status).toBe("waiting_human");
      return r;
    }

    it("指示付きで再開し、再開プロンプトに指示が入る。失敗回数は 0 に戻る", async () => {
      const { id, groupId, orchestratorId } = await exceed();

      const out = await retryAndResume(id, { instruction: "build の設定を見直して" });
      expect(out.status).toBe("running");
      expect(out.statusReason).toBeUndefined();

      const second = orchestratorOf(groupId);
      expect(second).not.toBe(orchestratorId);
      const prompt = lastPrompt();
      expect(prompt).toContain("差し戻し上限超過後の再試行");
      expect(prompt).toContain("build の設定を見直して");
      expect(eventsOf("workspace:resumed")).toEqual([
        { workspaceId: id, reason: "retry", orchestratorAgentId: second },
      ]);

      const g = current(id).gateResults.find((x) => x.gateId === "gate-P2")!;
      expect(g.retryInstructions).toEqual([expect.objectContaining({ text: "build の設定を見直して" })]);

      const after = await service.runGateCheck(groupId, "gate-P2");
      expect(after.failedAttempts).toBe(1);
      expect(after.retryLimitExceeded).toBe(false);
      expect(current(id).status).toBe("running");
    });

    it("指示なしでも再開できる（text は空文字）", async () => {
      const { id } = await exceed();
      await retryAndResume(id, {});
      expect(current(id).gateResults.find((x) => x.gateId === "gate-P2")?.retryInstructions[0].text).toBe("");
      expect(current(id).status).toBe("running");
    });

    it("再試行後にもう一度上限超過になれば、再び waiting_human になる", async () => {
      const { id, groupId } = await exceed();
      await retryAndResume(id, { instruction: "もう一度" });
      await service.runGateCheck(groupId, "gate-P2");
      await service.runGateCheck(groupId, "gate-P2");
      const out = await service.runGateCheck(groupId, "gate-P2");
      expect(out.retryLimitExceeded).toBe(true);
      expect(current(id).status).toBe("waiting_human");
      expect(current(id).statusReason?.code).toBe("gate_retry_exceeded");
    });

    it("gate_retry_exceeded でなければ INVALID_STATE", async () => {
      const { id, groupId, orchestratorId } = running();
      expect(await codeOfAsync(() => service.retry(id, {}))).toBe("INVALID_STATE");
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);
      // human_review の waiting_human では retry できない
      expect(await codeOfAsync(() => service.retry(id, {}))).toBe("INVALID_STATE");
      expect(await codeOfAsync(() => service.retry("ws-nope", {}))).toBe("NOT_FOUND");
    });
  });

  // ----------------------------------------------------
  // Orchestrator 完了の判定
  // ----------------------------------------------------

  describe("Orchestrator 完了の判定", () => {
    it("最終ゲート passed 後の success で done + 完了レポート", async () => {
      const { id, groupId, orchestratorId } = running();
      service.reportGateResult(groupId, "gate-final", 0, true);
      finish(
        orchestratorId,
        "success",
        "## 何が実装されたか\n認証ができた\n\n## 試し方\nnpm test\n\n## 確認しておくと良いこと\nなし",
        "完了",
      );
      const ws = current(id);
      expect(ws.status).toBe("done");
      expect(ws.report?.summary).toContain("認証ができた");
      expect(ws.report?.howToTry).toContain("npm test");
      expect(ws.report?.completion.every((c) => c.achieved)).toBe(true);
    });

    it("最終ゲートが未合格のまま success で終了したら failed（orchestrator_failed）", () => {
      const { id, orchestratorId } = running();
      finish(orchestratorId, "success", "終わった", "完了");
      const ws = current(id);
      expect(ws.status).toBe("failed");
      expect(ws.statusReason?.code).toBe("orchestrator_failed");
      expect(ws.statusReason?.message).toContain("最終ゲート");
    });

    it("failure の報告は failed（orchestrator_failed。message に status と errorMessage）", () => {
      const { id, orchestratorId } = running();
      finish(orchestratorId, "failure", "失敗", "失敗", "boom");
      const ws = current(id);
      expect(ws.status).toBe("failed");
      expect(ws.statusReason?.code).toBe("orchestrator_failed");
      expect(ws.statusReason?.message).toContain("failure");
      expect(ws.statusReason?.message).toContain("boom");
    });

    it("結果を報告せずにプロセスが終了したら failed（orchestrator_failed）", () => {
      const { id, orchestratorId } = running();
      manager.updateAgentState(orchestratorId, { status: "running" });
      manager.updateAgentState(orchestratorId, { status: "failed" });
      expect(current(id).status).toBe("failed");
      expect(current(id).statusReason?.code).toBe("orchestrator_failed");
    });

    it("反復が maxIterations に達していれば failed（max_iterations）", () => {
      const { id, groupId, orchestratorId } = running();
      manager.updateProgressLedger(groupId, {
        isRequestSatisfied: { reason: "r", answer: false },
        isInLoop: { reason: "r", answer: false },
        isProgressBeingMade: { reason: "r", answer: true },
        nextAction: { reason: "r", answer: "a" },
        instruction: { reason: "r", answer: "i" },
        iteration: 12,
      });
      finish(orchestratorId, "failure", "上限", "上限に達した");
      expect(current(id).status).toBe("failed");
      expect(current(id).statusReason?.code).toBe("max_iterations");
    });

    it("終了後に旧 Orchestrator の完了イベントが来ても二重には処理しない", () => {
      const { id, groupId, orchestratorId } = running();
      service.reportGateResult(groupId, "gate-final", 0, true);
      finish(orchestratorId);
      expect(current(id).status).toBe("done");
      const updatedAt = current(id).updatedAt;
      manager.emit("agent:completed", manager.getAgent(orchestratorId));
      expect(current(id).updatedAt).toBe(updatedAt);
    });

    it("Orchestrator の完了を待つリスナーは、待ちが無くなれば manager に残らない（Workspace 数に比例して増えない）", () => {
      const a = running();
      const b = running();
      expect(manager.listenerCount("agent:completed")).toBe(1);
      service.reportGateResult(a.groupId, "gate-final", 0, true);
      finish(a.orchestratorId);
      expect(current(a.id).status).toBe("done");
      expect(manager.listenerCount("agent:completed")).toBe(1);
      service.abort(b.id);
      expect(manager.listenerCount("agent:completed")).toBe(0);
    });

    it("Orchestrator 以外の Agent の完了は無視する", () => {
      const { id, groupId } = running();
      const child = manager.createGroup("c", "concurrent", groupId);
      const a = manager.startAgent(child.id, config.roles.find((r) => r.id === "impl-code")!, "x");
      finish(a.agentId, "failure");
      expect(current(id).status).toBe("running");
    });
  });

  // ----------------------------------------------------
  // abort（実行中）
  // ----------------------------------------------------

  describe("abort（実行系）", () => {
    it("running: Orchestrator と子グループの実行中 Agent を kill して aborted（user_abort）", () => {
      const { id, groupId, orchestratorId } = running();
      const child = manager.createGroup("作業", "concurrent", groupId);
      const worker = manager.startAgent(child.id, config.roles.find((r) => r.id === "impl-code")!, "x");
      manager.updateAgentState(worker.agentId, { status: "running" });
      const done = manager.startAgent(child.id, config.roles.find((r) => r.id === "impl-test")!, "x");
      finish(done.agentId); // 完了を報告済み（プロセスが残っていることがあるので停止を試みる）

      const out = service.abort(id);
      expect(out.status).toBe("aborted");
      expect(out.statusReason?.code).toBe("user_abort");
      expect(mockKill).toHaveBeenCalledWith(orchestratorId);
      expect(mockKill).toHaveBeenCalledWith(worker.agentId);
      expect(mockKill).toHaveBeenCalledWith(done.agentId);
      // 完了を報告済みの Agent の状態は変えない
      expect(manager.getAgent(done.agentId)?.status).toBe("resultReported");
    });

    it("abort 後の Orchestrator 完了は Workspace の状態を変えない", () => {
      const { id, groupId, orchestratorId } = running();
      service.reportGateResult(groupId, "gate-final", 0, true);
      service.abort(id);
      finish(orchestratorId, "success");
      expect(current(id).status).toBe("aborted");
    });

    it("waiting_human でも中断できる", async () => {
      const { id, groupId, orchestratorId } = running();
      runner.results.set("npm run build", { exitCode: 1 });
      for (let i = 0; i < 3; i++) await service.runGateCheck(groupId, "gate-P2");
      const out = service.abort(id);
      expect(out.status).toBe("aborted");
      expect(mockKill).toHaveBeenCalledWith(orchestratorId);
    });

    it("done / failed / aborted は INVALID_STATE", () => {
      const { id } = running();
      service.abort(id);
      expect(codeOf(() => service.abort(id))).toBe("INVALID_STATE");
    });
  });

  // ----------------------------------------------------
  // update_ledger との連携
  // ----------------------------------------------------

  describe("applyLedgerUpdate / ackIrregular", () => {
    it("irregular + reason のゲート変更は gateChanges に記録され workspace:irregular を emit する", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      incoming.find((s) => s.stepId === "gate-P3")!.checks = [{ text: "ビルドのみ", method: "command", command: "npm run build" }];

      const out = service.applyLedgerUpdate(groupId, { scheduledSteps: incoming, irregular: true, reason: "全テストは重い" });
      expect(out.scheduledSteps.find((s) => s.stepId === "gate-P3")?.checks?.[0].command).toBe("npm run build");

      const ws = current(id);
      expect(ws.gateChanges).toEqual([
        expect.objectContaining({ id: "gc-1", gateId: "gate-P3", reason: "全テストは重い", after: expect.anything() }),
      ]);
      expect(ws.gateChanges[0].at).toBeDefined();
      expect(ws.gateChanges[0].acknowledgedAt).toBeUndefined();
      expect(eventsOf("workspace:irregular")).toEqual([
        { workspaceId: id, change: expect.objectContaining({ id: "gc-1", gateId: "gate-P3" }) },
      ]);
    });

    it("gateChange の ID は連番", () => {
      const { id, groupId } = running();
      for (const gateId of ["gate-P3", "gate-P2"]) {
        const incoming = structuredClone(steps(groupId));
        incoming.find((s) => s.stepId === gateId)!.role = "text-review";
        service.applyLedgerUpdate(groupId, { scheduledSteps: incoming, irregular: true, reason: "変える" });
        // ツールが行うのと同様に Ledger に反映する
        const ledger = manager.getLedger(groupId)!.taskLedger!;
        manager.updateTaskLedger(groupId, {
          facts: ledger.facts,
          plan: ledger.plan,
          phases: ledger.phases,
          scheduledSteps: incoming,
        });
      }
      expect(current(id).gateChanges.map((c) => c.id)).toEqual(["gc-1", "gc-2"]);
    });

    it("拒否される更新は WorkspaceError（コード付き）で、記録もイベントも出さない", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      incoming.find((s) => s.stepId === "gate-P3")!.role = "text-review";
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { scheduledSteps: incoming }))).toBe("GATE_CHANGE_NOT_ALLOWED");

      const done = structuredClone(steps(groupId));
      done.find((s) => s.stepId === "gate-P3")!.status = "completed";
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { scheduledSteps: done }))).toBe("GATE_PROTECTED");

      const noFinal = structuredClone(steps(groupId)).filter((s) => s.stepId !== "gate-final");
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { scheduledSteps: noFinal, irregular: true, reason: "x" }))).toBe(
        "GATE_PROTECTED",
      );
      expect(current(id).gateChanges).toEqual([]);
      expect(eventsOf("workspace:irregular")).toEqual([]);
    });

    it("追加されたゲートの GateResult を pending で作る", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      incoming.push({
        stepId: "gate-extra",
        role: "code-review",
        description: "追加",
        status: "pending",
        phaseId: "P3",
        kind: "gate",
        checks: [{ text: "x", method: "agent-review" }],
      });
      service.applyLedgerUpdate(groupId, { scheduledSteps: incoming });
      const g = current(id).gateResults.find((x) => x.gateId === "gate-extra");
      expect(g).toMatchObject({ phaseId: "P3", status: "pending", attempts: [] });
      expect(eventsOf("workspace:replanned")).toEqual([
        { workspaceId: id, added: [expect.objectContaining({ stepId: "gate-extra" })], changed: [], removed: [] },
      ]);
    });

    it("deferred フェーズへの手順の追加は workspace:phase_planned、依存は実効依存に正規化される", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      incoming.push({
        stepId: "i1",
        role: "impl-code",
        description: "実装",
        status: "pending",
        phaseId: "P2",
        kind: "work",
        doneCriteria: ["できた"],
      });
      const out = service.applyLedgerUpdate(groupId, { scheduledSteps: incoming });
      expect(out.scheduledSteps.find((s) => s.stepId === "i1")?.dependsOn).toEqual(["gate-P1"]);
      expect(eventsOf("workspace:phase_planned")).toEqual([
        { workspaceId: id, phaseId: "P2", addedSteps: [expect.objectContaining({ stepId: "i1" })] },
      ]);
      expect(eventsOf("workspace:replanned")).toEqual([]);
    });

    it("work Step の変更・削除は workspace:replanned", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId)).filter((s) => s.stepId !== "s4");
      incoming.find((s) => s.stepId === "s3")!.description = "変えた";
      service.applyLedgerUpdate(groupId, { scheduledSteps: incoming });
      expect(eventsOf("workspace:replanned")).toEqual([
        {
          workspaceId: id,
          added: [],
          changed: [expect.objectContaining({ stepId: "s3" })],
          removed: ["s4"],
        },
      ]);
    });

    it("phases だけの更新（scheduledSteps 省略）も検証・正規化する", () => {
      const { groupId } = running();
      const phases = structuredClone(manager.getLedger(groupId)!.taskLedger!.phases!);
      const out = service.applyLedgerUpdate(groupId, { phases });
      expect(out.phases).toEqual(phases);
      expect(out.scheduledSteps).toEqual(steps(groupId));
      const bad = phases.filter((p) => p.id !== "P3");
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { phases: bad }))).toBe("INVALID_PHASES");
    });

    it("非 Workspace グループは NOT_WORKSPACE_GROUP、停止した Workspace は WORKSPACE_NOT_RUNNING", () => {
      const { id, groupId } = running();
      const normal = manager.createGroup("m", "magentic");
      expect(codeOf(() => service.applyLedgerUpdate(normal.id, { scheduledSteps: [] }))).toBe("NOT_WORKSPACE_GROUP");
      service.abort(id);
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { scheduledSteps: steps(groupId) }))).toBe("WORKSPACE_NOT_RUNNING");
    });

    it("ackIrregular: acknowledgedAt を付けて workspace:updated を emit。無ければ NOT_FOUND", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      incoming.find((s) => s.stepId === "gate-P3")!.role = "text-review";
      service.applyLedgerUpdate(groupId, { scheduledSteps: incoming, irregular: true, reason: "x" });

      events.length = 0;
      const out = service.ackIrregular(id, "gc-1");
      expect(out.gateChanges[0].acknowledgedAt).toBeDefined();
      expect(current(id).gateChanges[0].acknowledgedAt).toBeDefined();
      expect(eventsOf("workspace:updated")).toHaveLength(1);

      expect(codeOf(() => service.ackIrregular(id, "gc-99"))).toBe("NOT_FOUND");
      expect(codeOf(() => service.ackIrregular("ws-nope", "gc-1"))).toBe("NOT_FOUND");
    });
  });

  // ----------------------------------------------------
  // レビュー対応（再開の非同期化・合格済みゲート・中断・重複 stepId など）
  // ----------------------------------------------------

  describe("再開は非同期（すぐ返す）", () => {
    it("resolveHumanReview は running にして即座に返し、新しい Orchestrator は非同期で起動する", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);

      const resumed = nextResumed();
      const out = service.resolveHumanReview(id, "gate-P1", { decision: "approve" });
      expect(out.status).toBe("running");
      // この時点では旧 Orchestrator のまま（終了待ちの後で新しい Orchestrator が起動する）
      expect(orchestratorOf(groupId)).toBe(orchestratorId);
      await resumed;
      expect(orchestratorOf(groupId)).not.toBe(orchestratorId);
      expect(current(id).status).toBe("running");
    });

    it("retry も即座に返す", async () => {
      const { id, groupId, orchestratorId } = running();
      runner.results.set("npm run build", { exitCode: 1 });
      for (let i = 0; i < 3; i++) await service.runGateCheck(groupId, "gate-P2");
      finish(orchestratorId);
      const resumed = nextResumed();
      const out = service.retry(id, { instruction: "x" });
      expect(out.status).toBe("running");
      expect(orchestratorOf(groupId)).toBe(orchestratorId);
      await resumed;
      expect(orchestratorOf(groupId)).not.toBe(orchestratorId);
    });

    it("新しい Orchestrator を起動できなければ failed（orchestrator_failed）", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);

      mockExecute.mockImplementationOnce(() => {
        throw new Error("spawn に失敗");
      });
      const out = service.resolveHumanReview(id, "gate-P1", { decision: "approve" });
      expect(out.status).toBe("running");
      await until(() => current(id).status === "failed");
      expect(current(id).statusReason?.code).toBe("orchestrator_failed");
    });

    it("再開の待ち中に中断されたら、新しい Orchestrator は起動しない", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      // 旧 Orchestrator は終了していないので、再開は resumeWait_ms だけ待つ
      const launched = mockExecute.mock.calls.length;
      service.resolveHumanReview(id, "gate-P1", { decision: "approve" });
      service.abort(id);
      await new Promise((r) => setTimeout(r, 80));
      expect(current(id).status).toBe("aborted");
      expect(mockExecute.mock.calls.length).toBe(launched);
      expect(orchestratorOf(groupId)).toBe(orchestratorId);
      expect(eventsOf("workspace:resumed")).toEqual([]);
    });

    it("旧 Orchestrator が report_result 済みでも、プロセスが残っていれば止める", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);
      mockKill.mockClear();
      await resolveAndResume(id, "gate-P1", { decision: "approve" });
      expect(mockKill).toHaveBeenCalledWith(orchestratorId);
    });
  });

  describe("合格済みのゲート（GATE_ALREADY_PASSED）", () => {
    it("passed のゲートへの run_gate_check / report_gate_result は拒否する", async () => {
      const { groupId } = running();
      await service.runGateCheck(groupId, "gate-P2");
      service.reportGateResult(groupId, "gate-final", 0, true);
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-P2"))).toBe("GATE_ALREADY_PASSED");
      expect(codeOf(() => service.reportGateResult(groupId, "gate-final", 0, false))).toBe("GATE_ALREADY_PASSED");
      expect(runner.calls).toHaveLength(1);
      // 結果は書き換わらない
      const g = current(steps(groupId) && manager.getGroup(groupId)!.workspaceId!).gateResults.find((x) => x.gateId === "gate-final");
      expect(g?.status).toBe("passed");
      expect(g?.attempts).toHaveLength(1);
    });

    it("人間レビューで承認されたゲートにも記録できない", async () => {
      const { id, groupId, orchestratorId } = running();
      autoPassP1(groupId);
      service.requestHumanReview(groupId, "gate-P1", `agent:${writerReports(groupId, reviewDoc())}`);
      finish(orchestratorId);
      await resolveAndResume(id, "gate-P1", { decision: "approve" });
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P1", 0, false))).toBe("GATE_ALREADY_PASSED");
    });
  });

  describe("実行中のゲートの command の中断（AbortSignal）", () => {
    it("run_gate_check には AbortSignal を渡し、abort で実行中のコマンドを中断する", async () => {
      const { id, groupId } = running();
      runner.hang.add("npm run build");
      const p = service.runGateCheck(groupId, "gate-P2");
      const outcome = p.then(
        () => "resolved",
        (e: unknown) => (e instanceof WorkspaceError ? e.code : "other"),
      );
      await until(() => runner.calls.length === 1);
      const signal = runner.calls[0].opts.signal;
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);

      service.abort(id);
      expect(signal?.aborted).toBe(true);
      expect(await outcome).toBe("WORKSPACE_NOT_RUNNING");
      // 中断された結果は記録しない
      expect(current(id).gateResults.find((g) => g.gateId === "gate-P2")?.attempts).toEqual([]);
    });

    it("shutdown() で実行中のコマンドを中断し、runner の killAll() を呼ぶ", async () => {
      const { groupId } = running();
      runner.hang.add("npm run build");
      const p = service.runGateCheck(groupId, "gate-P2");
      const outcome = p.then(
        () => "resolved",
        (e: unknown) => (e instanceof WorkspaceError ? e.code : "other"),
      );
      await until(() => runner.calls.length === 1);
      service.shutdown();
      expect(runner.calls[0].opts.signal?.aborted).toBe(true);
      expect(runner.killAllCalls).toBe(1);
      expect(await outcome).toBe("WORKSPACE_NOT_RUNNING");
    });

    it("複数の command の途中で中断されたら、残りは実行しない", async () => {
      const { id, groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [
          { text: "ビルド", method: "command", command: "npm run build" },
          { text: "テスト", method: "command", command: "npm test" },
        ];
      });
      runner.hang.add("npm run build");
      const p = service.runGateCheck(groupId, "gate-P3").catch(() => undefined);
      await until(() => runner.calls.length === 1);
      service.abort(id);
      await p;
      expect(runner.calls.map((c) => c.command)).toEqual(["npm run build"]);
    });
  });

  describe("台帳の防御・イレギュラー・レポート・ReviewDoc の取り込み", () => {
    it("台帳に同じ stepId の Step が重複していたら、最初のものを採らずに DUPLICATE_STEP_ID", async () => {
      const { groupId } = running();
      const ledger = manager.getLedger(groupId)!.taskLedger!;
      const dup = structuredClone(steps(groupId).find((s) => s.stepId === "gate-P2")!);
      dup.checks = [{ text: "弱い", method: "agent-review" }];
      manager.updateTaskLedger(groupId, {
        facts: ledger.facts,
        plan: ledger.plan,
        phases: ledger.phases,
        scheduledSteps: [...steps(groupId), dup],
      });
      expect(await codeOfAsync(() => service.runGateCheck(groupId, "gate-P2"))).toBe("DUPLICATE_STEP_ID");
      expect(codeOf(() => service.reportGateResult(groupId, "gate-P2", 0, true))).toBe("DUPLICATE_STEP_ID");
      expect(runner.calls).toHaveLength(0);
    });

    it("applyLedgerUpdate は incoming の重複 stepId を DUPLICATE_STEP_ID で拒否する", () => {
      const { id, groupId } = running();
      const incoming = structuredClone(steps(groupId));
      const weak = structuredClone(incoming.find((s) => s.stepId === "gate-P1")!);
      weak.checks = [{ text: "弱い", method: "agent-review" }];
      incoming.unshift(weak);
      expect(codeOf(() => service.applyLedgerUpdate(groupId, { scheduledSteps: incoming }))).toBe("DUPLICATE_STEP_ID");
      expect(current(id).gateChanges).toEqual([]);
    });

    it("checks を変えたゲートは GateResult.status を再導出する（passed を維持しない）。台帳のゲートは in_progress に戻る", async () => {
      const { id, groupId } = running();
      await service.runGateCheck(groupId, "gate-P3");
      expect(current(id).gateResults.find((g) => g.gateId === "gate-P3")?.status).toBe("passed");
      expect(stepStatus(groupId, "gate-P3")).toBe("completed");

      const incoming = structuredClone(steps(groupId));
      const gate3 = incoming.find((s) => s.stepId === "gate-P3")!;
      gate3.checks = [...gate3.checks!, { text: "lint", method: "command", command: "npm run lint" }];
      const out = service.applyLedgerUpdate(groupId, { scheduledSteps: incoming, irregular: true, reason: "厳しくする" });

      const g = current(id).gateResults.find((x) => x.gateId === "gate-P3")!;
      expect(g.status).toBe("pending");
      expect(g.attempts).toHaveLength(1); // attempt は残す
      expect(out.scheduledSteps.find((s) => s.stepId === "gate-P3")?.status).toBe("in_progress");
    });

    it("checks を緩めて残りがすべて合格済みなら passed に再導出され、台帳も completed になる", async () => {
      const { id, groupId } = running((p) => {
        p.steps.find((s) => s.id === "gate-P3")!.checks = [
          { text: "レビュー", method: "agent-review" },
          { text: "ビルド", method: "command", command: "npm run build" },
        ];
      });
      runner.results.set("npm run build", { exitCode: 0 });
      await service.runGateCheck(groupId, "gate-P3");
      expect(current(id).gateResults.find((g) => g.gateId === "gate-P3")?.status).toBe("pending");

      const incoming = structuredClone(steps(groupId));
      incoming.find((s) => s.stepId === "gate-P3")!.checks = [{ text: "ビルド", method: "command", command: "npm run build" }];
      const out = service.applyLedgerUpdate(groupId, { scheduledSteps: incoming, irregular: true, reason: "レビューは不要" });
      expect(current(id).gateResults.find((g) => g.gateId === "gate-P3")?.status).toBe("passed");
      expect(out.scheduledSteps.find((s) => s.stepId === "gate-P3")?.status).toBe("completed");
    });

    it("完了レポートの生成に失敗しても done にする（report は省略し、console.error に出す）", () => {
      const { id, groupId, orchestratorId } = running();
      service.reportGateResult(groupId, "gate-final", 0, true);
      vi.mocked(buildWorkspaceReport).mockImplementationOnce(() => {
        throw new Error("レポート生成に失敗");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      finish(orchestratorId, "success", "## 何が実装されたか\nx");
      expect(current(id).status).toBe("done");
      expect(current(id).report).toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("レポート生成に失敗"))).toBe(true);
    });

    it("request_human_review の agent: は status: success の結果だけを受け付ける", () => {
      const { groupId } = running();
      autoPassP1(groupId);
      const child = manager.createGroup("資料", "concurrent", groupId);
      const role = config.roles.find((r) => r.id === "text-writer")!;
      const failed = manager.startAgent(child.id, role, "x");
      finish(failed.agentId, "failure", JSON.stringify(reviewDoc()));
      expect(codeOf(() => service.requestHumanReview(groupId, "gate-P1", `agent:${failed.agentId}`))).toBe(
        "REVIEW_DOC_NOT_FOUND",
      );
    });
  });
});
