// ============================================================
// MCP ツール登録（エントリーポイント）
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { registerCreateGroup } from "./create-group.js";
import { registerDeleteGroup } from "./delete-group.js";
import { registerRunAgent } from "./run-agent.js";
import { registerListAgents } from "./list-agents.js";
import { registerGetAgentStatus } from "./get-agent-status.js";
import { registerWaitAgent } from "./wait-agent.js";
import { registerReportResult } from "./report-result.js";
import { registerListRoles } from "./list-roles.js";

/**
 * 全 8 ツールをサーバーに登録する
 */
export function registerTools(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
): void {
  registerCreateGroup(server, config, manager);
  registerDeleteGroup(server, config, manager);
  registerRunAgent(server, config, manager);
  registerListAgents(server, config, manager);
  registerGetAgentStatus(server, config, manager);
  registerWaitAgent(server, config, manager);
  registerReportResult(server, config, manager);
  registerListRoles(server, config, manager);
}
