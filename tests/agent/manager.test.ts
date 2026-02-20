// ============================================================
// AgentManager テスト
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager } from "../../src/agent/manager.js";
import type {
  AppConfig,
  AgentState,
  GroupDefinition,
  AgentResult,
  HealthCheckResult,
  MagenticConfig,
} from "../../src/types/index.js";

// --------------------------------------------------
// AgentExecutor のモック
// --------------------------------------------------

vi.mock("../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

// --------------------------------------------------
// テスト用設定
// --------------------------------------------------

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    dashboard: { port: 9696 },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        description: "コードの実装・修正を行う",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
      {
        id: "code-review",
        name: "コードレビュワー",
        description: "コードの品質をレビューする",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
    ...overrides,
  };
}

// ==================================================
// Group 管理テスト
// ==================================================

describe("AgentManager — Group 管理", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("グループを作成できる", () => {
    const group = manager.createGroup("テストグループ");

    expect(group.id).toMatch(/^grp-/);
    expect(group.description).toBe("テストグループ");
    expect(group.status).toBe("active");
    expect(group.mode).toBe("concurrent");
    expect(group.agentIds).toEqual([]);
    expect(group.createdAt).toBeDefined();
  });

  it("createGroup に mode パラメータを渡せること（デフォルト concurrent）", () => {
    const groupDefault = manager.createGroup("デフォルト");
    expect(groupDefault.mode).toBe("concurrent");

    const groupSequential = manager.createGroup("Sequential", "sequential");
    expect(groupSequential.mode).toBe("sequential");
  });

  it("createGroup に parentGroupId を渡した場合、グループに設定される", () => {
    const parentGroup = manager.createGroup("親グループ", "magentic");
    const childGroup = manager.createGroup("子グループ", "concurrent", parentGroup.id);

    expect(childGroup.parentGroupId).toBe(parentGroup.id);
    expect(parentGroup.parentGroupId).toBeUndefined();
  });

  it("グループを取得できる", () => {
    const created = manager.createGroup("test");
    const fetched = manager.getGroup(created.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it("存在しないグループを取得すると undefined を返す", () => {
    const result = manager.getGroup("nonexistent");
    expect(result).toBeUndefined();
  });

  it("グループを削除できる（status を deleted に変更）", () => {
    const group = manager.createGroup("to delete");
    const agent = manager.startAgent(group.id, config.roles[0], "test");
    manager.deleteGroup(group.id);

    const deleted = manager.getGroup(group.id);
    expect(deleted!.status).toBe("deleted");
    expect(manager.getAgent(agent.agentId)).toBeDefined();
  });

  it("Agent のない削除済みグループは groups Map から除去される", () => {
    const group = manager.createGroup("empty group");
    manager.deleteGroup(group.id);

    expect(manager.getGroup(group.id)).toBeUndefined();
  });

  it("存在しないグループの削除はエラーを投げる", () => {
    expect(() => manager.deleteGroup("nonexistent")).toThrow();
  });

  it("削除済みグループの再削除はエラーを投げる", () => {
    const group = manager.createGroup("to delete");
    manager.deleteGroup(group.id);
    expect(() => manager.deleteGroup(group.id)).toThrow();
  });

  it("グループ作成時に group:created イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("group:created", handler);

    const group = manager.createGroup("test");

    expect(handler).toHaveBeenCalledWith(group);
  });

  it("グループ削除時に group:deleted イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("group:deleted", handler);

    const group = manager.createGroup("test");
    manager.deleteGroup(group.id);

    expect(handler).toHaveBeenCalledWith({ groupId: group.id });
  });

  it("グループ削除後もグループに属する Agent は履歴として保持される", () => {
    const config = createTestConfig();
    const mgr = new AgentManager(config);
    const group = mgr.createGroup("test");
    const a1 = mgr.startAgent(group.id, config.roles[0], "test1");
    const a2 = mgr.startAgent(group.id, config.roles[1], "test2");

    expect(mgr.getAgent(a1.agentId)).toBeDefined();
    expect(mgr.getAgent(a2.agentId)).toBeDefined();
    expect(mgr.listAgents()).toHaveLength(2);

    mgr.deleteGroup(group.id);

    expect(mgr.getAgent(a1.agentId)).toBeDefined();
    expect(mgr.getAgent(a2.agentId)).toBeDefined();
    expect(mgr.listAgents()).toHaveLength(2);
  });

  it("グループ削除時に他のグループの Agent は影響を受けない", () => {
    const config = createTestConfig();
    const mgr = new AgentManager(config);
    const group1 = mgr.createGroup("group1");
    const group2 = mgr.createGroup("group2");
    const a1 = mgr.startAgent(group1.id, config.roles[0], "test1");
    const a2 = mgr.startAgent(group2.id, config.roles[1], "test2");

    mgr.deleteGroup(group1.id);

    expect(mgr.getAgent(a1.agentId)).toBeDefined();
    expect(mgr.getAgent(a2.agentId)).toBeDefined();
    expect(mgr.listAgents()).toHaveLength(2);
  });

  it("削除済みグループの Agent が20件を超えた場合に古いものがトリムされる", () => {
    const largeConfig = createTestConfig({
      agent: { maxConcurrent: 100 },
    });
    const mgr = new AgentManager(largeConfig);

    for (let i = 0; i < 25; i++) {
      const group = mgr.createGroup(`batch-${i}`);
      const agent = mgr.startAgent(group.id, largeConfig.roles[0], `task-${i}`);
      const agentState = mgr.getAgent(agent.agentId)!;
      agentState.startedAt = new Date(Date.now() - (25 - i) * 60000).toISOString();
      mgr.updateAgentState(agent.agentId, { status: "running" });
      mgr.updateAgentState(agent.agentId, { status: "completed" });
      mgr.deleteGroup(group.id);
    }

    expect(mgr.listAgents()).toHaveLength(20);
  });

  it("Magentic グループ削除時に子グループも連鎖的に削除される", () => {
    const config = createTestConfig();
    const mgr = new AgentManager(config);

    const magenticGroup = mgr.createGroup("Magentic親", "magentic");
    const childGroup1 = mgr.createGroup("子1", "concurrent", magenticGroup.id);
    const childGroup2 = mgr.createGroup("子2", "concurrent", magenticGroup.id);

    const deletedIds: string[] = [];
    mgr.on("group:deleted", ({ groupId }) => {
      deletedIds.push(groupId);
    });

    mgr.deleteGroup(magenticGroup.id);

    expect(deletedIds).toContain(magenticGroup.id);
    expect(deletedIds).toContain(childGroup1.id);
    expect(deletedIds).toContain(childGroup2.id);
    expect(deletedIds).toHaveLength(3);
  });

  it("トリミングで他グループの Agent は影響を受けない", () => {
    const largeConfig = createTestConfig({
      agent: { maxConcurrent: 100 },
    });
    const mgr = new AgentManager(largeConfig);

    const activeGroup = mgr.createGroup("active-group");
    const activeAgent = mgr.startAgent(activeGroup.id, largeConfig.roles[0], "active-task");

    for (let i = 0; i < 25; i++) {
      const group = mgr.createGroup(`batch-${i}`);
      const agent = mgr.startAgent(group.id, largeConfig.roles[0], `task-${i}`);
      mgr.updateAgentState(agent.agentId, { status: "running" });
      mgr.updateAgentState(agent.agentId, { status: "completed" });
      mgr.deleteGroup(group.id);
    }

    expect(mgr.getAgent(activeAgent.agentId)).toBeDefined();
    const deletedGroupAgents = mgr.listAgents().filter(
      (a) => a.groupId !== activeGroup.id,
    );
    expect(deletedGroupAgents).toHaveLength(20);
    expect(mgr.listAgents()).toHaveLength(21);
  });
});

