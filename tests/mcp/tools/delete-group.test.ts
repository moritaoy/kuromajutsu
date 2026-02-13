// ============================================================
// delete_group ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleDeleteGroup } from "../../../src/mcp/tools/delete-group.js";
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

describe("delete_group", () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager(createTestConfig());
  });

  it("存在しないグループを削除しようとすると GROUP_NOT_FOUND エラーを返す", () => {
    const result = handleDeleteGroup(manager, { groupId: "grp-nonexistent" });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_NOT_FOUND");
  });

  it("グループを正常に削除できる", () => {
    const group = manager.createGroup("削除テスト");
    const result = handleDeleteGroup(manager, { groupId: group.id });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toBe(true);
    expect(data.groupId).toBe(group.id);
  });

  it("削除後のグループの status が deleted になっている", () => {
    const group = manager.createGroup("削除テスト");
    handleDeleteGroup(manager, { groupId: group.id });

    const deleted = manager.getGroup(group.id);
    expect(deleted!.status).toBe("deleted");
  });

  it("実行中の Agent があるグループは削除できない", () => {
    const group = manager.createGroup("実行中テスト");
    const config = createTestConfig();
    const role = config.roles[0];

    // Agent を起動（queued 状態）
    manager.startAgent(group.id, role, "test prompt");

    const result = handleDeleteGroup(manager, { groupId: group.id });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("GROUP_HAS_RUNNING_AGENTS");
  });

  it("group:deleted イベントが発火する", () => {
    const listener = vi.fn();
    manager.on("group:deleted", listener);

    const group = manager.createGroup("イベントテスト");
    handleDeleteGroup(manager, { groupId: group.id });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].groupId).toBe(group.id);
  });
});
