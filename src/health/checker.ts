// ============================================================
// ヘルスチェック・モデル検証
// ============================================================
//
// 責務:
// - MCPサーバー起動時に自動実行
// - Provider（Cursor / Claude）ごとに利用可能モデル一覧を取得
// - 各職種に設定されたモデルが、その職種の Provider で利用可能か照合
// - モデル検証通過済みの職種に対して healthCheckPrompt で動作確認
// - 結果をコンソールと WebSocket（ダッシュボード）にリアルタイム通知

import { execFile } from "node:child_process";
import { getToolDefinition } from "../agent/tools.js";
import {
  getProvider,
  resolveProviderId,
  type AgentProvider,
} from "../agent/providers/index.js";
import type {
  AgentProviderId,
  AppConfig,
  HealthCheckResult,
  RoleDefinition,
  ToolCheckResult,
} from "../types/index.js";

// --------------------------------------------------
// CLI ランナーインターフェース（テスト可能にするための DI）
// --------------------------------------------------

/** CLI コマンド実行結果 */
export interface CliRunResult {
  stdout: string;
  exitCode: number;
}

/**
 * CLI コマンドを実行するインターフェース。
 * テスト時にモックに差し替えて利用する。
 */
export interface CliRunner {
  execCommand(command: string, args: string[]): Promise<CliRunResult>;
}

// --------------------------------------------------
// コールバック型
// --------------------------------------------------

/**
 * ヘルスチェック進行状況の通知コールバック。
 * index.ts でダッシュボード WebSocket イベントに中継するために使用する。
 */
export interface HealthCheckCallbacks {
  /** モデル検証完了時（全職種分の結果） */
  onModelValidation?: (results: HealthCheckResult[]) => void;
  /** 各職種のヘルスチェック開始時 */
  onRoleCheckStart?: (roleId: string) => void;
  /** 各職種のヘルスチェック完了時 */
  onRoleCheckComplete?: (result: HealthCheckResult) => void;
  /** 全チェック完了時 */
  onComplete?: (results: HealthCheckResult[]) => void;
}

// --------------------------------------------------
// デフォルトの CliRunner（実プロセス実行）
// --------------------------------------------------

class DefaultCliRunner implements CliRunner {
  async execCommand(command: string, args: string[]): Promise<CliRunResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, { timeout: 60_000 }, (error, stdout, _stderr) => {
        if (error && error.killed) {
          reject(new Error(`コマンドがタイムアウトしました: ${command} ${args.join(" ")}`));
          return;
        }
        // exitCode が非ゼロでも resolve する（呼び出し側で判定）
        resolve({
          stdout: stdout ?? "",
          exitCode: error?.code ? Number(error.code) : (error ? 1 : 0),
        });
      });
      // stdin を閉じて、子プロセスが EOF を検知できるようにする
      // agent CLI は stdin が開いたままだと入力待ちでハングする
      child.stdin?.end();
    });
  }
}

/** モデル一覧コマンドの表示用ラベル（例: "agent models"） */
function listCommandLabel(provider: AgentProvider): string {
  const cmd = provider.buildListModelsCommand();
  return cmd ? `${cmd.command} ${cmd.args.join(" ")}` : `${provider.id} models`;
}

/**
 * items を最大 limit 件ずつ並列に処理する。
 * 1 件終わるごとに次の 1 件を開始する（ワーカープール方式）。
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

// --------------------------------------------------
// HealthChecker
// --------------------------------------------------

/**
 * MCPサーバー起動時にモデル検証とヘルスチェックプロンプトを実行する。
 *
 * フロー:
 * 1. 使用中の Provider ごとに利用可能モデル一覧を取得（cursor: `agent models` / claude: 静的一覧）
 * 2. 各職種のモデルを、その職種の Provider の一覧と照合（モデル検証）
 * 3. モデル検証通過済み職種に `healthCheckPrompt` を Provider の CLI で実行
 *    （`agent.maxConcurrent` を上限に並列実行。結果は職種の定義順のまま）
 * 4. 結果を HealthCheckResult[] として返却
 */
export class HealthChecker {
  private runner: CliRunner;

  /** 最後に取得した利用可能モデル一覧（全 Provider の和集合。runAll 実行後に設定される） */
  public availableModels: string[] = [];

  /** Provider 別の利用可能モデル一覧（runAll 実行後に設定される） */
  public availableModelsByProvider: Record<AgentProviderId, string[]> = {
    cursor: [],
    claude: [],
  };

  constructor(
    private config: AppConfig,
    runner?: CliRunner,
  ) {
    this.runner = runner ?? new DefaultCliRunner();
  }

