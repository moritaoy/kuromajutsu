// ============================================================
// list_roles ツール テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { handleListRoles } from "../../../src/mcp/tools/list-roles.js";
import type { AppConfig } from "../../../src/types/index.js";

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
      {
        id: "code-review",
        name: "コードレビュワー",
        description: "コードの品質をレビューする",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code reviewer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("list_roles", () => {
  it("設定された全職種を返す", () => {
    const config = createTestConfig();
    const result = handleListRoles(config);

    const data = JSON.parse(result.content[0].text);
    expect(data.roles).toHaveLength(2);
    expect(data.roles[0].id).toBe("impl-code");
    expect(data.roles[1].id).toBe("code-review");
  });

  it("各職種の id, name, description, model のみを含む", () => {
    const config = createTestConfig();
    const result = handleListRoles(config);

    const data = JSON.parse(result.content[0].text);
    const role = data.roles[0];
    expect(role).toEqual({
      id: "impl-code",
      name: "コード実装者",
      description: "コードの実装・修正を行う",
      model: "claude-4-sonnet",
    });
  });

  it("ヘルスチェック関連フィールドを含まない", () => {
    const config = createTestConfig();
    const result = handleListRoles(config);

    const data = JSON.parse(result.content[0].text);
    const role = data.roles[0];
    expect(role).not.toHaveProperty("available");
    expect(role).not.toHaveProperty("healthCheck");
    expect(role).not.toHaveProperty("modelValidation");
    expect(data).not.toHaveProperty("availableModels");
  });
});
