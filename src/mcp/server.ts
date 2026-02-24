// ============================================================
// MCP サーバー本体
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../types/index.js";
import type { AgentManager } from "../agent/manager.js";
import { registerTools } from "./tools/index.js";

// ------------------------------------------------------------
// MCP Instructions — セッションのシステムプロンプトに自動注入される
// ------------------------------------------------------------
const MCP_INSTRUCTIONS = `\
kuromajutsu（黒魔術）— Cursor Agent 並列実行管理システム

kuromajutsu（別名: 黒魔術）は、複数のサブ Agent を並列・直列に起動・管理するシステムです。
「kuromajutsu」「黒魔術」どちらの呼称でも同じシステムを指します。

## いつ使うべきか

以下のような場合に、kuromajutsu（黒魔術）を使って実行してください：

- コードの更新やテキスト編集が **複数のファイルやスコープにまたがる** 場合
- 実装・テスト・レビューなど **異なる種類のタスク** を同時に進行できる場合
- 独立した変更を **それぞれ適切なスコープに分割** して並行処理できる場合
- 調査→実装→テストのように **前段の結果を踏まえて段階的に進める** 場合

逆に、以下の場合は kuromajutsu を使わず直接実行してください：

- 単一ファイルの小さな変更

## 実行モード

### Concurrent モード（並列実行）
独立したタスクを同時に実行する場合に使用する。

1. \`list_roles\` で利用可能な職種（role）を確認する
2. \`create_group\` でタスクグループを作成する（mode 省略で concurrent）
3. \`run_agents\` で 1 台以上の Agent を一括起動する
   - 各 Agent には明確で自己完結的なプロンプトを渡す
   - 変更対象のファイルパスや具体的な指示を含める
4. \`wait_agent\` で完了を待機する
5. \`get_agent_status\` で結果を確認する
6. 必要に応じて後続タスクを起動する
7. \`delete_group\` でグループを削除する

### Sequential モード（ステージ制直列実行）
調査→実装→テストのように、段階的にタスクを進める場合に使用する。
各ステージ内の Agent は並列実行され、ステージ間は直列に実行される。
前ステージの結果（summary + response）は次ステージのプロンプトに自動注入される。

1. \`list_roles\` で利用可能な職種を確認する
2. \`create_group\` でグループを作成する（mode: "sequential"）
3. \`run_sequential\` でステージ制の実行計画を投入する
   - stages 配列で実行順序を定義
   - 各ステージの tasks で並列実行する Agent を指定
4. \`wait_agent\` で全 Agent の完了を待機する
5. \`get_agent_status\` で結果を確認する
6. \`delete_group\` でグループを削除する

## 並列化のコツ

- タスクを **ファイル単位** や **機能単位** で分割する
- 各 Agent のプロンプトには **変更対象のスコープ** を明示する
- 同一ファイルの同時編集は競合するため避ける
- 依存関係がある場合は Sequential モードの **ステージ** で順序制御する
`;

/**
 * MCP サーバーを作成・設定する
 */
export function createMcpServer(
  config: AppConfig,
  manager: AgentManager,
): McpServer {
  const server = new McpServer(
    {
      name: "kuromajutsu",
      version: "0.1.0",
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

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

/**
 * HTTP 経由で MCP リクエストを処理するハンドラーを作成する。
 * Streamable HTTP トランスポートを使用し、セッション単位で
 * McpServer + Transport ペアを管理する。
 */
export function createMcpHttpHandler(
  config: AppConfig,
  manager: AgentManager,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // 既存セッションへのリクエスト
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (transport) {
        await transport.handleRequest(req, res);
        return;
      }
      // 不明なセッション ID
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }

    // セッション ID なし — 初期化リクエスト（POST のみ）
    if (req.method !== "POST") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: Session ID required for non-POST requests");
      return;
    }

    // 新規セッションを作成
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, transport);
        console.error(`[mcp] HTTP セッション開始: ${sid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.error(`[mcp] HTTP セッション終了: ${transport.sessionId}`);
      }
    };

    // このセッション用の McpServer を作成しツールを登録
    const server = createMcpServer(config, manager);
    await server.connect(transport);

    await transport.handleRequest(req, res);
  };
}
