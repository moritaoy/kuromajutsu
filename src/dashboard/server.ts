// ============================================================
// ダッシュボード HTTP サーバー + WebSocket
// ============================================================

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentManager } from "../agent/manager.js";
import type { AppConfig, ServerEvent, ClientEvent } from "../types/index.js";
import { writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** MIME タイプマップ */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** MCP HTTP ハンドラーの型 */
export type McpHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/**
 * ダッシュボード HTTP サーバーを作成・起動する。
 * WebSocket サーバーも同ポートで起動し、AgentManager のイベントを
 * 全クライアントにリアルタイムでブロードキャストする。
 *
 * @param mcpHttpHandler - MCP Streamable HTTP ハンドラー（省略時は /mcp 無効）
 */
export function startDashboardServer(
  config: AppConfig,
  manager: AgentManager,
  mcpHttpHandler?: McpHttpHandler,
): Server {
  const port = config.dashboard.port;
  const publicDir = resolve(__dirname, "public");

  // --------------------------------------------------
  // HTTP サーバー
  // --------------------------------------------------
  const server = createServer((req, res) => {
    handleRequest(req, res, publicDir, mcpHttpHandler).catch((err) => {
      console.error("[dashboard] リクエスト処理エラー:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  });

  // --------------------------------------------------
  // WebSocket サーバー
  // --------------------------------------------------
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    // 初期データ送信
    sendInitialState(ws, manager, config);

    // クライアントからのイベント受信
    ws.on("message", (data: Buffer | string) => {
      try {
        const event = JSON.parse(data.toString()) as ClientEvent;
        handleClientEvent(event, manager, config);
      } catch {
        // JSON パース失敗は無視
      }
    });
  });

  // AgentManager のイベントを全クライアントにブロードキャスト
  setupBroadcast(wss, manager);

  server.listen(port, () => {
    console.error(
      `[dashboard] ダッシュボードが http://localhost:${port} で起動しました`,
    );
  });

  return server;
}

// --------------------------------------------------
// ブロードキャスト
// --------------------------------------------------

/**
 * AgentManager のイベントをリッスンし、全 WebSocket クライアントに
 * ServerEvent として中継する。
 */
function setupBroadcast(
  wss: WebSocketServer,
  manager: AgentManager,
): void {
  const broadcast = (event: ServerEvent) => {
    const message = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(message);
      }
    }
  };

  // グループイベント
  manager.on("group:created", (data) =>
    broadcast({ type: "group:created", data }),
  );
  manager.on("group:updated", (data) =>
    broadcast({ type: "group:updated", data }),
  );
  manager.on("group:deleted", (data) =>
    broadcast({ type: "group:deleted", data }),
  );
  manager.on("group:stage_advanced", (data) =>
    broadcast({ type: "group:stage_advanced", data }),
  );

  // Agent イベント
  manager.on("agent:created", (data) =>
    broadcast({ type: "agent:created", data }),
  );
  manager.on("agent:status_update", (data) =>
    broadcast({ type: "agent:status_update", data }),
  );
  manager.on("agent:completed", (data) =>
    broadcast({ type: "agent:completed", data }),
  );
  manager.on("agent:result_reported", (data) =>
    broadcast({ type: "agent:result_reported", data }),
  );

  // ヘルスチェックイベント
  manager.on("healthcheck:model_validation", (data) =>
    broadcast({ type: "healthcheck:model_validation", data }),
  );
  manager.on("healthcheck:role_start", (data) =>
    broadcast({ type: "healthcheck:role_start", data }),
  );
  manager.on("healthcheck:role_complete", (data) =>
    broadcast({ type: "healthcheck:role_complete", data }),
  );
  manager.on("healthcheck:complete", (data) =>
    broadcast({ type: "healthcheck:complete", data }),
  );

  // 設定変更イベント
  manager.on("config:updated", (data) =>
    broadcast({ type: "config:updated", data }),
  );
}

// --------------------------------------------------
// 初期状態送信
// --------------------------------------------------

/**
 * 新しいクライアントが WebSocket 接続した際、現在の全状態を
 * スナップショットとして送信する。
 */
function sendInitialState(
  ws: WebSocket,
  manager: AgentManager,
  config: AppConfig,
): void {
  // 1. サーバー起動通知（利用可能モデル一覧を含む）
  sendEvent(ws, {
    type: "server:startup",
    data: {
      startedAt: new Date().toISOString(),
      availableModels: manager.getAvailableModels(),
    },
  });

  // 2. 設定情報（職種一覧を含む）を送信
  sendEvent(ws, {
    type: "config:updated",
    data: config,
  });

  // 3. ヘルスチェック結果
  const healthResults = manager.getHealthCheckResults();
  if (healthResults.length > 0) {
    sendEvent(ws, {
      type: "healthcheck:complete",
      data: { results: healthResults },
    });
  }

  // 4. 既存のグループ情報を再送（削除済みグループも Agent が残っていれば送信）
  const allGroups = manager.listGroups();
  const allAgents = manager.listAgents();
  const groupIdsWithAgents = new Set(allAgents.map((a) => a.groupId));

  for (const group of allGroups) {
    if (group.status === "active" || groupIdsWithAgents.has(group.id)) {
      sendEvent(ws, { type: "group:created", data: group });
    }
  }

  // 5. 既存の Agent 情報を再送（削除済みグループの履歴 Agent も含む）
  for (const agent of allAgents) {
    sendEvent(ws, { type: "agent:created", data: agent });
  }
}

// --------------------------------------------------
// クライアントイベント処理
// --------------------------------------------------

/**
 * クライアントから受信したイベントを処理する。
 */
function handleClientEvent(
  event: ClientEvent,
  manager: AgentManager,
  config: AppConfig,
): void {
  switch (event.type) {
    case "config:update_role": {
      const { id, ...updates } = event.data;
      const roleIndex = config.roles.findIndex((r) => r.id === id);
      if (roleIndex === -1) {
        console.warn(`[dashboard] 職種が見つかりません: ${id}`);
        return;
      }

      // 職種設定を更新
      Object.assign(config.roles[roleIndex], updates);

      // kuromajutsu.config.yaml に書き戻し
      try {
        const configPath =
          process.env["KUROMAJUTSU_CONFIG"] ??
          resolve(process.cwd(), "kuromajutsu.config.yaml");
        const yamlContent = stringifyYaml({
          dashboard: config.dashboard,
          agent: config.agent,
          log: config.log,
          roles: config.roles,
        });
        writeFileSync(configPath, yamlContent, "utf-8");
      } catch (err) {
        console.error("[dashboard] 設定ファイルの書き込みに失敗:", err);
      }

      // broadcast
      manager.emit("config:updated", config);
      break;
    }

    case "config:revalidate_model": {
      // モデル再検証はヘルスチェッカーを再実行する必要がある
      // 現時点では通知のみ
      console.error(
        `[dashboard] モデル再検証リクエスト: ${event.data.roleId}`,
      );
      break;
    }
  }
}

// --------------------------------------------------
// ユーティリティ
// --------------------------------------------------

/** WebSocket にイベントを送信する */
function sendEvent(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(event));
  }
}

// --------------------------------------------------
// HTTP リクエストハンドラー
// --------------------------------------------------

/**
 * HTTP リクエストを処理する。
 * /mcp パスは MCP Streamable HTTP トランスポートに委譲し、
 * それ以外は静的ファイル配信を行う。
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  publicDir: string,
  mcpHttpHandler?: McpHttpHandler,
): Promise<void> {
  const url = req.url ?? "/";

  // MCP Streamable HTTP エンドポイント
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    if (mcpHttpHandler) {
      await mcpHttpHandler(req, res);
    } else {
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("MCP HTTP transport not configured");
    }
    return;
  }

  // API エンドポイント（将来拡張用）
  if (url.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
    return;
  }

  // 静的ファイル配信
  const filePath =
    url === "/"
      ? resolve(publicDir, "index.html")
      : resolve(publicDir, url.slice(1));

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    // SPA フォールバック: index.html を返す
    try {
      const indexContent = readFileSync(resolve(publicDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexContent);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
}
