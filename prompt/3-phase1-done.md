# Phase 1 完了メモ — Agent 実行エンジン

## 実施日
2026-02-14

## 概要
`3-implement.md` の **Phase 1: Agent 実行エンジン** を TDD で実装完了。

## 実装したコンポーネント

| ファイル | クラス/型 | テスト数 | 説明 |
|---------|----------|---------|------|
| `src/agent/parser.ts` | `StreamJsonParser`, `StreamEvent`, `FileChanges` | 15 | NDJSON パーサー（Transform ストリーム） |
| `src/agent/executor.ts` | `AgentExecutor`, `ExecutorOptions`, `ExecutorCallbacks` | 15 | Cursor CLI 子プロセス起動・管理 |
| `src/agent/manager.ts` | `AgentManager` | 44 | Group/Agent ライフサイクル管理 |

**テスト合計: 74 件（Agent 実行エンジン）/ 全体: 79 件**

## テストファイル

| ファイル | テスト数 | カバー範囲 |
|---------|---------|-----------|
| `tests/agent/parser.test.ts` | 15 | 各イベントタイプのパース、NDJSON 複数行、チャンク境界バッファリング、不正 JSON スキップ、writeToolCall 検出 |
| `tests/agent/executor.test.ts` | 15 | spawn 引数検証、PID 返却、stdout→parser パイプ、exit/error コールバック、タイムアウト（SIGTERM→SIGKILL）、kill/killAll |
| `tests/agent/manager.test.ts` | 44 | Group CRUD、Agent 起動・状態取得・一覧・フィルタ、状態遷移バリデーション、waitForAgents（all/any/timeout）、reportResult マージ、ヘルスチェック結果管理、イベント通知 |

## 実装の注意点・メモ

### StreamJsonParser
- `Transform` ストリームで `readableObjectMode: true`
- テストで使う場合は `parser.resume()` を呼ばないとバックプレッシャーでハングする
- `"event"` カスタムイベントと `push()` の両方でデータを配信

### AgentExecutor
- `child_process.spawn` で Cursor CLI を起動
- タイムアウト: `setTimeout` → `kill("SIGTERM")` → 5秒後 `kill("SIGKILL")`
- テストでは `vi.mock("node:child_process")` と `vi.useFakeTimers()` を使用
- ストリームパイプのテストは `vi.useRealTimers()` に切り替える必要あり

### AgentManager
- `EventEmitter` 継承で状態変更をブロードキャスト
- 状態遷移バリデーション: `VALID_TRANSITIONS` マップで許可遷移を定義、不正遷移はログ出力して無視
- `waitForAgents`: `waitResolvers` Map に Promise resolver を登録、完了時に resolve
- `reportResult`: 自動収集データ（stream-json 由来）と手動レポートを `Set` でマージし重複排除
- テストでは `AgentExecutor` をクラスモックに差し替え（`vi.mock` + `class MockAgentExecutor`）

## テスト実行方法

```bash
# 全テスト
docker compose run --rm app npm test

# Agent 実行エンジンのみ
docker compose run --rm app npm test -- tests/agent/

# 個別
docker compose run --rm app npm test -- tests/agent/parser.test.ts
docker compose run --rm app npm test -- tests/agent/executor.test.ts
docker compose run --rm app npm test -- tests/agent/manager.test.ts
```

## 次のフェーズ（Phase 2: MCPサーバー実装）

`3-implement.md` と `src/mcp/design.md` に従い、以下の順序で実装する:

1. **MCPサーバー骨組み** — `createMcpServer()` に8つのツールを登録（既存の `tests/mcp/server.test.ts` を拡張）
2. **list_roles** — 最もシンプルなツール（設定の職種一覧 + ヘルスチェック結果を返す）
3. **create_group / delete_group** — グループ管理（Agent 実行の前提条件）
4. **run_agent** — コア機能（`groupId` 必須、AgentManager.startAgent を呼ぶ）
5. **list_agents / get_agent_status** — 状況確認（groupId フィルタ対応）
6. **wait_agent** — 完了待機（AgentManager.waitForAgents を呼ぶ）
7. **report_result** — 結果登録（AgentManager.reportResult を呼ぶ）

**重要:** テスト・ビルドは必ず `docker compose run --rm app ...` で実行すること。ローカル実行は禁止。
