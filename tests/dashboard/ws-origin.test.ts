// ============================================================
// WebSocket upgrade の Origin 検査テスト
//
// HTTP API と同じ規則（Origin が Host と一致、loopback 同士はポート一致）。
// Origin ヘッダーが無い接続（ブラウザ以外のクライアント）は許可する。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager.js";
import { startDashboardServer } from "../../src/dashboard/server.js";
import type { AppConfig } from "../../src/types/index.js";

const port = 29700;

function createTestConfig(): AppConfig {
  return {
    dashboard: { port },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        description: "コードの実装・修正を行う",
        model: "claude-4-sonnet",
        systemPrompt: "テスト用プロンプト",
        healthCheckPrompt: "Hello",
      },
    ],
  };
}

/** 接続結果（open / 拒否時のエラーメッセージ）を返す */
function tryConnect(origin?: string): Promise<{ opened: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`, origin !== undefined ? { origin } : {});
    ws.on("open", () => {
      ws.close();
      resolve({ opened: true });
    });
    ws.on("error", (err) => resolve({ opened: false, error: err.message }));
  });
}

describe("WebSocket upgrade の Origin 検査", () => {
  let server: Server;
  let tmpConfigPath: string;

  beforeEach(async () => {
    tmpConfigPath = join(tmpdir(), `kuromajutsu-ws-origin-${Date.now()}.yaml`);
    writeFileSync(tmpConfigPath, "# test config\n", "utf-8");
    process.env["KUROMAJUTSU_CONFIG"] = tmpConfigPath;

    const config = createTestConfig();
    server = startDashboardServer(config, new AgentManager(config));
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    try { unlinkSync(tmpConfigPath); } catch { /* ignore */ }
    delete process.env["KUROMAJUTSU_CONFIG"];
  });

  it("Origin が無い接続は許可される", async () => {
    expect((await tryConnect()).opened).toBe(true);
  });

  it("Origin が http://localhost:<port>（Host と同じ）なら許可される", async () => {
    expect((await tryConnect(`http://localhost:${port}`)).opened).toBe(true);
  });

  it("Origin が loopback の同ポート（127.0.0.1）なら許可される", async () => {
    expect((await tryConnect(`http://127.0.0.1:${port}`)).opened).toBe(true);
  });

  it("Origin が他サイト（http://evil.example）なら 403 で拒否される", async () => {
    const r = await tryConnect("http://evil.example");
    expect(r.opened).toBe(false);
    expect(r.error).toContain("403");
  });

  it("Origin が loopback でもポートが違えば 403 で拒否される", async () => {
    const r = await tryConnect(`http://localhost:${port + 1}`);
    expect(r.opened).toBe(false);
    expect(r.error).toContain("403");
  });
});
