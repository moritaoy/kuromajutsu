// ============================================================
// wait_agent ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleWaitAgent } from "../../../src/mcp/tools/wait-agent.js";
import type { AppConfig } from "../../../src/types/index.js";

// AgentExecutor をモック化
vi.mock("../../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

function createTestConfig(): AppConfig {
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
    ],
  };
}

describe("wait_agent", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("空の agentIds を渡した場合 EMPTY_AGENT_IDS エラーを返す（形式: { error: true, code, message }, isError: true）", async () => {
    const result = await handleWaitAgent(manager, {
      agentIds: [],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe(true);
    expect(data.code).toBe("EMPTY_AGENT_IDS");
    expect(typeof data.message).toBe("string");
  });

  it("存在しない Agent ID の場合 AGENT_NOT_FOUND エラーを返す", async () => {
    const result = await handleWaitAgent(manager, {
      agentIds: ["nonexistent-agent"],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("AGENT_NOT_FOUND");
  });

  it("既に完了した Agent を待機するとすぐに返る", async () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "prompt");

    // 正しい順序で状態遷移: queued → running → completed
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = await handleWaitAgent(manager, {
      agentIds: [agent.agentId],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.completed).toHaveLength(1);
    expect(data.completed[0].agentId).toBe(agent.agentId);
    expect(data.pending).toHaveLength(0);
    expect(data.timedOut).toBe(false);
  });

  it("タイムアウト付きの待機で timedOut=true を返す", async () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "prompt");

    const result = await handleWaitAgent(manager, {
      agentIds: [agent.agentId],
      timeout_ms: 50,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timedOut).toBe(true);
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].agentId).toBe(agent.agentId);
  });

  it("mode=any で既完了 Agent があればすぐに返る", async () => {
    const group = manager.createGroup("test");
    const agent1 = manager.startAgent(group.id, config.roles[0], "prompt1");
    const agent2 = manager.startAgent(group.id, config.roles[0], "prompt2");

    // agent1 のみ完了: queued → running → completed
    manager.updateAgentState(agent1.agentId, { status: "running" });
    manager.updateAgentState(agent1.agentId, { status: "completed" });

    const result = await handleWaitAgent(manager, {
      agentIds: [agent1.agentId, agent2.agentId],
      mode: "any",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.completed.length).toBeGreaterThanOrEqual(1);
    expect(data.timedOut).toBe(false);
  });
});
