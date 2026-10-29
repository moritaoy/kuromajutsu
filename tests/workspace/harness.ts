// ============================================================
// Workspace 実行系のテスト用ハーネス（MCP ツール / HTTP API のテストで共用）
//
// `vi.mock("…/agent/executor.js", …)` は各テストファイルの先頭で行うこと。
// ============================================================

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager.js";
import { WorkspaceStore } from "../../src/workspace/store.js";
import { WorkspaceService } from "../../src/workspace/service.js";
import type {
  GateCommandRunOptions,
  GateCommandRunResult,
  GateCommandRunner,
} from "../../src/workspace/gate-runner.js";
import type { AppConfig, ScheduledStep, WorkPlan, Workspace } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

export const WORK_ROLE_IDS = [
  "research",
  "design",
  "impl-code",
  "impl-test",
  "code-review",
  "text-review",
  "text-writer",
];

export function createRunTestConfig(port = 9696): AppConfig {
  const roles: AppConfig["roles"] = WORK_ROLE_IDS.map((id) => ({
    id,
    name: `職種 ${id}`,
    description: `${id} の説明`,
    provider: "cursor" as const,
    model: "composer-2.5-fast",
    systemPrompt: `あなたは ${id} です。`,
    healthCheckPrompt: "OK",
  }));
  roles.unshift(
    {
      id: "orchestrator",
      name: "オーケストレーター",
      description: "統括",
      provider: "claude",
      model: "claude-fable-5-1",
      systemPrompt: "あなたは Orchestrator です。",
      healthCheckPrompt: "OK",
    },
    {
      id: "planner",
      name: "計画立案者",
      description: "計画を作る",
      provider: "claude",
      model: "opus",
      systemPrompt: "あなたは Planner です。",
      healthCheckPrompt: "OK",
    },
  );
  return {
    dashboard: { port },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1000 },
    log: { level: "info" },
    roles,
  };
}

/** コマンド → 結果 の Map を持つフェイク */
export class FakeGateRunner implements GateCommandRunner {
  results = new Map<string, Partial<GateCommandRunResult>>();
  calls: { command: string; opts: GateCommandRunOptions }[] = [];
  async run(command: string, opts: GateCommandRunOptions): Promise<GateCommandRunResult> {
    this.calls.push({ command, opts });
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

export function reviewDoc(version = 1): Record<string, unknown> {
  return {
    title: "設計レビュー",
    version,
    ...(version >= 2
      ? { previousFeedback: { id: "prev", heading: "前回の指摘への対応", kind: "markdown", body: "直しました" } }
      : {}),
    sections: [{ id: "conclusion", heading: "結論", kind: "markdown", body: "JWT を採用する" }],
  };
}

export interface RunHarness {
  dir: string;
  projDir: string;
  config: AppConfig;
  manager: AgentManager;
  store: WorkspaceStore;
  service: WorkspaceService;
  runner: FakeGateRunner;
  /** 承認済み（running）の Workspace を作る */
  running(mutate?: (plan: WorkPlan) => void): { id: string; groupId: string; orchestratorId: string };
  /** review 状態の Workspace を作る */
  review(mutate?: (plan: WorkPlan) => void): Workspace;
  steps(groupId: string): ScheduledStep[];
  /** Agent を完了させる（report_result 相当） */
  finish(agentId: string, status?: "success" | "failure", response?: string): void;
  /** text-writer が ReviewDoc を報告する。agentId を返す */
  writerReports(groupId: string, doc: unknown): string;
  cleanup(): void;
}

export function createRunHarness(port = 9696): RunHarness {
  const dir = mkdtempSync(join(tmpdir(), "kuromajutsu-harness-"));
  const projDir = join(dir, "proj");
  mkdirSync(projDir);
  const config = createRunTestConfig(port);
  const manager = new AgentManager(config);
  const store = new WorkspaceStore(dir);
  const runner = new FakeGateRunner();
  const service = new WorkspaceService(config, manager, store, {
    gateRunner: runner,
    mermaidRuntime: () => undefined,
    resumeWait_ms: 30,
  });

  const review = (mutate?: (plan: WorkPlan) => void): Workspace => {
    const ws = store.create({ instruction: "認証を追加して", workspacePath: projDir });
    const plan = makeAuthPlan();
    mutate?.(plan);
    return store.update(ws.id, (w) => {
      w.revisions.push(plan);
      w.status = "review";
    });
  };

  const finish = (agentId: string, status: "success" | "failure" = "success", response = "完了"): void => {
    if (manager.getAgent(agentId)?.status === "queued") {
      manager.updateAgentState(agentId, { status: "running" });
    }
    manager.reportResult(agentId, { status, summary: "要約", response });
  };

  return {
    dir,
    projDir,
    config,
    manager,
    store,
    service,
    runner,
    review,
    running(mutate) {
      const ws = review(mutate);
      const approved = service.approve(ws.id);
      const groupId = approved.groupId as string;
      return { id: ws.id, groupId, orchestratorId: manager.getGroup(groupId)?.orchestratorAgentId as string };
    },
    steps: (groupId) => manager.getLedger(groupId)?.taskLedger?.scheduledSteps as ScheduledStep[],
    finish,
    writerReports(groupId, doc) {
      const child = manager.createGroup("レビュー資料の作成", "concurrent", groupId);
      const role = config.roles.find((r) => r.id === "text-writer")!;
      const agent = manager.startAgent(child.id, role, "資料を作って");
      finish(agent.agentId, "success", typeof doc === "string" ? doc : JSON.stringify(doc));
      return agent.agentId;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
