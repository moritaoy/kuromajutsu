// ============================================================
// run_magentic ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleRunMagentic } from "../../../src/mcp/tools/run-magentic.js";
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
        id: "orchestrator",
        name: "オーケストレーター",
        description: "Magentic パターンでサブ Agent を自律管理する",
        model: "opus-4.6-thinking",
        systemPrompt: "You are an orchestrator.",
        healthCheckPrompt: "OK",
      },
    ],
    ...overrides,
  };
}

describe("run_magentic", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("正常系: 全必須パラメータ指定で起動成功", () => {
    const result = handleRunMagentic(config, manager, {
      description: "認証機能の実装",
      task: "認証機能を実装する",
      completionCriteria: "全テストが通ること",
      scope: "src/auth/",
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toMatch(/^grp-/);
    expect(data.orchestratorAgentId).toMatch(/^orchestrator-/);
    expect(data.status).toBe("started");

    const group = manager.getGroup(data.groupId);
    expect(group).toBeDefined();
    expect(group?.mode).toBe("magentic");
    expect(group?.orchestratorAgentId).toBe(data.orchestratorAgentId);
  });

  it("異常系: orchestrator ロール未設定時 (ORCHESTRATOR_ROLE_NOT_FOUND)", () => {
    const configWithoutOrchestrator = createTestConfig({
      roles: config.roles.filter((r) => r.id !== "orchestrator"),
    });
    const mgr = new AgentManager(configWithoutOrchestrator);

    const result = handleRunMagentic(configWithoutOrchestrator, mgr, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ORCHESTRATOR_ROLE_NOT_FOUND");
    expect(data.message).toContain("orchestrator");
  });

  it("異常系: orchestrator ヘルスチェック未通過 (ORCHESTRATOR_UNAVAILABLE)", () => {
    const healthResults: HealthCheckResult[] = [
      {
        roleId: "orchestrator",
        modelValidation: {
          status: "invalid",
          message: "モデルが見つかりません",
          checkedAt: new Date().toISOString(),
        },
        healthCheck: { status: "skipped" },
        available: false,
      },
    ];
    manager.setHealthCheckResults(healthResults);

    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ORCHESTRATOR_UNAVAILABLE");
  });

  it("異常系: availableRoles に存在しないロールを指定 (ROLE_NOT_FOUND)", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
      availableRoles: ["impl-code", "nonexistent-role"],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("ROLE_NOT_FOUND");
    expect(data.message).toContain("nonexistent-role");
  });

  it("maxIterations のデフォルト値（10）が適用されること", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
    });

    expect(result).not.toHaveProperty("isError");
    const magenticConfig = manager.getMagenticConfig(
      JSON.parse(result.content[0].text).groupId,
    );
    expect(magenticConfig?.maxIterations).toBe(10);
  });

  it("availableRoles 省略時に orchestrator 以外の全ロールがデフォルト設定されること", () => {
    const multiRoleConfig = createTestConfig({
      roles: [
        ...createTestConfig().roles,
        {
          id: "code-review",
          name: "コードレビュワー",
          description: "コードレビュー",
          model: "claude-4-sonnet",
          systemPrompt: "Review code.",
          healthCheckPrompt: "OK",
        },
      ],
    });
    const mgr = new AgentManager(multiRoleConfig);

    const result = handleRunMagentic(multiRoleConfig, mgr, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
    });

    expect(result).not.toHaveProperty("isError");
    const groupId = JSON.parse(result.content[0].text).groupId;
    const magenticConfig = mgr.getMagenticConfig(groupId);
    expect(magenticConfig?.availableRoles).toContain("impl-code");
    expect(magenticConfig?.availableRoles).toContain("code-review");
    expect(magenticConfig?.availableRoles).not.toContain("orchestrator");
  });

  it("constraints / context が MagenticConfig に保存されること", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
      constraints: "既存 API を変更しない",
      context: "認証仕様は docs/auth.md を参照",
    });

    expect(result).not.toHaveProperty("isError");
    const groupId = JSON.parse(result.content[0].text).groupId;
    const magenticConfig = manager.getMagenticConfig(groupId);
    expect(magenticConfig?.constraints).toBe("既存 API を変更しない");
    expect(magenticConfig?.context).toBe("認証仕様は docs/auth.md を参照");
  });

  it("constraints / context 省略時に undefined であること", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
    });

    expect(result).not.toHaveProperty("isError");
    const groupId = JSON.parse(result.content[0].text).groupId;
    const magenticConfig = manager.getMagenticConfig(groupId);
    expect(magenticConfig?.constraints).toBeUndefined();
    expect(magenticConfig?.context).toBeUndefined();
  });

  it("timeout_ms が指定されても起動が成功すること", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "criteria",
      scope: "scope",
      timeout_ms: 120000,
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("started");
    const agent = manager.getAgent(data.orchestratorAgentId);
    expect(agent).toBeDefined();
  });

  it("completionCriteria と scope が空文字の場合でもエラーにならないこと", () => {
    const result = handleRunMagentic(config, manager, {
      description: "test",
      task: "task",
      completionCriteria: "",
      scope: "",
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.groupId).toMatch(/^grp-/);
    expect(data.status).toBe("started");
  });
});
