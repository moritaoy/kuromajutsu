// ============================================================
// WebSocket 接続管理テスト
// ============================================================

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { WebSocket } from "ws";
import type { Server } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager.js";
import { startDashboardServer } from "../../src/dashboard/server.js";
import type { AppConfig, ServerEvent } from "../../src/types/index.js";

/** テスト用の最小設定 */
function createTestConfig(port: number): AppConfig {
  return {
    dashboard: { port },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        model: "claude-4-sonnet",
        systemPrompt: "テスト用プロンプト",
        healthCheckPrompt: "Hello",
      },
    ],
  };
}

/** WebSocket 接続を確立しメッセージを収集するヘルパー */
function connectWs(port: number): Promise<{
  ws: WebSocket;
  messages: ServerEvent[];
  waitForMessages: (count: number, timeout?: number) => Promise<ServerEvent[]>;
}> {
  return new Promise((resolve, reject) => {
    const messages: ServerEvent[] = [];
    const ws = new WebSocket(`ws://localhost:${port}`);

    ws.on("open", () => {
      resolve({
        ws,
        messages,
        waitForMessages: (count: number, timeout = 3000) => {
          return new Promise<ServerEvent[]>((res, rej) => {
            const check = () => {
              if (messages.length >= count) {
                res(messages.slice(0, count));
              }
            };
            check(); // 既に十分なメッセージがある場合
            ws.on("message", () => setTimeout(check, 10));
            setTimeout(() => rej(new Error(`Timeout waiting for ${count} messages, got ${messages.length}`)), timeout);
          });
        },
      });
    });

    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        messages.push(event);
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", reject);
  });
}

/** サーバーの listening を待機する */
function waitForServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve();
    } else {
      server.on("listening", () => resolve());
    }
  });
}

