# Phase 2 完了メモ — MCPサーバーツール実装

## 実施日
2026-02-14

## 概要
`3-implement.md` の **Phase 2: MCPサーバー実装** を TDD で実装完了。
全8つの MCP ツールを AgentManager と連携する形で実装し、テストを作成した。

## 実装したコンポーネント

| ファイル | 関数 | テスト数 | 説明 |
|---------|------|---------|------|
| `src/mcp/server.ts` | `createMcpServer(config, manager)` | 1 | AgentManager を受け取るように変更 |
| `src/mcp/tools/index.ts` | `registerTools(server, config, manager)` | — | AgentManager を全ツールに注入 |
| `src/mcp/tools/create-group.ts` | `handleCreateGroup` | 3 | グループ作成（AgentManager.createGroup 委譲） |
| `src/mcp/tools/delete-group.ts` | `handleDeleteGroup` | 5 | グループ削除（存在・実行中チェック付き） |
| `src/mcp/tools/list-roles.ts` | `handleListRoles` | 4 | 職種一覧（ヘルスチェック結果統合） |
| `src/mcp/tools/run-agent.ts` | `handleRunAgent` | 8 | Agent 起動（5段バリデーション） |
| `src/mcp/tools/list-agents.ts` | `handleListAgents` | 5 | Agent 一覧（groupId/status フィルタ） |
| `src/mcp/tools/get-agent-status.ts` | `handleGetAgentStatus` | 3 | Agent 詳細取得（elapsed_ms 再計算） |
| `src/mcp/tools/wait-agent.ts` | `handleWaitAgent` | 4 | Agent 完了待機（all/any/timeout） |
| `src/mcp/tools/report-result.ts` | `handleReportResult` | 6 | 結果登録（ステータスバリデーション付き） |
| `src/index.ts` | — | — | AgentManager 作成・ヘルスチェック結果注入 |

**テスト合計: 117 件（Phase 2 新規: 38 件）/ 全体: 117 件**

## テストファイル

| ファイル | テスト数 | カバー範囲 |
|---------|---------|-----------|
| `tests/mcp/server.test.ts` | 1 | サーバーインスタンス作成（AgentManager 付き） |
| `tests/mcp/tools/create-group.test.ts` | 3 | 作成・登録確認・group:created イベント |
| `tests/mcp/tools/delete-group.test.ts` | 5 | NOT_FOUND・正常削除・status 確認・実行中 Agent エラー・イベント |
| `tests/mcp/tools/list-roles.test.ts` | 4 | 全職種返却・未チェック時・チェック結果反映・フィールド確認 |
| `tests/mcp/tools/run-agent.test.ts` | 8 | NOT_FOUND・NOT_ACTIVE・ROLE_NOT_FOUND・UNAVAILABLE・MAX_CONCURRENT・正常起動・登録確認・イベント |
| `tests/mcp/tools/list-agents.test.ts` | 5 | 空一覧・全件取得・groupId フィルタ・status=all・フィールド確認 |
| `tests/mcp/tools/get-agent-status.test.ts` | 3 | NOT_FOUND・詳細返却・lastAssistantMessage null 確認 |
| `tests/mcp/tools/wait-agent.test.ts` | 4 | NOT_FOUND・既完了即返り・タイムアウト・mode=any |
| `tests/mcp/tools/report-result.test.ts` | 6 | NOT_FOUND・正常登録・queued 状態エラー・status 確認・イベント・失敗結果 |

## 設計パターン

### ハンドラ関数のエクスポート
各ツールは `handle*` 関数としてビジネスロジックをエクスポートし、テストから直接呼び出し可能にした。
`server.tool()` のコールバックは `async (args) => handle*(manager, args)` のシンプルな委譲のみ。

### エラーレスポンス規約
`{ content: [{ type: "text", text: JSON.stringify({ error: true, code, message }) }], isError: true }` 形式。
共通ヘルパー `errorResponse(code, message)` を `delete-group.ts` と `run-agent.ts` で使用。

### バリデーション順序（run_agent）
1. グループ存在チェック → GROUP_NOT_FOUND
2. グループ active チェック → GROUP_NOT_ACTIVE
3. 職種存在チェック → ROLE_NOT_FOUND
4. ヘルスチェック結果チェック → ROLE_UNAVAILABLE
5. 同時実行数チェック → MAX_CONCURRENT_REACHED

### テストでの状態遷移
AgentManager の状態遷移バリデーションにより、`queued → running → completed` の順序で遷移する必要がある。
テストで `completed` 状態にする場合は必ず `running` を経由すること。

## テスト実行方法

```bash
# 全テスト
docker compose run --rm app npm test

# MCP ツールのみ
docker compose run --rm app npm test -- tests/mcp/

# 個別
docker compose run --rm app npm test -- tests/mcp/tools/create-group.test.ts
docker compose run --rm app npm test -- tests/mcp/tools/run-agent.test.ts
```

## 次のフェーズ（Phase 3: ヘルスチェック実装）

`3-implement.md` と `src/health/checker.ts` に従い、以下を実装する:

1. **モデル検証** — `agent models` コマンドで利用可能モデル一覧を取得し、各職種のモデルと照合
2. **ヘルスチェック** — モデル検証通過済み職種に `healthCheckPrompt` を実行
3. **結果レポート** — コンソール出力と AgentManager への結果登録

**重要:** テスト・ビルドは必ず `docker compose run --rm app ...` で実行すること。ローカル実行は禁止。
