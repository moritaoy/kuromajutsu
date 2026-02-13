// ============================================================
// Kuromajutsu エントリーポイント
// ============================================================

import { loadConfig } from "./config/loader.js";
import { createMcpServer, startMcpServer } from "./mcp/server.js";
import { startDashboardServer } from "./dashboard/server.js";
import { HealthChecker } from "./health/checker.js";

async function main(): Promise<void> {
  console.error("[kuromajutsu] 起動中...");

  // 1. 設定読み込み
  const config = loadConfig();
  console.error(`[kuromajutsu] 設定読み込み完了 (port=${config.dashboard.port}, roles=${config.roles.length})`);

  // 2. ダッシュボード HTTP サーバー起動
  startDashboardServer(config);

  // 3. ヘルスチェック実行
  const checker = new HealthChecker(config);
  await checker.runAll();

  // 4. MCP サーバー起動（stdio）
  const mcpServer = createMcpServer(config);
  await startMcpServer(mcpServer);
}

main().catch((err) => {
  console.error("[kuromajutsu] 致命的エラー:", err);
  process.exit(1);
});