// ==================================================
// Agent 基本管理テスト
// ==================================================

describe("AgentManager — Agent 基本管理", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("Agent を起動できる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(
      group.id,
      config.roles[0],
      "Hello world",
    );

    expect(agent.agentId).toMatch(/^impl-code-/);
    expect(agent.groupId).toBe(group.id);
    expect(agent.role).toBe("impl-code");
    expect(agent.model).toBe("claude-4-sonnet");
    expect(agent.status).toBe("queued");
    expect(agent.toolCallCount).toBe(0);
    expect(agent.recentToolCalls).toEqual([]);
    expect(agent.editedFiles).toEqual([]);
    expect(agent.createdFiles).toEqual([]);
  });

  it("Agent 起動時にユーザープロンプトが保存される", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(
      group.id,
      config.roles[0],
      "hoge1.md を編集してください",
    );

    expect(agent.prompt).toBe("hoge1.md を編集してください");
  });

  it("Agent の prompt が WebSocket 経由で配信される（agent:created イベント）", () => {
    const handler = vi.fn();
    manager.on("agent:created", handler);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(
      group.id,
      config.roles[0],
      "テストプロンプト内容",
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.agentId,
        prompt: "テストプロンプト内容",
      }),
    );
  });

  it("Agent 起動でグループの agentIds に追加される", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    const updated = manager.getGroup(group.id);
    expect(updated!.agentIds).toContain(agent.agentId);
  });

  it("存在しないグループに Agent を起動するとエラー", () => {
    expect(() =>
      manager.startAgent("nonexistent", config.roles[0], "test"),
    ).toThrow();
  });

  it("削除済みグループに Agent を起動するとエラー", () => {
    const group = manager.createGroup("test");
    manager.deleteGroup(group.id);

    expect(() =>
      manager.startAgent(group.id, config.roles[0], "test"),
    ).toThrow();
  });

  it("Agent の状態を取得できる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    const fetched = manager.getAgent(agent.agentId);
    expect(fetched).toBeDefined();
    expect(fetched!.agentId).toBe(agent.agentId);
  });

  it("存在しない Agent の取得は undefined を返す", () => {
    expect(manager.getAgent("nonexistent")).toBeUndefined();
  });

  it("Agent 一覧を取得できる", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "test1");
    manager.startAgent(group.id, config.roles[1], "test2");

    const agents = manager.listAgents();
    expect(agents).toHaveLength(2);
  });

  it("groupId でフィルタした Agent 一覧を取得できる", () => {
    const group1 = manager.createGroup("g1");
    const group2 = manager.createGroup("g2");
    manager.startAgent(group1.id, config.roles[0], "test1");
    manager.startAgent(group2.id, config.roles[1], "test2");

    const agents = manager.listAgents({ groupId: group1.id });
    expect(agents).toHaveLength(1);
    expect(agents[0].groupId).toBe(group1.id);
  });

  it("status でフィルタした Agent 一覧を取得できる", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "test1");
    manager.startAgent(group.id, config.roles[1], "test2");

    const agents = manager.listAgents({ status: "queued" });
    expect(agents).toHaveLength(2);

    const running = manager.listAgents({ status: "running" });
    expect(running).toHaveLength(0);
  });

  it("グループに所属する Agent を取得できる", () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");
    const a2 = manager.startAgent(group.id, config.roles[1], "test2");

    const agents = manager.getAgentsByGroup(group.id);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.agentId)).toContain(a1.agentId);
    expect(agents.map((a) => a.agentId)).toContain(a2.agentId);
  });

  it("getRunningCount は queued + running の Agent 数を返す", () => {
    const group = manager.createGroup("test");
    manager.startAgent(group.id, config.roles[0], "test1");
    manager.startAgent(group.id, config.roles[1], "test2");

    // 初期状態は queued なので 2
    expect(manager.getRunningCount()).toBe(2);
  });

  it("maxConcurrent 超過時にエラーを投げる", () => {
    const smallConfig = createTestConfig({
      agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1 },
    });
    const mgr = new AgentManager(smallConfig);
    const group = mgr.createGroup("test");

    mgr.startAgent(group.id, smallConfig.roles[0], "test1");

    expect(() =>
      mgr.startAgent(group.id, smallConfig.roles[0], "test2"),
    ).toThrow(/maxConcurrent/i);
  });

  it("Agent 起動時に agent:created イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("agent:created", handler);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    expect(handler).toHaveBeenCalledWith(agent);
  });

  it("startAgents で複数 Agent が一括起動される", () => {
    const group = manager.createGroup("test");
    const tasks = [
      { role: "impl-code", prompt: "タスク1" },
      { role: "code-review", prompt: "タスク2" },
    ];
    const agents = manager.startAgents(group.id, tasks);

    expect(agents).toHaveLength(2);
    expect(agents[0].role).toBe("impl-code");
    expect(agents[1].role).toBe("code-review");
    expect(manager.getAgentsByGroup(group.id)).toHaveLength(2);
  });

  it("startAgents で mode が concurrent でないグループにはエラーになる", () => {
    const group = manager.createGroup("test", "sequential");

    expect(() =>
      manager.startAgents(group.id, [
        { role: "impl-code", prompt: "タスク" },
      ]),
    ).toThrow(/concurrent ではありません/);
  });
});

