// ============================================================
// ヘルスチェッカー テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HealthChecker, type CliRunner } from "../../src/health/checker.js";
import type { AppConfig } from "../../src/types/index.js";

// --------------------------------------------------
// テスト用ヘルパー
// --------------------------------------------------

/** テスト用の最小限設定を作成する */
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
        systemPrompt: "あなたはコード実装の専門家です。",
        healthCheckPrompt: "Hello, respond with exactly: OK",
        tools: [],
      },
      {
        id: "code-review",
        name: "コードレビュワー",
        description: "コードの品質をレビューする",
        model: "claude-4-sonnet",
        systemPrompt: "あなたはコードレビューの専門家です。",
        healthCheckPrompt: "Hello, respond with exactly: OK",
        tools: [],
      },
    ],
    ...overrides,
  };
}

/** テスト用 CliRunner モックを作成する */
function createMockRunner(overrides?: Partial<CliRunner>): CliRunner {
  return {
    execCommand: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }),
    ...overrides,
  };
}

// --------------------------------------------------
// テスト
// --------------------------------------------------

describe("HealthChecker", () => {
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
  });

  // ==================================================
  // モデル検証
  // ==================================================

  describe("モデル検証（agent models コマンド）", () => {
    it("agent models コマンドを実行して利用可能モデル一覧を取得する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockResolvedValue({
          stdout: "claude-4-sonnet - Claude 4 Sonnet\nclaude-4-opus - Claude 4 Opus\ngpt-4o - GPT-4o\n",
          exitCode: 0,
        }),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll();

      // agent models コマンドが呼ばれたことを確認
      expect(runner.execCommand).toHaveBeenCalledWith("agent", ["models"]);
    });

    it("設定されたモデルが利用可能一覧に存在すれば valid を返す", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return {
                stdout: "claude-4-sonnet - Claude 4 Sonnet\nclaude-4-opus - Claude 4 Opus\n",
                exitCode: 0,
              };
            }
            // ヘルスチェックプロンプト実行
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.modelValidation.status).toBe("valid");
        expect(result.modelValidation.checkedAt).toBeTruthy();
      }
    });

    it("設定されたモデルが利用可能一覧に存在しなければ invalid を返す", async () => {
      const configWithBadModel = createTestConfig({
        roles: [
          {
            id: "bad-role",
            name: "不正モデル職種",
            model: "nonexistent-model",
            systemPrompt: "test",
            healthCheckPrompt: "Hello",
            tools: [],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return {
                stdout: "claude-4-sonnet - Claude 4 Sonnet\nclaude-4-opus - Claude 4 Opus\n",
                exitCode: 0,
              };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithBadModel, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].modelValidation.status).toBe("invalid");
      expect(results[0].modelValidation.message).toContain("nonexistent-model");
      expect(results[0].modelValidation.availableModels).toEqual([
        "claude-4-sonnet",
        "claude-4-opus",
      ]);
      expect(results[0].available).toBe(false);
    });

    it("agent models コマンドが失敗した場合、全職種を invalid にする", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "", exitCode: 1 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.modelValidation.status).toBe("invalid");
        expect(result.modelValidation.message).toContain("agent models");
        expect(result.available).toBe(false);
      }
    });

    it("agent models コマンドが例外を投げた場合、全職種を invalid にする", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              throw new Error("command not found: agent");
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.modelValidation.status).toBe("invalid");
        expect(result.available).toBe(false);
      }
    });

    it("agent models の出力から空行・前後の空白を除去してモデル名を抽出する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return {
                stdout:
                  "\n  claude-4-sonnet - Claude 4 Sonnet  \n\n  claude-4-opus - Claude 4 Opus  \n  gpt-4o - GPT-4o  \n\n",
                exitCode: 0,
              };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      // claude-4-sonnet が有効と認識されること
      for (const result of results) {
        expect(result.modelValidation.status).toBe("valid");
      }
    });
  });

  // ==================================================
  // ヘルスチェックプロンプト実行
  // ==================================================

  describe("ヘルスチェックプロンプト実行", () => {
    it("モデル検証通過済みの職種に対して healthCheckPrompt を実行する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return {
                stdout: "claude-4-sonnet - Claude 4 Sonnet\n",
                exitCode: 0,
              };
            }
            // agent -p -m model "prompt" の形式
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll();

      // agent -p -m claude-4-sonnet "Hello, respond with exactly: OK" が
      // 各職種分呼ばれたことを確認
      const calls = (runner.execCommand as ReturnType<typeof vi.fn>).mock.calls;
      const healthCheckCalls = calls.filter(
        (c: string[][]) => c[1][0] === "-p",
      );
      expect(healthCheckCalls).toHaveLength(2); // 2つの職種分

      // コマンド引数の確認
      for (const call of healthCheckCalls) {
        expect(call[0]).toBe("agent");
        expect(call[1]).toContain("-p");
        expect(call[1]).toContain("--trust");
        expect(call[1]).toContain("--model");
        expect(call[1]).toContain("claude-4-sonnet");
        expect(call[1]).toContain("Hello, respond with exactly: OK");
      }
    });

    it("ヘルスチェック成功時に passed と応答時間を記録する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.healthCheck.status).toBe("passed");
        expect(result.healthCheck.responseTime_ms).toBeTypeOf("number");
        expect(result.healthCheck.responseTime_ms).toBeGreaterThanOrEqual(0);
        expect(result.healthCheck.checkedAt).toBeTruthy();
        expect(result.available).toBe(true);
      }
    });

    it("ヘルスチェックプロンプト実行が失敗した場合 failed を記録する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            // ヘルスチェック実行が非ゼロで終了
            return { stdout: "", exitCode: 1 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.healthCheck.status).toBe("failed");
        expect(result.healthCheck.reason).toBeTruthy();
        expect(result.available).toBe(false);
      }
    });

    it("ヘルスチェックプロンプト実行で例外が発生した場合 failed を記録する", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            throw new Error("spawn failed");
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.healthCheck.status).toBe("failed");
        expect(result.healthCheck.reason).toContain("spawn failed");
        expect(result.available).toBe(false);
      }
    });

    it("モデル検証に失敗した職種はヘルスチェックをスキップする", async () => {
      const configWithMixed = createTestConfig({
        roles: [
          {
            id: "valid-role",
            name: "有効職種",
            model: "claude-4-sonnet",
            systemPrompt: "test",
            healthCheckPrompt: "Hello",
            tools: [],
          },
          {
            id: "invalid-role",
            name: "無効モデル職種",
            model: "nonexistent-model",
            systemPrompt: "test",
            healthCheckPrompt: "Hello",
            tools: [],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithMixed, runner);
      const results = await checker.runAll();

      // valid-role: モデル検証通過 → ヘルスチェック passed
      const validResult = results.find((r) => r.roleId === "valid-role");
      expect(validResult?.modelValidation.status).toBe("valid");
      expect(validResult?.healthCheck.status).toBe("passed");
      expect(validResult?.available).toBe(true);

      // invalid-role: モデル検証失敗 → ヘルスチェック skipped
      const invalidResult = results.find((r) => r.roleId === "invalid-role");
      expect(invalidResult?.modelValidation.status).toBe("invalid");
      expect(invalidResult?.healthCheck.status).toBe("skipped");
      expect(invalidResult?.healthCheck.reason).toContain("モデル検証");
      expect(invalidResult?.available).toBe(false);

      // ヘルスチェックプロンプトは valid-role の1回だけ実行される
      const calls = (runner.execCommand as ReturnType<typeof vi.fn>).mock.calls;
      const healthCheckCalls = calls.filter(
        (c: string[][]) => c[1][0] === "-p",
      );
      expect(healthCheckCalls).toHaveLength(1);
    });
  });

  // ==================================================
  // コールバック通知
  // ==================================================

  describe("コールバック通知", () => {
    it("onModelValidation コールバックが呼ばれる", async () => {
      const onModelValidation = vi.fn();
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll({ onModelValidation });

      expect(onModelValidation).toHaveBeenCalledTimes(1);
      const callArgs = onModelValidation.mock.calls[0][0];
      expect(callArgs).toHaveLength(config.roles.length);
    });

    it("onRoleCheckStart コールバックが各職種で呼ばれる", async () => {
      const onRoleCheckStart = vi.fn();
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll({ onRoleCheckStart });

      expect(onRoleCheckStart).toHaveBeenCalledTimes(2);
      expect(onRoleCheckStart).toHaveBeenCalledWith("impl-code");
      expect(onRoleCheckStart).toHaveBeenCalledWith("code-review");
    });

    it("onRoleCheckComplete コールバックが各職種で呼ばれる", async () => {
      const onRoleCheckComplete = vi.fn();
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll({ onRoleCheckComplete });

      expect(onRoleCheckComplete).toHaveBeenCalledTimes(2);
      for (const call of onRoleCheckComplete.mock.calls) {
        const result = call[0];
        expect(result.roleId).toBeTruthy();
        expect(result.healthCheck.status).toBe("passed");
      }
    });

    it("onComplete コールバックが全職種完了後に呼ばれる", async () => {
      const onComplete = vi.fn();
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll({ onComplete });

      expect(onComplete).toHaveBeenCalledTimes(1);
      const callArgs = onComplete.mock.calls[0][0];
      expect(callArgs).toHaveLength(config.roles.length);
      // 返却値と同じ結果がコールバックに渡される
      expect(callArgs).toEqual(results);
    });

    it("モデル検証失敗の職種は onRoleCheckStart/Complete が呼ばれない", async () => {
      const configOnlyBad = createTestConfig({
        roles: [
          {
            id: "bad-role",
            name: "不正モデル",
            model: "nonexistent",
            systemPrompt: "test",
            healthCheckPrompt: "Hello",
            tools: [],
          },
        ],
      });

      const onRoleCheckStart = vi.fn();
      const onRoleCheckComplete = vi.fn();
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configOnlyBad, runner);
      await checker.runAll({ onRoleCheckStart, onRoleCheckComplete });

      // モデル検証失敗なのでヘルスチェック自体がスキップ
      expect(onRoleCheckStart).not.toHaveBeenCalled();
      expect(onRoleCheckComplete).not.toHaveBeenCalled();
    });
  });

  // ==================================================
  // 結果構造の検証
  // ==================================================

  describe("結果構造", () => {
    it("全職種分の結果を返す", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(config.roles.length);
      for (const result of results) {
        expect(result).toHaveProperty("roleId");
        expect(result).toHaveProperty("modelValidation");
        expect(result).toHaveProperty("healthCheck");
        expect(result).toHaveProperty("available");
        expect(result.modelValidation).toHaveProperty("status");
        expect(result.modelValidation).toHaveProperty("checkedAt");
      }
    });

    it("runAll 後に availableModels プロパティでモデル一覧を取得できる", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return {
                stdout: "claude-4-sonnet - Claude 4 Sonnet\nclaude-4-opus - Claude 4 Opus\ngpt-4o - GPT-4o\n",
                exitCode: 0,
              };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll();

      expect(checker.availableModels).toEqual([
        "claude-4-sonnet",
        "claude-4-opus",
        "gpt-4o",
      ]);
    });

    it("agent models コマンドが失敗した場合は availableModels が空配列", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "", exitCode: 1 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll();

      expect(checker.availableModels).toEqual([]);
    });

    it("runAll 前の availableModels は空配列", () => {
      const runner = createMockRunner();
      const checker = new HealthChecker(config, runner);

      expect(checker.availableModels).toEqual([]);
    });

    it("CliRunner を渡さない場合にデフォルトの CliRunner が使われる", () => {
      // コンストラクタがエラーなく動作すること（デフォルト CliRunner）
      const checker = new HealthChecker(config);
      expect(checker).toBeInstanceOf(HealthChecker);
    });

    it("職種が0件の場合は空配列を返す", async () => {
      const emptyConfig = createTestConfig({ roles: [] });
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(emptyConfig, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(0);
    });
  });

  // ==================================================
  // コンソール出力
  // ==================================================

  describe("コンソール出力", () => {
    it("ヘルスチェックの進行状況をコンソールに出力する", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      await checker.runAll();

      // ヘルスチェック開始のログ
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("ヘルスチェック"),
      );

      // 完了サマリのログ
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("完了"),
      );

      consoleSpy.mockRestore();
    });
  });

  // ==================================================
  // ツール可用性チェック
  // ==================================================

  describe("ツール可用性チェック", () => {
    it("ツールが設定されている職種で、ツールが利用可能な場合は available=true になる", async () => {
      const configWithTools = createTestConfig({
        roles: [
          {
            id: "text-review",
            name: "文章レビュワー",
            description: "文章の品質をレビューする",
            model: "claude-4-sonnet",
            systemPrompt: "あなたは文章レビューの専門家です。",
            healthCheckPrompt: "Hello, respond with exactly: OK",
            tools: ["textlint"],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            if (cmd === "npx" && args[0] === "textlint") {
              return { stdout: "14.5.0", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithTools, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].available).toBe(true);
      expect(results[0].toolChecks).toHaveLength(1);
      expect(results[0].toolChecks![0].toolId).toBe("textlint");
      expect(results[0].toolChecks![0].status).toBe("passed");
    });

    it("ツールが設定されている職種で、ツールが利用不可な場合は available=false になる", async () => {
      const configWithTools = createTestConfig({
        roles: [
          {
            id: "text-review",
            name: "文章レビュワー",
            description: "文章の品質をレビューする",
            model: "claude-4-sonnet",
            systemPrompt: "あなたは文章レビューの専門家です。",
            healthCheckPrompt: "Hello, respond with exactly: OK",
            tools: ["textlint"],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            if (cmd === "npx" && args[0] === "textlint") {
              return { stdout: "", exitCode: 1 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithTools, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].available).toBe(false);
      expect(results[0].healthCheck.status).toBe("failed");
      expect(results[0].healthCheck.reason).toContain("ツールチェック失敗");
      expect(results[0].healthCheck.reason).toContain("textlint");
      expect(results[0].toolChecks).toHaveLength(1);
      expect(results[0].toolChecks![0].status).toBe("failed");
    });

    it("ツールのヘルスチェックコマンドが例外を投げた場合は failed になる", async () => {
      const configWithTools = createTestConfig({
        roles: [
          {
            id: "text-review",
            name: "文章レビュワー",
            description: "文章の品質をレビューする",
            model: "claude-4-sonnet",
            systemPrompt: "あなたは文章レビューの専門家です。",
            healthCheckPrompt: "Hello, respond with exactly: OK",
            tools: ["textlint"],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            if (cmd === "npx" && args[0] === "textlint") {
              throw new Error("npx not found");
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithTools, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].available).toBe(false);
      expect(results[0].toolChecks![0].status).toBe("failed");
      expect(results[0].toolChecks![0].reason).toContain("npx not found");
    });

    it("ツールが設定されていない職種ではツールチェックが実行されない", async () => {
      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(config, runner);
      const results = await checker.runAll();

      for (const result of results) {
        expect(result.toolChecks).toBeUndefined();
        expect(result.available).toBe(true);
      }
    });

    it("未知のツール ID が設定されている場合は failed になる", async () => {
      const configWithUnknown = createTestConfig({
        roles: [
          {
            id: "custom-role",
            name: "カスタム職種",
            model: "claude-4-sonnet",
            systemPrompt: "test",
            healthCheckPrompt: "Hello, respond with exactly: OK",
            tools: ["unknown-tool"],
          },
        ],
      });

      const runner = createMockRunner({
        execCommand: vi.fn().mockImplementation(
          async (cmd: string, args: string[]) => {
            if (args[0] === "models") {
              return { stdout: "claude-4-sonnet - Claude 4 Sonnet\n", exitCode: 0 };
            }
            return { stdout: "OK", exitCode: 0 };
          },
        ),
      });

      const checker = new HealthChecker(configWithUnknown, runner);
      const results = await checker.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].available).toBe(false);
      expect(results[0].toolChecks).toHaveLength(1);
      expect(results[0].toolChecks![0].status).toBe("failed");
      expect(results[0].toolChecks![0].reason).toContain("ツール定義が見つかりません");
    });
  });
});
