// ============================================================
// create_group ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleCreateGroup } from "../../../src/mcp/tools/create-group.js";
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
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("create_group", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager(createTestConfig());
  });

  it("グループを作成して正しい形式で返す", () => {
    const result = handleCreateGroup(manager, {
      description: "認証機能の実装・テスト・レビュー",
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toMatch(/^grp-/);
    expect(data.description).toBe("認証機能の実装・テスト・レビュー");
    expect(data.status).toBe("active");
    expect(data.createdAt).toBeDefined();
  });

  it("作成されたグループが AgentManager に登録されている", () => {
    const result = handleCreateGroup(manager, { description: "test" });
    const data = JSON.parse(result.content[0].text);

    const group = manager.getGroup(data.groupId);
    expect(group).toBeDefined();
    expect(group!.description).toBe("test");
  });

  it("group:created イベントが発火する", () => {
    const listener = vi.fn();
    manager.on("group:created", listener);

    handleCreateGroup(manager, { description: "イベントテスト" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].description).toBe("イベントテスト");
  });
});
