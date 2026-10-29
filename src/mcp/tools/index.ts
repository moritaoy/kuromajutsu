// ============================================================
// MCP ツール登録（エントリーポイント）
// ============================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../types/index.js";
import type { AgentManager } from "../../agent/manager.js";
import { registerCreateGroup } from "./create-group.js";
import { registerDeleteGroup } from "./delete-group.js";
import { registerRunAgents } from "./run-agents.js";
import { registerRunSequential } from "./run-sequential.js";
import { registerRunMagentic } from "./run-magentic.js";
import { registerListAgents } from "./list-agents.js";
import { registerGetAgentStatus } from "./get-agent-status.js";
import { registerWaitAgent } from "./wait-agent.js";
import { registerReportResult } from "./report-result.js";
import { registerListRoles } from "./list-roles.js";
import { registerUpdateLedger } from "./update-ledger.js";
import { registerRunGateCheck } from "./run-gate-check.js";
import { registerReportGateResult } from "./report-gate-result.js";
import { registerRequestHumanReview } from "./request-human-review.js";
import type { WorkspaceService } from "../../workspace/service.js";

/**
 * 全 14 ツールをサーバーに登録する
 *
 * @param workspaceService Workspace サービス（省略時、Workspace 専用ツールは NOT_WORKSPACE_GROUP を返す）
 */
export function registerTools(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager,
  workspaceService?: WorkspaceService,
): void {
  registerCreateGroup(server, config, manager);
  registerDeleteGroup(server, config, manager);
  registerRunAgents(server, config, manager);
  registerRunSequential(server, config, manager);
  registerRunMagentic(server, config, manager);
  registerListAgents(server, config, manager);
  registerGetAgentStatus(server, config, manager);
  registerWaitAgent(server, config, manager);
  registerReportResult(server, config, manager);
  registerListRoles(server, config);
  registerUpdateLedger(server, config, manager, workspaceService);
  registerRunGateCheck(server, config, manager, workspaceService);
  registerReportGateResult(server, config, manager, workspaceService);
  registerRequestHumanReview(server, config, manager, workspaceService);
}
