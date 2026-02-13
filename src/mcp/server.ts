// ============================================================
// MCP サーバー本体
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppConfig } from "../types/index.js";
import type { AgentManager } from "../agent/manager.js";
import { registerTools } from "./tools/index.js";

/**
 * MCP サーバーを作成・設定する
 */
export function createMcpServer(
  config: AppConfig,
  manager: AgentManager,
): McpServer {
  const server = new McpServer({
    name: "kuromajutsu",
    version: "0.1.0",
  });

  // ツールを登録
  registerTools(server, config, manager);

  return server;
}

/**
 * MCP サーバーを stdio トランスポートで起動する
 */
export async function startMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] MCP サーバーが stdio で起動しました");
}
