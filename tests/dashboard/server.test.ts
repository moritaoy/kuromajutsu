// ============================================================
// ダッシュボード HTTP サーバー テスト
// ============================================================

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { request } from "node:http";
import type { Server } from "node:http";
import { AgentManager } from "../../src/agent/manager.js";
import { startDashboardServer } from "../../src/dashboard/server.js";
import type { AppConfig } from "../../src/types/index.js";

/** テスト用の最小設定 */
function createTestConfig(port: number): AppConfig {
  return {
    dashboard: { port },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [],
  };
}

/** HTTP リクエストを Promise で実行するヘルパー */
function httpGet(
  url: string,
): Promise<{ status: number; headers: Record<string, string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | undefined>,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("DashboardServer", () => {
  let server: Server;
  const port = 19696;

  beforeAll(async () => {
    const config = createTestConfig(port);
    const manager = new AgentManager(config);
    server = startDashboardServer(config, manager);
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.on("listening", () => resolve());
      }
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  it("should serve index.html at /", async () => {
    const res = await httpGet(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Kuromajutsu");
  });

  it("should serve CSS files with correct MIME type", async () => {
    const res = await httpGet(`http://localhost:${port}/styles/theme.css`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
  });

  it("should serve JS files with correct MIME type", async () => {
    const res = await httpGet(`http://localhost:${port}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
  });

  it("should return SPA fallback for unknown routes", async () => {
    const res = await httpGet(`http://localhost:${port}/nonexistent-page`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Kuromajutsu");
  });

  it("should respond to /api/ endpoint", async () => {
    const res = await httpGet(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = JSON.parse(res.body);
    expect(json.status).toBe("ok");
    expect(json.version).toBe("0.1.0");
  });
});