// ==================================================
// submitSequential / Sequential 実行テスト
// ==================================================

describe("AgentManager — submitSequential / Sequential", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("submitSequential でステージ制の計画が登録される", () => {
    const group = manager.createGroup("test", "sequential");
    const { plan } = manager.submitSequential(group.id, [
      { tasks: [{ role: "impl-code", prompt: "Stage 0" }] },
      { tasks: [{ role: "code-review", prompt: "Stage 1" }] },
    ]);

    expect(plan.stages).toHaveLength(2);
    expect(plan.currentStageIndex).toBe(0);
    expect(plan.stages[0].agentIds).toHaveLength(1);
    expect(plan.stages[1].agentIds).toHaveLength(1);
    expect(manager.getSequentialPlan(group.id)).toEqual(plan);
  });

  it("submitSequential で Stage 0 の Agent のみ実行が開始される", () => {
    const group = manager.createGroup("test", "sequential");
    const { agents } = manager.submitSequential(group.id, [
      { tasks: [{ role: "impl-code", prompt: "Stage 0" }] },
      { tasks: [{ role: "code-review", prompt: "Stage 1" }] },
    ]);

    const stage0Agent = agents.find((a) => a.stageIndex === 0)!;
    const stage1Agent = agents.find((a) => a.stageIndex === 1)!;

    expect(stage0Agent.pid).toBeDefined();
    expect(stage1Agent.pid).toBeUndefined();
    expect(stage1Agent.status).toBe("queued");
  });

  it("Sequential の Agent 完了時にステージが進行すること", () => {
    const group = manager.createGroup("test", "sequential");
    const { agents } = manager.submitSequential(group.id, [
      { tasks: [{ role: "impl-code", prompt: "Stage 0" }] },
      { tasks: [{ role: "code-review", prompt: "Stage 1" }] },
    ]);

    const stage0Agent = agents.find((a) => a.stageIndex === 0)!;
    const stage1Agent = agents.find((a) => a.stageIndex === 1)!;

    manager.updateAgentState(stage0Agent.agentId, { status: "running" });
    manager.updateAgentState(stage0Agent.agentId, { status: "completed" });

    const updatedStage1 = manager.getAgent(stage1Agent.agentId);
    expect(updatedStage1!.pid).toBeDefined();
    expect(updatedStage1!.status).toBe("queued");
  });

  it("前ステージの結果が次ステージのプロンプトに注入されること", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockExecute = (manager as any).executor.execute as ReturnType<typeof vi.fn>;

    const group = manager.createGroup("test", "sequential");
    const { agents } = manager.submitSequential(group.id, [
      { tasks: [{ role: "impl-code", prompt: "Stage 0" }] },
      { tasks: [{ role: "code-review", prompt: "Stage 1" }] },
    ]);

    const stage0Agent = agents.find((a) => a.stageIndex === 0)!;
    const stage1Agent = agents.find((a) => a.stageIndex === 1)!;

    mockExecute.mockClear();
    manager.updateAgentState(stage0Agent.agentId, { status: "running" });
    manager.reportResult(stage0Agent.agentId, {
      status: "success",
      summary: "Stage0 完了サマリ",
      response: "Stage0 の詳細レポートです",
    });

    const stage1Calls = mockExecute.mock.calls.filter(
      (call: [string, unknown]) => call[0] === stage1Agent.agentId,
    );
    expect(stage1Calls.length).toBeGreaterThan(0);
    const prompt = stage1Calls[0][1] as { prompt?: string };
    expect(prompt.prompt).toContain("前ステージの実行結果");
    expect(prompt.prompt).toContain("Stage0 完了サマリ");
    expect(prompt.prompt).toContain("Stage0 の詳細レポートです");
  });

  it("maxConcurrent 超過時は次ステージの起動を保留し currentStageIndex をロールバックする", () => {
    const smallConfig = createTestConfig({ agent: { maxConcurrent: 3 } });
    const mgr = new AgentManager(smallConfig);

    // 他グループで 2 Agent を running にしておく
    const groupA = mgr.createGroup("groupA");
    const a1 = mgr.startAgent(groupA.id, smallConfig.roles[0], "task1");
    const a2 = mgr.startAgent(groupA.id, smallConfig.roles[1], "task2");
    mgr.updateAgentState(a1.agentId, { status: "running" });
    mgr.updateAgentState(a2.agentId, { status: "running" });

    const groupB = mgr.createGroup("groupB", "sequential");
    const { agents } = mgr.submitSequential(groupB.id, [
      { tasks: [{ role: "impl-code", prompt: "Stage 0" }] },
      { tasks: [{ role: "code-review", prompt: "Stage 1" }] },
    ]);

    const stage0Agent = agents.find((a) => a.stageIndex === 0)!;
    const stage1Agent = agents.find((a) => a.stageIndex === 1)!;

    mgr.updateAgentState(stage0Agent.agentId, { status: "running" });
    mgr.reportResult(stage0Agent.agentId, {
      status: "success",
      summary: "Stage0 done",
      response: "Stage0 response",
    });

    // running=3 (a1,a2 running + stage1 queued), nextStageSize=1 → 3+1>3 で保留
    const plan = mgr.getSequentialPlan(groupB.id);
    expect(plan!.currentStageIndex).toBe(0);
    expect(mgr.getAgent(stage1Agent.agentId)!.status).toBe("queued");
  });

  it("submitSequential で workingDirectory と timeout_ms を指定した場合 AgentState に保存され executor に渡される", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockExecute = (manager as any).executor.execute as ReturnType<typeof vi.fn>;

    const group = manager.createGroup("test", "sequential");
    const { agents } = manager.submitSequential(group.id, [
      {
        tasks: [
          {
            role: "impl-code",
            prompt: "Stage 0",
            workingDirectory: "/path/to/work",
            timeout_ms: 60_000,
          },
        ],
      },
    ]);

    const stage0Agent = agents.find((a) => a.stageIndex === 0)!;
    expect(stage0Agent.workingDirectory).toBe("/path/to/work");
    expect(stage0Agent.timeout_ms).toBe(60_000);

    const lastCall = mockExecute.mock.calls.find(
      (call: [string, unknown]) => call[0] === stage0Agent.agentId,
    );
    expect(lastCall).toBeDefined();
    const options = lastCall[1] as { workingDirectory?: string; timeout_ms?: number };
    expect(options.workingDirectory).toBe("/path/to/work");
    expect(options.timeout_ms).toBe(60_000);
  });
});

