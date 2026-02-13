// ============================================================
// ダッシュボード HTTP サーバー + WebSocket
// ============================================================

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../types/index.js";

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

/**
 * ダッシュボード HTTP サーバーを作成・起動する
 */
export function startDashboardServer(config: AppConfig): Server {
  const port = config.dashboard.port;
  const publicDir = resolve(__dirname, "public");

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    // API エンドポイント（将来拡張用）
    if (url.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    // 静的ファイル配信
    const filePath = url === "/" ? resolve(publicDir, "index.html") : resolve(publicDir, url.slice(1));

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
  });

  server.listen(port, () => {
    console.error(`[dashboard] ダッシュボードが http://localhost:${port} で起動しました`);
  });

  // TODO: WebSocket サーバーを同ポートで起動（Step 3 で実装予定）

  return server;
}
