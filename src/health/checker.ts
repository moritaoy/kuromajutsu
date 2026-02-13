// ============================================================
// ヘルスチェック・モデル検証
// ============================================================

// TODO: Step 3（実装フェーズ）で実装予定
//
// 責務:
// - MCPサーバー起動時に自動実行
// - agent models コマンドで利用可能モデル一覧を取得
// - 各職種に設定されたモデルが利用可能か照合
// - モデル検証通過済みの職種に対して healthCheckPrompt で動作確認
// - 結果をコンソールと WebSocket（ダッシュボード）にリアルタイム通知

import type { AppConfig, HealthCheckResult } from "../types/index.js";

export class HealthChecker {
  constructor(private config: AppConfig) {}

  /**
   * 全職種のヘルスチェックを実行する
   */
  async runAll(): Promise<HealthCheckResult[]> {
    console.error("[health] ヘルスチェックを開始します...");

    const results: HealthCheckResult[] = this.config.roles.map((role) => ({
      roleId: role.id,
      modelValidation: {
        status: "valid" as const,
        checkedAt: new Date().toISOString(),
      },
      healthCheck: {
        status: "skipped" as const,
        reason: "セットアップ段階のためスキップ",
      },
      available: true,
    }));

    console.error(`[health] ヘルスチェック完了: ${results.length} 職種`);
    return results;
  }
}