// ==================================================
// 状態更新テスト
// ==================================================

describe("AgentManager — 状態更新", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("Agent の状態を部分更新できる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, {
      status: "running",
      lastAssistantMessage: "Working on it...",
    });

    const updated = manager.getAgent(agent.agentId);
    expect(updated!.status).toBe("running");
    expect(updated!.lastAssistantMessage).toBe("Working on it...");
  });

  it("状態更新時に agent:status_update イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("agent:status_update", handler);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, {
      toolCallCount: 5,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.agentId,
        toolCallCount: 5,
      }),
    );
  });

  it("存在しない Agent の状態更新は無視する", () => {
    // エラーを投げない
    manager.updateAgentState("nonexistent", { status: "running" });
  });

  it("正常な状態遷移: queued → running → completed", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    expect(manager.getAgent(agent.agentId)!.status).toBe("running");

    manager.updateAgentState(agent.agentId, { status: "completed" });
    expect(manager.getAgent(agent.agentId)!.status).toBe("completed");
  });

  it("不正な状態遷移は無視する: completed → running", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    // completed → running は不正遷移
    manager.updateAgentState(agent.agentId, { status: "running" });
    expect(manager.getAgent(agent.agentId)!.status).toBe("completed");
  });

  it("Agent 完了時に agent:completed イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("agent:completed", handler);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: agent.agentId, status: "completed" }),
    );
  });

  it("resultReported 状態で completed への遷移が来てもステータスは変わらない", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // running → resultReported（Agent 自身が report_result を呼ぶ正常フロー）
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.reportResult(agent.agentId, {
      status: "success",
      summary: "done",
      response: "レポート",
    });
    expect(manager.getAgent(agent.agentId)!.status).toBe("resultReported");

    // stream-json の result イベント到着相当: completed + elapsed_ms を設定
    manager.updateAgentState(agent.agentId, {
      status: "completed",
      elapsed_ms: 12345,
    });

    // ステータスは resultReported のまま、elapsed_ms は更新される
    const updated = manager.getAgent(agent.agentId)!;
    expect(updated.status).toBe("resultReported");
    expect(updated.elapsed_ms).toBe(12345);
  });

  it("getRunningCount は completed の Agent を含めない", () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");
    manager.startAgent(group.id, config.roles[1], "test2");

    expect(manager.getRunningCount()).toBe(2);

    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "completed" });

    expect(manager.getRunningCount()).toBe(1);
  });
});

