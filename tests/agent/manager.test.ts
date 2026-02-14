// ============================================================
// AgentManager テスト
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager } from "../../src/agent/manager.js";
import type { AppConfig, AgentState, GroupDefinition, AgentResult, HealthCheckResult } from "../../src/types/index.js";

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
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
      {
        id: "code-review",
        name: "コードレビュワー",
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

  beforeEach(() => {
    manager = new AgentManager(createTestConfig());
  });

  it("グループを作成できる", () => {
    const group = manager.createGroup("テストグループ");

    expect(group.id).toMatch(/^grp-/);
    expect(group.description).toBe("テストグループ");
    expect(group.status).toBe("active");
    expect(group.agentIds).toEqual([]);
    expect(group.createdAt).toBeDefined();
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
    manager.deleteGroup(group.id);

    const deleted = manager.getGroup(group.id);
    expect(deleted!.status).toBe("deleted");
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

  it("グループ削除時にグループに属する Agent も削除される", () => {
    const config = createTestConfig();
    const mgr = new AgentManager(config);
    const group = mgr.createGroup("test");
    const a1 = mgr.startAgent(group.id, config.roles[0], "test1");
    const a2 = mgr.startAgent(group.id, config.roles[1], "test2");

    // 削除前: Agent が存在する
    expect(mgr.getAgent(a1.agentId)).toBeDefined();
    expect(mgr.getAgent(a2.agentId)).toBeDefined();
    expect(mgr.listAgents()).toHaveLength(2);

    mgr.deleteGroup(group.id);

    // 削除後: Agent も削除される
    expect(mgr.getAgent(a1.agentId)).toBeUndefined();
    expect(mgr.getAgent(a2.agentId)).toBeUndefined();
    expect(mgr.listAgents()).toHaveLength(0);
  });

  it("グループ削除時に他のグループの Agent は影響を受けない", () => {
    const config = createTestConfig();
    const mgr = new AgentManager(config);
    const group1 = mgr.createGroup("group1");
    const group2 = mgr.createGroup("group2");
    const a1 = mgr.startAgent(group1.id, config.roles[0], "test1");
    const a2 = mgr.startAgent(group2.id, config.roles[1], "test2");

    mgr.deleteGroup(group1.id);

    // group1 の Agent は削除される
    expect(mgr.getAgent(a1.agentId)).toBeUndefined();
    // group2 の Agent は残る
    expect(mgr.getAgent(a2.agentId)).toBeDefined();
    expect(mgr.listAgents()).toHaveLength(1);
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
    });

    expect(result.agentId).toBe(agent.agentId);
    expect(result.status).toBe("success");
    expect(result.summary).toBe("All good");
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
      editedFiles: ["src/a.ts"],
    });

    expect(result.editedFiles.filter((f) => f === "src/a.ts")).toHaveLength(1);
  });

  it("存在しない Agent への reportResult はエラー", () => {
    expect(() =>
      manager.reportResult("nonexistent", {
        status: "success",
        summary: "done",
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