  /**
   * 全職種のヘルスチェックを実行する
   */
  async runAll(callbacks?: HealthCheckCallbacks): Promise<HealthCheckResult[]> {
    console.error("[health] ヘルスチェックを開始します...");

    // 1. 使用中の Provider ごとに利用可能モデル一覧を取得
    const modelsByProvider = new Map<AgentProviderId, string[] | null>();
    const usedProviders = [...new Set(this.config.roles.map((r) => resolveProviderId(r)))];
    const modelLists = await Promise.all(usedProviders.map((id) => this.getAvailableModels(id)));
    usedProviders.forEach((id, i) => modelsByProvider.set(id, modelLists[i]));

    // 利用可能モデル一覧を公開プロパティに保存
    this.availableModelsByProvider = { cursor: [], claude: [] };
    for (const [providerId, models] of modelsByProvider) {
      this.availableModelsByProvider[providerId] = models ?? [];
    }
    this.availableModels = [
      ...new Set([
        ...this.availableModelsByProvider.cursor,
        ...this.availableModelsByProvider.claude,
      ]),
    ];

    // 2. 各職種のモデル検証
    const results: HealthCheckResult[] = this.config.roles.map((role) =>
      this.validateModel(role, modelsByProvider.get(resolveProviderId(role)) ?? null),
    );

    // モデル検証結果をコールバック通知
    callbacks?.onModelValidation?.(results);

    // モデル検証結果のコンソール出力
    for (const result of results) {
      const icon = result.modelValidation.status === "valid" ? "✅" : "❌";
      const role = this.config.roles.find((r) => r.id === result.roleId);
      console.error(
        `[health]   ${icon} ${result.roleId} (${result.provider}/${role?.model ?? "?"}) — モデル検証: ${result.modelValidation.status}`,
      );
    }

    // 3. モデル検証通過済み職種にヘルスチェックプロンプトを実行（maxConcurrent を上限に並列）
    const targets = results.flatMap((result) => {
      if (result.modelValidation.status !== "valid") return []; // モデル検証失敗 → スキップ
      const role = this.config.roles.find((r) => r.id === result.roleId);
      return role ? [{ result, role }] : [];
    });
    await runWithConcurrency(targets, this.config.agent.maxConcurrent, ({ result, role }) =>
      this.checkRole(result, role, callbacks),
    );

    // 4. 完了サマリ
    const availableCount = results.filter((r) => r.available).length;
    console.error(
      `[health] ヘルスチェック完了: ${results.length} 職種中 ${availableCount} 職種が利用可能`,
    );

    // コールバック: 全体完了
    callbacks?.onComplete?.(results);

    return results;
  }

  // ==================================================
  // 内部メソッド
  // ==================================================

  /**
   * モデル検証通過済みの 1 職種に対してヘルスチェックプロンプトとツールチェックを実行し、
   * 結果を result に反映する。
   */
  private async checkRole(
    result: HealthCheckResult,
    role: RoleDefinition,
    callbacks?: HealthCheckCallbacks,
  ): Promise<void> {
    // コールバック: チェック開始
    callbacks?.onRoleCheckStart?.(role.id);

    // ヘルスチェックプロンプト実行
    const healthResult = await this.runHealthCheckPrompt(role);

    // 結果を反映
    result.healthCheck = healthResult.healthCheck;
    result.available = healthResult.available;

    // ツール可用性チェック（role に tools が設定されている場合）
    if (result.available && role.tools && role.tools.length > 0) {
      const toolChecks = await this.checkRoleTools(role);
      result.toolChecks = toolChecks;

      const failedTools = toolChecks.filter((t) => t.status === "failed");
      if (failedTools.length > 0) {
        result.available = false;
        result.healthCheck = {
          status: "failed",
          reason: `ツールチェック失敗: ${failedTools.map((t) => `${t.toolId} (${t.reason})`).join(", ")}`,
          responseTime_ms: result.healthCheck.responseTime_ms,
          checkedAt: result.healthCheck.checkedAt,
        };
      }

      // ツールチェック結果のコンソール出力
      for (const tc of toolChecks) {
        const icon = tc.status === "passed" ? "✅" : "❌";
        console.error(
          `[health]     ${icon} ${role.id} ツール: ${tc.toolId} — ${tc.status}${tc.reason ? ` (${tc.reason})` : ""}`,
        );
      }
    }

    // コールバック: チェック完了
    callbacks?.onRoleCheckComplete?.(result);

    // コンソール出力
    const icon = result.healthCheck.status === "passed" ? "✅" : "❌";
    const time =
      result.healthCheck.responseTime_ms !== undefined
        ? ` (${result.healthCheck.responseTime_ms}ms)`
        : "";
    console.error(
      `[health]   ${icon} ${result.roleId} — ヘルスチェック: ${result.healthCheck.status}${time}`,
    );
  }