// ==================================================
// waitForAgents テスト
// ==================================================

describe("AgentManager — waitForAgents", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("mode=all: 全 Agent 完了で resolve", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");
    const a2 = manager.startAgent(group.id, config.roles[1], "test2");

    const promise = manager.waitForAgents([a1.agentId, a2.agentId], "all");

    // 1つ目を完了
    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "completed" });

    // 2つ目を完了
    manager.updateAgentState(a2.agentId, { status: "running" });
    manager.updateAgentState(a2.agentId, { status: "completed" });

    const result = await promise;
    expect(result.completed).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
    expect(result.timedOut).toBe(false);
  });

  it("mode=any: いずれか完了で resolve", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");
    const a2 = manager.startAgent(group.id, config.roles[1], "test2");

    const promise = manager.waitForAgents([a1.agentId, a2.agentId], "any");

    // 1つだけ完了
    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "completed" });

    const result = await promise;
    expect(result.completed.length).toBeGreaterThanOrEqual(1);
    expect(result.timedOut).toBe(false);
  });

  it("既に完了している Agent は即座に返る (mode=all)", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");

    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "completed" });

    const result = await manager.waitForAgents([a1.agentId], "all");
    expect(result.completed).toHaveLength(1);
    expect(result.timedOut).toBe(false);
  });

  it("既に完了している Agent が含まれる場合 (mode=any)", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");
    const a2 = manager.startAgent(group.id, config.roles[1], "test2");

    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "completed" });

    const result = await manager.waitForAgents([a1.agentId, a2.agentId], "any");
    expect(result.completed.length).toBeGreaterThanOrEqual(1);
    expect(result.timedOut).toBe(false);
  });

  it("timeout_ms 超過で timedOut=true を返す", async () => {
    vi.useFakeTimers();

    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");

    const promise = manager.waitForAgents([a1.agentId], "all", 5000);

    // タイムアウト到達
    vi.advanceTimersByTime(5001);

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.pending).toHaveLength(1);

    vi.useRealTimers();
  });

  it("failed ステータスも完了として扱う", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");

    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "failed" });

    const result = await manager.waitForAgents([a1.agentId], "all");
    expect(result.completed).toHaveLength(1);
  });

  it("timedOut ステータスも完了として扱う", async () => {
    const group = manager.createGroup("test");
    const a1 = manager.startAgent(group.id, config.roles[0], "test1");

    manager.updateAgentState(a1.agentId, { status: "running" });
    manager.updateAgentState(a1.agentId, { status: "timedOut" });

    const result = await manager.waitForAgents([a1.agentId], "all");
    expect(result.completed).toHaveLength(1);
  });
});

// ==================================================
// reportResult テスト
// ==================================================

