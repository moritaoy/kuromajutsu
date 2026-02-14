// ============================================================
// ヘルスチェック・モデル検証
// ============================================================
//
// 責務:
// - MCPサーバー起動時に自動実行
// - agent models コマンドで利用可能モデル一覧を取得
// - 各職種に設定されたモデルが利用可能か照合
// - モデル検証通過済みの職種に対して healthCheckPrompt で動作確認
// - 結果をコンソールと WebSocket（ダッシュボード）にリアルタイム通知

import { execFile } from "node:child_process";
import type { AppConfig, HealthCheckResult, RoleDefinition } from "../types/index.js";

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
      execFile(command, args, { timeout: 60_000 }, (error, stdout, _stderr) => {
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
    });
  }
}

// --------------------------------------------------
// HealthChecker
// --------------------------------------------------

/**
 * MCPサーバー起動時にモデル検証とヘルスチェックプロンプトを実行する。
 *
 * フロー:
 * 1. `agent models` で利用可能モデル一覧を取得
 * 2. 各職種のモデルを一覧と照合（モデル検証）
 * 3. モデル検証通過済み職種に `healthCheckPrompt` を実行
 * 4. 結果を HealthCheckResult[] として返却
 */
export class HealthChecker {
  private runner: CliRunner;

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

    // 1. agent models で利用可能モデル一覧を取得
    const availableModels = await this.getAvailableModels();

    // 2. 各職種のモデル検証
    const results: HealthCheckResult[] = this.config.roles.map((role) =>
      this.validateModel(role, availableModels),
    );

    // モデル検証結果をコールバック通知
    callbacks?.onModelValidation?.(results);

    // モデル検証結果のコンソール出力
    for (const result of results) {
      const icon = result.modelValidation.status === "valid" ? "✅" : "❌";
      const role = this.config.roles.find((r) => r.id === result.roleId);
      console.error(
        `[health]   ${icon} ${result.roleId} (${role?.model ?? "?"}) — モデル検証: ${result.modelValidation.status}`,
      );
    }

    // 3. モデル検証通過済み職種にヘルスチェックプロンプトを実行
    for (const result of results) {
      if (result.modelValidation.status !== "valid") {
        // モデル検証失敗 → スキップ
        continue;
      }

      const role = this.config.roles.find((r) => r.id === result.roleId);
      if (!role) continue;

      // コールバック: チェック開始
      callbacks?.onRoleCheckStart?.(role.id);

      // ヘルスチェックプロンプト実行
      const healthResult = await this.runHealthCheckPrompt(role);

      // 結果を反映
      result.healthCheck = healthResult.healthCheck;
      result.available = healthResult.available;

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
   * `agent models` コマンドを実行し、利用可能モデル一覧を取得する。
   * 失敗した場合は null を返す。
   */
  private async getAvailableModels(): Promise<string[] | null> {
    try {
      const result = await this.runner.execCommand("agent", ["models"]);

      if (result.exitCode !== 0) {
        console.error(
          `[health] agent models コマンドが失敗しました (exitCode=${result.exitCode})`,
        );
        return null;
      }

      // 各行をトリムし、空行を除外してモデル名の配列にする
      const models = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      console.error(
        `[health] 利用可能モデル: ${models.join(", ")} (${models.length} 件)`,
      );

      return models;
    } catch (error) {
      console.error(
        `[health] agent models コマンドの実行に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
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

    // agent models が失敗した場合は全職種 invalid
    if (availableModels === null) {
      return {
        roleId: role.id,
        modelValidation: {
          status: "invalid",
          message: "agent models コマンドの実行に失敗したため検証できません",
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
    const isValid = availableModels.includes(role.model);

    if (isValid) {
      return {
        roleId: role.id,
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
      modelValidation: {
        status: "invalid",
        message: `モデル '${role.model}' は利用できません`,
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
   * `agent -p -m {model} "{healthCheckPrompt}"` コマンドを実行し、
   * 正常にレスポンスが返ればチェック通過とする。
   */
  private async runHealthCheckPrompt(
    role: RoleDefinition,
  ): Promise<Pick<HealthCheckResult, "healthCheck" | "available">> {
    const startTime = Date.now();
    const now = () => new Date().toISOString();

    try {
      const result = await this.runner.execCommand("agent", [
        "-p",
        "-m",
        role.model,
        role.healthCheckPrompt,
      ]);

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
}
