// ============================================================
// Kuromajutsu エントリーポイント
// ============================================================

import { loadConfig } from "./config/loader.js";
import {
  createMcpServer,
  startMcpServer,
  createMcpHttpHandler,
} from "./mcp/server.js";
import { startDashboardServer } from "./dashboard/server.js";
import { HealthChecker } from "./health/checker.js";
import { AgentManager } from "./agent/manager.js";

async function main(): Promise<void> {
  console.error("[kuromajutsu] 起動中...");

  // 1. 設定読み込み
  const config = loadConfig();
  console.error(`[kuromajutsu] 設定読み込み完了 (port=${config.dashboard.port}, roles=${config.roles.length})`);

  // 2. AgentManager 作成
  const manager = new AgentManager(config);

  // 3. MCP HTTP ハンドラー作成（Streamable HTTP トランスポート）
  const mcpHttpHandler = createMcpHttpHandler(config, manager);

  // 4. ダッシュボード HTTP + WebSocket サーバー起動（MCP エンドポイント付き）
  startDashboardServer(config, manager, mcpHttpHandler);

  // 5. ヘルスチェック実行（コールバックで AgentManager にリアルタイム通知）
  const checker = new HealthChecker(config);
  const healthResults = await checker.runAll({
    onModelValidation: (results) => {
      manager.emit("healthcheck:model_validation", { results });
    },
    onRoleCheckStart: (roleId) => {
      manager.emit("healthcheck:role_start", { roleId });
    },
    onRoleCheckComplete: (result) => {
      manager.emit("healthcheck:role_complete", result);
    },
    onComplete: (results) => {
      manager.emit("healthcheck:complete", { results });
    },
  });
  manager.setHealthCheckResults(healthResults);
  manager.setAvailableModels(checker.availableModels);

  // 6. MCP サーバー起動（stdio — Cursor からプロセス起動された場合のみ）
  if (!process.stdin.isTTY) {
    const mcpServer = createMcpServer(config, manager);
    await startMcpServer(mcpServer);
  } else {
    console.error(
      `[mcp] MCP HTTP トランスポートが http://localhost:${config.dashboard.port}/mcp で利用可能です`,
    );
    console.error("[mcp] stdio トランスポートはスキップしました（TTY 検出）");
  }
}

main().catch((err) => {
  console.error("[kuromajutsu] 致命的エラー:", err);
  process.exit(1);
});