describe("AgentManager — reportResult", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("結果を登録できる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = manager.reportResult(agent.agentId, {
      status: "success",
      summary: "All good",
      response: "実装を完了した。全テストがパスしている。",
    });

    expect(result.agentId).toBe(agent.agentId);
    expect(result.status).toBe("success");
    expect(result.summary).toBe("All good");
    expect(result.response).toBe("実装を完了した。全テストがパスしている。");
    expect(result.groupId).toBe(group.id);
  });

  it("結果登録でステータスが resultReported に遷移する", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    manager.reportResult(agent.agentId, {
      status: "success",
      summary: "done",
      response: "詳細レポート",
    });

    expect(manager.getAgent(agent.agentId)!.status).toBe("resultReported");
  });

  it("自動収集データ（editedFiles, createdFiles, toolCallCount）がマージされる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // 自動収集データをシミュレート
    manager.updateAgentState(agent.agentId, {
      status: "running",
      toolCallCount: 5,
      editedFiles: ["src/a.ts", "src/b.ts"],
      createdFiles: ["src/c.ts"],
    });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = manager.reportResult(agent.agentId, {
      status: "success",
      summary: "done",
      response: "ファイルマージの確認用レポート",
      editedFiles: ["src/d.ts"],
      createdFiles: ["src/e.ts"],
    });

    // 自動収集と手動レポートがマージされる
    expect(result.editedFiles).toContain("src/a.ts");
    expect(result.editedFiles).toContain("src/b.ts");
    expect(result.editedFiles).toContain("src/d.ts");
    expect(result.createdFiles).toContain("src/c.ts");
    expect(result.createdFiles).toContain("src/e.ts");
    expect(result.toolCallCount).toBe(5);
  });

  it("重複ファイルは排除される", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, {
      status: "running",
      editedFiles: ["src/a.ts"],
    });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = manager.reportResult(agent.agentId, {
      status: "success",
      summary: "done",
      response: "重複排除の確認用レポート",
      editedFiles: ["src/a.ts"],
    });

    expect(result.editedFiles.filter((f) => f === "src/a.ts")).toHaveLength(1);
  });

  it("存在しない Agent への reportResult はエラー", () => {
    expect(() =>
      manager.reportResult("nonexistent", {
        status: "success",
        summary: "done",
        response: "レポート",
      }),
    ).toThrow();
  });

  it("queued の Agent への reportResult はエラー", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // queued 状態ではエラー（mockExecutor により status は queued のまま）
    expect(() =>
      manager.reportResult(agent.agentId, {
        status: "success",
        summary: "done",
        response: "レポート",
      }),
    ).toThrow();
  });

  it("running の Agent への reportResult は受け付ける（Agent 自身が実行中に MCP 経由で呼ぶケース）", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // running 状態に遷移
    manager.updateAgentState(agent.agentId, { status: "running" });

    // running 状態で report_result を呼べる
    const result = manager.reportResult(agent.agentId, {
      status: "success",
      summary: "Agent 自身が実行中に報告",
      response: "実行中に呼ばれた場合の詳細レポート",
    });

    expect(result.agentId).toBe(agent.agentId);
    expect(result.status).toBe("success");
    expect(result.summary).toBe("Agent 自身が実行中に報告");
    expect(manager.getAgent(agent.agentId)!.status).toBe("resultReported");
  });

  it("結果登録時に agent:result_reported イベントが emit される", () => {
    const handler = vi.fn();
    manager.on("agent:result_reported", handler);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = manager.reportResult(agent.agentId, {
      status: "success",
      summary: "done",
      response: "イベント発火確認用レポート",
    });

    expect(handler).toHaveBeenCalledWith(result);
  });
});

// ==================================================
// buildFullPrompt テスト
// ==================================================

describe("AgentManager — buildFullPrompt", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("プロンプトに agentId が注入される", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", "テスト");

    expect(prompt).toContain("impl-code-123-abcd");
  });

  it("プロンプトに groupId が注入される", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-456-efgh", "テスト");

    expect(prompt).toContain("grp-456-efgh");
  });

  it("プロンプトに role.id が注入される", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", "テスト");

    expect(prompt).toContain("Role: impl-code");
  });

  it("プロンプトに report_result の呼び出し指示が含まれる", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", "テスト");

    expect(prompt).toContain("report_result");
    expect(prompt).toContain('agentId: "impl-code-123-abcd"');
  });

  it("プロンプトにロールの systemPrompt が含まれる", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", "テスト");

    expect(prompt).toContain(role.systemPrompt);
  });

  it("プロンプトにユーザープロンプトが含まれる", () => {
    const role = config.roles[0];
    const userPrompt = "src/index.ts を修正してください";
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", userPrompt);

    expect(prompt).toContain(userPrompt);
  });

  it("プロンプトの構造: systemPrompt → メタデータブロック → userPrompt の順", () => {
    const role = config.roles[0];
    const userPrompt = "ユーザータスク指示";
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", userPrompt);

    const systemPromptIdx = prompt.indexOf(role.systemPrompt);
    const metadataIdx = prompt.indexOf("kuromajutsu システム情報");
    const userPromptIdx = prompt.indexOf(userPrompt);

    expect(systemPromptIdx).toBeLessThan(metadataIdx);
    expect(metadataIdx).toBeLessThan(userPromptIdx);
  });

  it("プロンプトに response フィールドのガイドラインが含まれる", () => {
    const role = config.roles[0];
    const prompt = manager.buildFullPrompt(role, "impl-code-123-abcd", "grp-123-abcd", "テスト");

    expect(prompt).toContain("response:");
    expect(prompt).toContain("response のガイドライン");
    expect(prompt).toContain("実施内容");
    expect(prompt).toContain("成果・変更点");
    expect(prompt).toContain("判断や選択の理由");
  });

  it("buildFullPrompt に previousStageResults を渡すと結果ブロックが含まれる", () => {
    const role = config.roles[0];
    const previousStageResults: AgentResult[] = [
      {
        agentId: "impl-code-111-aaaa",
        groupId: "grp-123",
        status: "success",
        summary: "前ステージのサマリ",
        response: "前ステージの詳細レポート本文",
        editedFiles: [],
        createdFiles: [],
        duration_ms: 100,
        model: "claude-4-sonnet",
        role: "impl-code",
        toolCallCount: 2,
        timestamp: new Date().toISOString(),
      },
    ];

    const prompt = manager.buildFullPrompt(
      role,
      "impl-code-222-bbbb",
      "grp-123",
      "ユーザータスク",
      previousStageResults,
    );

    expect(prompt).toContain("前ステージの実行結果");
    expect(prompt).toContain("前ステージのサマリ");
    expect(prompt).toContain("前ステージの詳細レポート本文");
    expect(prompt).toContain("ユーザータスク");
  });

  it("Agent 起動時に executor に渡されるプロンプトにメタデータが含まれる", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockExecute = (manager as any).executor.execute as ReturnType<typeof vi.fn>;

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "Hello world");

    // executor.execute の第2引数（options）の prompt を検証
    const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1];
    const options = lastCall[1];
    expect(options.prompt).toContain(agent.agentId);
    expect(options.prompt).toContain(group.id);
    expect(options.prompt).toContain("report_result");
    expect(options.prompt).toContain("Hello world");
    expect(options.prompt).toContain("kuromajutsu システム情報");
  });
});