describe("WebSocket", () => {
  let server: Server;
  let manager: AgentManager;
  const port = 29696; // テスト用ポート
  const clients: WebSocket[] = [];
  let tmpConfigPath: string;

  beforeEach(() => {
    // テスト用の一時設定ファイルを作成（実ファイルを汚さないため）
    tmpConfigPath = join(tmpdir(), `kuromajutsu-test-${Date.now()}.yaml`);
    writeFileSync(tmpConfigPath, "# test config\n", "utf-8");
    process.env["KUROMAJUTSU_CONFIG"] = tmpConfigPath;

    const config = createTestConfig(port);
    manager = new AgentManager(config);
    server = startDashboardServer(config, manager);
  });

  afterEach(async () => {
    // クライアント切断
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    clients.length = 0;

    // サーバー停止
    await new Promise<void>((resolve) => {
      if (server) {
        server.closeAllConnections();
        server.close(() => resolve());
      } else {
        resolve();
      }
    });

    // 一時ファイルのクリーンアップ
    try { unlinkSync(tmpConfigPath); } catch { /* ignore */ }
    delete process.env["KUROMAJUTSU_CONFIG"];
  });

  it("should accept WebSocket connections", async () => {
    await waitForServer(server);
    const { ws } = await connectWs(port);
    clients.push(ws);

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("should send server:startup on connection", async () => {
    await waitForServer(server);
    const { ws, waitForMessages } = await connectWs(port);
    clients.push(ws);

    const msgs = await waitForMessages(1);
    expect(msgs[0].type).toBe("server:startup");
    if (msgs[0].type === "server:startup") {
      expect(msgs[0].data.startedAt).toBeDefined();
    }
  });

  it("should send healthcheck:complete if results exist", async () => {
    // ヘルスチェック結果を事前に設定
    manager.setHealthCheckResults([
      {
        roleId: "impl-code",
        modelValidation: { status: "valid", checkedAt: new Date().toISOString() },
        healthCheck: { status: "passed", responseTime_ms: 100, checkedAt: new Date().toISOString() },
        available: true,
      },
    ]);

    await waitForServer(server);
    const { ws, waitForMessages } = await connectWs(port);
    clients.push(ws);

    // server:startup + config:updated + healthcheck:complete の3つ
    const msgs = await waitForMessages(3);
    expect(msgs[1].type).toBe("config:updated");
    expect(msgs[2].type).toBe("healthcheck:complete");
  });

  it("should broadcast group:created event to all clients", async () => {
    await waitForServer(server);

    // 2つのクライアントを接続
    const client1 = await connectWs(port);
    clients.push(client1.ws);
    const client2 = await connectWs(port);
    clients.push(client2.ws);

    // 初期メッセージ（server:startup + config:updated）を待つ
    await client1.waitForMessages(2);
    await client2.waitForMessages(2);

    // グループを作成
    manager.createGroup("テストグループ");

    // 両方のクライアントが group:created を受信
    const msgs1 = await client1.waitForMessages(3);
    const msgs2 = await client2.waitForMessages(3);

    expect(msgs1[2].type).toBe("group:created");
    expect(msgs2[2].type).toBe("group:created");
  });

  it("should broadcast agent:created event to all clients", async () => {
    await waitForServer(server);
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(2); // server:startup + config:updated

    const group = manager.createGroup("テスト");
    await waitForMessages(3); // + group:created

    // Agent を起動（executor は失敗するが agent:created イベントは発火する）
    const role = {
      id: "impl-code",
      name: "コード実装者",
      model: "claude-4-sonnet",
      systemPrompt: "テスト",
      healthCheckPrompt: "Hello",
    };
    try {
      manager.startAgent(group.id, role, "テストプロンプト");
    } catch {
      // executor 失敗は無視
    }

    await waitForMessages(4); // + agent:created

    const agentCreatedMsg = messages.find((m) => m.type === "agent:created");
    expect(agentCreatedMsg).toBeDefined();
  });

  it("should include prompt in agent:created event", async () => {
    await waitForServer(server);
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(2); // server:startup + config:updated

    const group = manager.createGroup("テスト");
    await waitForMessages(3); // + group:created

    const role = {
      id: "impl-code",
      name: "コード実装者",
      model: "claude-4-sonnet",
      systemPrompt: "テスト",
      healthCheckPrompt: "Hello",
    };
    try {
      manager.startAgent(group.id, role, "hoge1.md を編集してください");
    } catch {
      // executor 失敗は無視
    }

    await waitForMessages(4); // + agent:created

    const agentCreatedMsg = messages.find((m) => m.type === "agent:created");
    expect(agentCreatedMsg).toBeDefined();
    if (agentCreatedMsg && agentCreatedMsg.type === "agent:created") {
      expect(agentCreatedMsg.data.prompt).toBe("hoge1.md を編集してください");
    }
  });

  it("should broadcast agent:status_update event", async () => {
    await waitForServer(server);
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(2); // server:startup + config:updated

    const group = manager.createGroup("テスト");
    await waitForMessages(3); // + group:created

    // Agent を直接 Map に追加（executor をバイパス）
    const role = {
      id: "impl-code",
      name: "コード実装者",
      model: "claude-4-sonnet",
      systemPrompt: "テスト",
      healthCheckPrompt: "Hello",
    };
    try {
      manager.startAgent(group.id, role, "テストプロンプト");
    } catch {
      // executor 失敗は無視
    }

    // startAgent で agent:created が発火する
    // updateAgentState で agent:status_update を発火
    const agents = manager.listAgents();
    if (agents.length > 0) {
      manager.updateAgentState(agents[0].agentId, {
        lastAssistantMessage: "テストメッセージ",
      });
    }

    // メッセージの中に agent:status_update があることを確認
    await new Promise((r) => setTimeout(r, 100));
    const statusUpdate = messages.find((m) => m.type === "agent:status_update");
    expect(statusUpdate).toBeDefined();
  });

  it("should send current groups and agents on connection", async () => {
    await waitForServer(server);

    // まずグループを作成
    manager.createGroup("既存グループ");

    // 後からクライアントが接続
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    // server:startup + healthcheck or initial state
    await waitForMessages(1);
    await new Promise((r) => setTimeout(r, 200));

    // 初期状態としてグループ情報が送信されることを確認
    const groupMsg = messages.find((m) => m.type === "group:created");
    expect(groupMsg).toBeDefined();
  });

  it("should send availableModels in initial state", async () => {
    // 利用可能モデル一覧を設定
    manager.setAvailableModels(["claude-4-sonnet", "claude-4-opus", "gpt-4o"]);

    await waitForServer(server);
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(1); // server:startup
    await new Promise((r) => setTimeout(r, 200));

    // server:startup イベントに availableModels が含まれる
    const startupMsg = messages.find((m) => m.type === "server:startup");
    expect(startupMsg).toBeDefined();
    if (startupMsg && startupMsg.type === "server:startup") {
      expect(startupMsg.data.availableModels).toEqual([
        "claude-4-sonnet",
        "claude-4-opus",
        "gpt-4o",
      ]);
    }
  });

  it("should send empty availableModels if not set", async () => {
    await waitForServer(server);
    const { ws, messages, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(1); // server:startup
    await new Promise((r) => setTimeout(r, 200));

    const startupMsg = messages.find((m) => m.type === "server:startup");
    expect(startupMsg).toBeDefined();
    if (startupMsg && startupMsg.type === "server:startup") {
      expect(startupMsg.data.availableModels).toEqual([]);
    }
  });

  it("should handle client:config:update_role event", async () => {
    await waitForServer(server);
    const { ws, waitForMessages } = await connectWs(port);
    clients.push(ws);

    await waitForMessages(1); // server:startup

    // config:update_role イベントを送信
    ws.send(JSON.stringify({
      type: "config:update_role",
      data: { id: "impl-code", model: "gpt-4o" },
    }));

    // エラーなく処理されることを確認（例外が飛ばない）
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("should handle client disconnection gracefully", async () => {
    await waitForServer(server);
    const { ws, waitForMessages } = await connectWs(port);

    await waitForMessages(1); // server:startup

    // クライアント切断
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // グループを作成しても例外が飛ばないことを確認
    expect(() => manager.createGroup("切断後テスト")).not.toThrow();
  });
});
