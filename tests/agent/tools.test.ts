// ============================================================
// ツールレジストリ (tools.ts) テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getToolDefinition,
  listToolDefinitions,
  buildToolPromptBlock,
} from "../../src/agent/tools.js";
import { AgentManager } from "../../src/agent/manager.js";
import type { AppConfig, RoleDefinition } from "../../src/types/index.js";

// --------------------------------------------------
// AgentExecutor のモック（buildFullPrompt テスト用）
// --------------------------------------------------

vi.mock("../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

// ==================================================
// getToolDefinition テスト
// ==================================================

describe("getToolDefinition", () => {
  it("存在するツール ID (textlint) で定義を取得できること", () => {
    const def = getToolDefinition("textlint");
    expect(def).toBeDefined();
    expect(def!.id).toBe("textlint");
  });

  it("存在しないツール ID で undefined が返ること", () => {
    const def = getToolDefinition("nonexistent-tool");
    expect(def).toBeUndefined();
  });

  it("取得した定義が正しいフィールドを持つこと（id, name, description, promptInstructions）", () => {
    const def = getToolDefinition("textlint");
    expect(def).toBeDefined();
    expect(def).toHaveProperty("id", "textlint");
    expect(def).toHaveProperty("name", "textlint");
    expect(def).toHaveProperty("description");
    expect(typeof def!.description).toBe("string");
    expect(def).toHaveProperty("promptInstructions");
    expect(typeof def!.promptInstructions).toBe("string");
  });
});

// ==================================================
// listToolDefinitions テスト
// ==================================================

describe("listToolDefinitions", () => {
  it("ビルトインツール一覧が返ること（少なくとも textlint が含まれる）", () => {
    const tools = listToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    const textlint = tools.find((t) => t.id === "textlint");
    expect(textlint).toBeDefined();
    expect(textlint!.name).toBe("textlint");
  });

  it("各定義が RoleToolDefinition の構造を持つこと", () => {
    const tools = listToolDefinitions();
    for (const tool of tools) {
      expect(tool).toHaveProperty("id");
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("promptInstructions");
      expect(typeof tool.id).toBe("string");
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.promptInstructions).toBe("string");
    }
  });
});

// ==================================================
// buildToolPromptBlock テスト
// ==================================================

describe("buildToolPromptBlock", () => {
  it("空配列を渡すと空文字列が返ること", () => {
    const result = buildToolPromptBlock([]);
    expect(result).toBe("");
  });

  it("有効なツール ID を渡すとプロンプトブロックが返ること", () => {
    const result = buildToolPromptBlock(["textlint"]);
    expect(result).not.toBe("");
    expect(typeof result).toBe("string");
  });

  it("プロンプトブロックに「利用可能ツール」ヘッダーが含まれること", () => {
    const result = buildToolPromptBlock(["textlint"]);
    expect(result).toContain("【利用可能ツール】");
  });

  it("プロンプトブロックにツールの promptInstructions が含まれること", () => {
    const def = getToolDefinition("textlint");
    expect(def).toBeDefined();

    const result = buildToolPromptBlock(["textlint"]);
    expect(result).toContain(def!.promptInstructions);
  });

  it("存在しないツール ID を渡すと警告ログが出力され、スキップされること", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = buildToolPromptBlock(["unknown-tool", "textlint"]);

    expect(warnSpy).toHaveBeenCalledWith(
      '[tools] 未知のツール ID: "unknown-tool" — スキップします',
    );
    expect(result).toContain("【利用可能ツール】");
    expect(result).toContain("textlint");

    warnSpy.mockRestore();
  });

  it("全て存在しないツール ID の場合は空文字列が返ること", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = buildToolPromptBlock(["unknown1", "unknown2"]);

    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});

// ==================================================
// buildFullPrompt のツール注入確認（AgentManager 側）
// ==================================================

describe("buildFullPrompt のツール注入確認（AgentManager）", () => {
  const mockConfig: AppConfig = {
    dashboard: { port: 9696 },
    agent: { maxConcurrent: 10 },
    log: { level: "info" },
    roles: [],
  };

  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager(mockConfig);
  });

  it("ツールなしのロール（tools: []）ではツールブロックが含まれないこと", () => {
    const role: RoleDefinition = {
      id: "test-role",
      name: "テストロール",
      description: "テスト用ロール",
      systemPrompt: "あなたはテスト用の Agent です。",
      model: "claude-4-sonnet",
      tools: [],
      healthCheckPrompt: "OK",
    };

    const prompt = manager.buildFullPrompt(
      role,
      "test-123-abcd",
      "grp-123-efgh",
      "ユーザータスク",
    );

    expect(prompt).not.toContain("【利用可能ツール】");
    expect(prompt).not.toContain("## 利用可能ツール: textlint");
  });

  it("ツールありのロール（tools: [textlint]）ではツールブロックが含まれること", () => {
    const role: RoleDefinition = {
      id: "test-role",
      name: "テストロール",
      description: "テスト用ロール",
      systemPrompt: "あなたはテスト用の Agent です。",
      model: "claude-4-sonnet",
      tools: ["textlint"],
      healthCheckPrompt: "OK",
    };

    const prompt = manager.buildFullPrompt(
      role,
      "test-123-abcd",
      "grp-123-efgh",
      "ユーザータスク",
    );

    expect(prompt).toContain("【利用可能ツール】");
    expect(prompt).toContain("## 利用可能ツール: textlint");
  });
});