// ==================================================
// Magentic グループ管理テスト
// ==================================================

describe("AgentManager — Magentic グループ管理", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("setMagenticConfig / getMagenticConfig で Magentic 設定を登録・取得できる", () => {
    const group = manager.createGroup("Magenticテスト", "magentic");
    const magenticConfig: MagenticConfig = {
      task: "認証機能を実装する",
      completionCriteria: "全テストがパスすること",
      scope: "src/auth/",
      availableRoles: ["impl-code", "code-review"],
      maxIterations: 5,
      currentIteration: 0,
    };

    manager.setMagenticConfig(group.id, magenticConfig);

    const fetched = manager.getMagenticConfig(group.id);
    expect(fetched).toBeDefined();
    expect(fetched!.task).toBe("認証機能を実装する");
    expect(fetched!.completionCriteria).toBe("全テストがパスすること");
    expect(fetched!.availableRoles).toEqual(["impl-code", "code-review"]);
    expect(fetched!.maxIterations).toBe(5);
  });

  it("getMagenticConfig は未登録のグループでは undefined を返す", () => {
    const group = manager.createGroup("通常グループ");
    expect(manager.getMagenticConfig(group.id)).toBeUndefined();
  });

  it("startMagenticOrchestrator で Orchestrator Agent が起動し orchestratorAgentId が設定される", () => {
    const orchestratorRole = {
      id: "orchestrator",
      name: "オーケストレーター",
      description: "タスクを自律管理する",
      model: "claude-4-sonnet",
      systemPrompt: "You are an orchestrator.",
      healthCheckPrompt: "OK",
    };
    const cfg = createTestConfig({
      roles: [...createTestConfig().roles, orchestratorRole],
    });
    const mgr = new AgentManager(cfg);

    const group = mgr.createGroup("Magenticグループ", "magentic");
    const magenticCfg: MagenticConfig = {
      task: "タスク",
      completionCriteria: "完了条件",
      scope: "範囲",
      availableRoles: ["impl-code"],
      maxIterations: 3,
      currentIteration: 0,
    };
    const prompt = mgr.buildMagenticOrchestratorPrompt(
      orchestratorRole,
      "orchestrator-123-xxxx",
      group.id,
      magenticCfg,
    );

    const agent = mgr.startMagenticOrchestrator(
      group.id,
      orchestratorRole,
      prompt,
    );

    expect(agent.agentId).toMatch(/^orchestrator-/);
    expect(agent.groupId).toBe(group.id);
    expect(mgr.getGroup(group.id)!.orchestratorAgentId).toBe(agent.agentId);
  });

  it("startMagenticOrchestrator で group:updated イベントが emit される", () => {
    const orchestratorRole = {
      id: "orchestrator",
      name: "オーケストレーター",
      description: "タスクを自律管理する",
      model: "claude-4-sonnet",
      systemPrompt: "You are an orchestrator.",
      healthCheckPrompt: "OK",
    };
    const cfg = createTestConfig({
      roles: [...createTestConfig().roles, orchestratorRole],
    });
    const mgr = new AgentManager(cfg);
    const group = mgr.createGroup("Magenticグループ", "magentic");

    const listener = vi.fn();
    mgr.on("group:updated", listener);

    const agent = mgr.startMagenticOrchestrator(
      group.id,
      orchestratorRole,
      "テストプロンプト",
    );

    expect(listener).toHaveBeenCalledTimes(1);
    const emittedGroup = listener.mock.calls[0][0];
    expect(emittedGroup.id).toBe(group.id);
    expect(emittedGroup.orchestratorAgentId).toBe(agent.agentId);
  });

  it("startMagenticOrchestrator は magentic でないグループではエラー", () => {
    const group = manager.createGroup("通常グループ");
    const role = config.roles[0];
    const prompt = "dummy";

    expect(() =>
      manager.startMagenticOrchestrator(group.id, role, prompt),
    ).toThrow(/magentic ではありません/);
  });

  it("buildMagenticOrchestratorPrompt で 7 層構造のプロンプトが構築される", () => {
    const role = config.roles[0];
    const agentId = "impl-code-123-abcd";
    const groupId = "grp-456-efgh";
    const magenticConfig: MagenticConfig = {
      task: "認証機能を実装せよ",
      completionCriteria: "全単体テストがパスすること",
      scope: "src/auth/ ディレクトリ内",
      constraints: "既存 API を破壊しないこと",
      context: "JWT を使用する",
      availableRoles: ["impl-code", "code-review"],
      maxIterations: 5,
      currentIteration: 0,
    };

    const prompt = manager.buildMagenticOrchestratorPrompt(
      role,
      agentId,
      groupId,
      magenticConfig,
    );

    // 第1層: role.systemPrompt
    expect(prompt).toContain(role.systemPrompt);

    // 第2層: メタデータブロック
    expect(prompt).toContain("kuromajutsu システム情報");
    expect(prompt).toContain(agentId);
    expect(prompt).toContain(groupId);
    expect(prompt).toContain("report_result");

    // 第3層: Orchestrator ツールガイド
    expect(prompt).toContain("Orchestrator ツール使用ガイド");
    expect(prompt).toContain("create_group");
    expect(prompt).toContain("parentGroupId");
    expect(prompt).toContain("run_agents");
    expect(prompt).toContain("wait_agent");

    // 第4層: タスク定義
    expect(prompt).toContain("タスク定義");
    expect(prompt).toContain("認証機能を実装せよ");

    // 第5層: 完了条件
    expect(prompt).toContain("完了条件");
    expect(prompt).toContain("全単体テストがパスすること");

    // 第6層: 操作範囲・制約
    expect(prompt).toContain("操作範囲・制約");
    expect(prompt).toContain("src/auth/ ディレクトリ内");
    expect(prompt).toContain("既存 API を破壊しないこと");
    expect(prompt).toContain("JWT を使用する");

    // 第7層: 実行パラメータ（availableRoles, maxIterations）
    expect(prompt).toContain("実行パラメータ");
    expect(prompt).toContain("impl-code");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("コード実装者");
    expect(prompt).toContain("コードレビュワー");
    expect(prompt).toContain("最大反復回数: 5");
  });

  it("deleteGroup で magenticConfigs もクリーンアップされること", () => {
    const group = manager.createGroup("Magenticテスト", "magentic");
    const magenticCfg: MagenticConfig = {
      task: "タスク",
      completionCriteria: "条件",
      scope: "範囲",
      availableRoles: ["impl-code"],
      maxIterations: 5,
      currentIteration: 0,
    };
    manager.setMagenticConfig(group.id, magenticCfg);
    expect(manager.getMagenticConfig(group.id)).toBeDefined();

    manager.deleteGroup(group.id);

    expect(manager.getMagenticConfig(group.id)).toBeUndefined();
  });

  it("buildMagenticOrchestratorPrompt で constraints / context 省略時に該当セクションが含まれないこと", () => {
    const role = config.roles[0];
    const magenticCfg: MagenticConfig = {
      task: "タスク",
      completionCriteria: "条件",
      scope: "src/",
      availableRoles: ["impl-code"],
      maxIterations: 3,
      currentIteration: 0,
    };

    const prompt = manager.buildMagenticOrchestratorPrompt(
      role,
      "agent-123",
      "grp-456",
      magenticCfg,
    );

    expect(prompt).toContain("タスク");
    expect(prompt).toContain("条件");
    expect(prompt).toContain("src/");
    expect(prompt).not.toContain("制約事項");
    expect(prompt).not.toContain("補足コンテキスト");
  });

  it("buildMagenticOrchestratorPrompt の第3層で parentGroupId に自身の Group ID を指定する指示が含まれること", () => {
    const role = config.roles[0];
    const groupId = "grp-test-1234";
    const magenticCfg: MagenticConfig = {
      task: "タスク",
      completionCriteria: "条件",
      scope: "src/",
      availableRoles: ["impl-code"],
      maxIterations: 3,
      currentIteration: 0,
    };

    const prompt = manager.buildMagenticOrchestratorPrompt(
      role,
      "agent-123",
      groupId,
      magenticCfg,
    );

    expect(prompt).toContain("parentGroupId");
    expect(prompt).toContain(groupId);
    expect(prompt).toContain("create_group");
  });
});

