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
import { WorkspaceStore } from "./workspace/store.js";
import { WorkspaceService } from "./workspace/service.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  console.error("[kuromajutsu] 起動中...");

  // 1. 設定読み込み
  const config = loadConfig();
  console.error(`[kuromajutsu] 設定読み込み完了 (port=${config.dashboard.port}, roles=${config.roles.length})`);

  // 2. AgentManager 作成
  const manager = new AgentManager(config);

  // 3. Workspace（§13）: 保存先 .kuromajutsu/ から復元し、サービスを作成
  //    （MCP ツール run_gate_check / report_gate_result / request_human_review / update_ledger が使うため、MCP の前に作る）
  const workspaceStore = new WorkspaceStore(resolve(process.cwd(), ".kuromajutsu"));
  const restored = workspaceStore.loadAll();
  if (restored.length > 0) {
    console.error(`[kuromajutsu] Workspace を ${restored.length} 件復元しました`);
  }
  const workspaceService = new WorkspaceService(config, manager, workspaceStore);

  // 終了シグナル: 実行中のゲートの command（子プロセス）を止めてから終了する
  const shutdown = (signal: string): void => {
    console.error(`[kuromajutsu] ${signal} を受信しました。終了します`);
    try {
      workspaceService.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // 3.5. MCP HTTP ハンドラー作成（Streamable HTTP トランスポート）
  const mcpHttpHandler = createMcpHttpHandler(config, manager, workspaceService);

  // 4. ダッシュボード HTTP + WebSocket サーバー起動（MCP エンドポイント付き）
  startDashboardServer(config, manager, mcpHttpHandler, workspaceService);

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
  manager.setAvailableModelsByProvider(checker.availableModelsByProvider);

  // 6. MCP サーバー起動（stdio — Cursor からプロセス起動された場合のみ）
  if (!process.stdin.isTTY) {
    const mcpServer = createMcpServer(config, manager, workspaceService);
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
