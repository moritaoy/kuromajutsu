// ============================================================
// Kuromajutsu エントリーポイント
// ============================================================

import { loadConfig } from "./config/loader.js";
import { createMcpServer, startMcpServer } from "./mcp/server.js";
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

  // 3. ダッシュボード HTTP サーバー起動
  startDashboardServer(config);

  // 4. ヘルスチェック実行
  const checker = new HealthChecker(config);
  const healthResults = await checker.runAll();
  manager.setHealthCheckResults(healthResults);

  // 5. MCP サーバー起動（stdio）
  const mcpServer = createMcpServer(config, manager);
  await startMcpServer(mcpServer);
}

main().catch((err) => {
  console.error("[kuromajutsu] 致命的エラー:", err);
  process.exit(1);
});
