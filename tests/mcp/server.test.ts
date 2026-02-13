// ============================================================
// MCP サーバー テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { loadConfig } from "../../src/config/loader.js";
import { AgentManager } from "../../src/agent/manager.js";

describe("MCPServer", () => {
  it("サーバーインスタンスを作成できる", () => {
    const config = loadConfig();
    const manager = new AgentManager(config);
    const server = createMcpServer(config, manager);
    expect(server).toBeDefined();
  });
});
