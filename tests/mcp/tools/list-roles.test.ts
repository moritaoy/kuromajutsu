// ============================================================
// list_roles ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleListRoles } from "../../../src/mcp/tools/list-roles.js";
import type { AppConfig, HealthCheckResult } from "../../../src/types/index.js";

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
      {
        id: "code-review",
        name: "コードレビュワー",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("list_roles", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("設定された全職種を返す", () => {
    const result = handleListRoles(config, manager);

    const data = JSON.parse(result.content[0].text);
    expect(data.roles).toHaveLength(2);
    expect(data.roles[0].id).toBe("impl-code");
    expect(data.roles[1].id).toBe("code-review");
  });

  it("ヘルスチェック未実行の場合は available: false を返す", () => {
    const result = handleListRoles(config, manager);

    const data = JSON.parse(result.content[0].text);
    expect(data.roles[0].available).toBe(false);
    expect(data.roles[0].healthCheck.status).toBe("skipped");
  });

  it("ヘルスチェック結果がある場合はそれを反映する", () => {
    const healthResults: HealthCheckResult[] = [
      {
        roleId: "impl-code",
        modelValidation: {
          status: "valid",
          checkedAt: new Date().toISOString(),
        },
        healthCheck: {
          status: "passed",
          responseTime_ms: 1200,
          checkedAt: new Date().toISOString(),
        },
        available: true,
      },
      {
        roleId: "code-review",
        modelValidation: {
          status: "invalid",
          message: "モデルが見つかりません",
          checkedAt: new Date().toISOString(),
        },
        healthCheck: {
          status: "skipped",
          reason: "モデル検証に失敗したためスキップ",
        },
        available: false,
      },
    ];

    manager.setHealthCheckResults(healthResults);
    const result = handleListRoles(config, manager);

    const data = JSON.parse(result.content[0].text);

    // impl-code: 利用可能
    expect(data.roles[0].available).toBe(true);
    expect(data.roles[0].healthCheck.status).toBe("passed");
    expect(data.roles[0].modelValidation.status).toBe("valid");

    // code-review: 利用不可
    expect(data.roles[1].available).toBe(false);
    expect(data.roles[1].healthCheck.status).toBe("skipped");
    expect(data.roles[1].modelValidation.status).toBe("invalid");
  });

  it("各職種の id, name, model を含む", () => {
    const result = handleListRoles(config, manager);

    const data = JSON.parse(result.content[0].text);
    const role = data.roles[0];
    expect(role.id).toBe("impl-code");
    expect(role.name).toBe("コード実装者");
    expect(role.model).toBe("claude-4-sonnet");
  });

  it("利用可能モデル一覧を含む", () => {
    const models = ["claude-4-sonnet", "claude-4-opus", "gpt-4o"];
    manager.setAvailableModels(models);

    const result = handleListRoles(config, manager);
    const data = JSON.parse(result.content[0].text);

    expect(data.availableModels).toEqual(models);
  });

  it("利用可能モデルが未設定の場合は空配列を返す", () => {
    const result = handleListRoles(config, manager);
    const data = JSON.parse(result.content[0].text);

    expect(data.availableModels).toEqual([]);
  });
});
