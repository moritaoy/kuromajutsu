// ============================================================
// MCP サーバー テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { loadConfig } from "../../src/config/loader.js";

describe("MCPServer", () => {
  it("サーバーインスタンスを作成できる", () => {
    const config = loadConfig();
    const server = createMcpServer(config);
    expect(server).toBeDefined();
  });
});