// ==================================================
// ヘルスチェック結果管理テスト
// ==================================================

describe("AgentManager — ヘルスチェック結果管理", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager(createTestConfig());
  });

  it("ヘルスチェック結果を設定・取得できる", () => {
    const results: HealthCheckResult[] = [
      {
        roleId: "impl-code",
        modelValidation: { status: "valid", checkedAt: new Date().toISOString() },
        healthCheck: { status: "passed" },
        available: true,
      },
    ];

    manager.setHealthCheckResults(results);

    const fetched = manager.getHealthCheckResult("impl-code");
    expect(fetched).toBeDefined();
    expect(fetched!.available).toBe(true);
  });

  it("利用可能モデル一覧を設定・取得できる", () => {
    const models = ["claude-4-sonnet", "claude-4-opus", "gpt-4o"];
    manager.setAvailableModels(models);

    expect(manager.getAvailableModels()).toEqual(models);
  });

  it("利用可能モデル一覧の初期値は空配列", () => {
    expect(manager.getAvailableModels()).toEqual([]);
  });

  it("全ヘルスチェック結果を取得できる", () => {
    const results: HealthCheckResult[] = [
      {
        roleId: "impl-code",
        modelValidation: { status: "valid", checkedAt: new Date().toISOString() },
        healthCheck: { status: "passed" },
        available: true,
      },
      {
        roleId: "code-review",
        modelValidation: { status: "valid", checkedAt: new Date().toISOString() },
        healthCheck: { status: "failed", reason: "timeout" },
        available: false,
      },
    ];

    manager.setHealthCheckResults(results);

    const all = manager.getHealthCheckResults();
    expect(all).toHaveLength(2);
  });
});