  /**
   * Provider の利用可能モデル一覧を取得する。
   * モデル一覧コマンドを持たない Provider は静的一覧を返す。
   * コマンドが失敗した場合は null を返す。
   */
  private async getAvailableModels(providerId: AgentProviderId): Promise<string[] | null> {
    const provider = getProvider(providerId);
    const listCommand = provider.buildListModelsCommand();
    if (!listCommand) {
      return provider.staticModels;
    }

    const label = listCommandLabel(provider);
    try {
      const result = await this.runner.execCommand(listCommand.command, listCommand.args);

      if (result.exitCode !== 0) {
        console.error(
          `[health] ${label} コマンドが失敗しました (exitCode=${result.exitCode})`,
        );
        return null;
      }

      const models = provider.parseModelList(result.stdout);
      if (models.length === 0) {
        console.error(
          `[health] ${label} の出力からモデルを取得できませんでした: ${JSON.stringify(result.stdout.slice(0, 300))}`,
        );
      }

      console.error(
        `[health] 利用可能モデル (${providerId}): ${models.join(", ")} (${models.length} 件)`,
      );

      return models;
    } catch (error) {
      console.error(
        `[health] ${label} コマンドの実行に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 職種のモデルが利用可能一覧に存在するか検証する。
   */
  private validateModel(
    role: RoleDefinition,
    availableModels: string[] | null,
  ): HealthCheckResult {
    const now = new Date().toISOString();
    const providerId = resolveProviderId(role);
    const provider = getProvider(providerId);

    // モデル一覧の取得に失敗した Provider の職種は invalid
    if (availableModels === null) {
      return {
        roleId: role.id,
        provider: providerId,
        modelValidation: {
          status: "invalid",
          message: `${listCommandLabel(provider)} コマンドの実行に失敗したため検証できません`,
          checkedAt: now,
        },
        healthCheck: {
          status: "skipped",
          reason: "モデル検証に失敗したためスキップ",
        },
        available: false,
      };
    }

    // モデルが一覧に含まれているか
    const isValid = provider.isModelAvailable(role.model, availableModels);

    if (isValid) {
      return {
        roleId: role.id,
        provider: providerId,
        modelValidation: {
          status: "valid",
          checkedAt: now,
        },
        healthCheck: {
          // ヘルスチェック未実行（後で上書きする）
          status: "skipped",
          reason: "ヘルスチェック実行前",
        },
        available: false, // ヘルスチェック通過後に true にする
      };
    }

    return {
      roleId: role.id,
      provider: providerId,
      modelValidation: {
        status: "invalid",
        message: `モデル '${role.model}' は ${providerId} では利用できません`,
        checkedAt: now,
        availableModels,
      },
      healthCheck: {
        status: "skipped",
        reason: "モデル検証に失敗したためスキップ",
      },
      available: false,
    };
  }

  /**
   * 職種に対してヘルスチェックプロンプトを実行する。
   * Provider の CLI でヘルスチェックプロンプトを実行し、
   * 正常にレスポンスが返ればチェック通過とする。
   */
  private async runHealthCheckPrompt(
    role: RoleDefinition,
  ): Promise<Pick<HealthCheckResult, "healthCheck" | "available">> {
    const startTime = Date.now();
    const now = () => new Date().toISOString();

    try {
      const { command, args } = getProvider(resolveProviderId(role)).buildHealthCheckCommand(
        role.model,
        role.healthCheckPrompt,
      );
      const result = await this.runner.execCommand(command, args);

      const responseTime_ms = Date.now() - startTime;

      if (result.exitCode !== 0) {
        return {
          healthCheck: {
            status: "failed",
            reason: `ヘルスチェックプロンプトが非ゼロ終了コードで終了しました (exitCode=${result.exitCode})`,
            responseTime_ms,
            checkedAt: now(),
          },
          available: false,
        };
      }

      return {
        healthCheck: {
          status: "passed",
          responseTime_ms,
          checkedAt: now(),
        },
        available: true,
      };
    } catch (error) {
      const responseTime_ms = Date.now() - startTime;
      return {
        healthCheck: {
          status: "failed",
          reason: `ヘルスチェックプロンプトの実行に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          responseTime_ms,
          checkedAt: now(),
        },
        available: false,
      };
    }
  }

  /**
   * 職種に設定されたツールの可用性をチェックする。
   * 各ツールの healthCheckCommand を実行し、exit code 0 なら passed。
   */
  private async checkRoleTools(role: RoleDefinition): Promise<ToolCheckResult[]> {
    const results: ToolCheckResult[] = [];

    for (const toolId of role.tools ?? []) {
      const toolDef = getToolDefinition(toolId);
      if (!toolDef) {
        results.push({
          toolId,
          status: "failed",
          reason: `ツール定義が見つかりません: ${toolId}`,
        });
        continue;
      }

      if (!toolDef.healthCheckCommand) {
        // ヘルスチェックコマンドが未定義のツールは passed とみなす
        results.push({ toolId, status: "passed" });
        continue;
      }

      try {
        const result = await this.runner.execCommand(
          toolDef.healthCheckCommand.command,
          toolDef.healthCheckCommand.args,
        );

        if (result.exitCode !== 0) {
          results.push({
            toolId,
            status: "failed",
            reason: `コマンドが非ゼロ終了 (exitCode=${result.exitCode})。${toolDef.name} がインストールされているか確認してください`,
          });
        } else {
          results.push({ toolId, status: "passed" });
        }
      } catch (error) {
        results.push({
          toolId,
          status: "failed",
          reason: `コマンド実行失敗: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return results;
  }
}
