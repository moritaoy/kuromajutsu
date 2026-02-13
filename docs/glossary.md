# Kuromajutsu 用語集

> 本ドキュメントはプロジェクト全体で使用する用語を定義する。
> 各開発ステップで新しい概念が登場したら追記すること。

---

## 基本概念

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| エージェント | Agent | Cursor CLI ヘッドレスモードで起動される独立した AI 実行単位。子プロセスとして動作する |
| メインエージェント | Main Agent | Cursor IDE 上でユーザーと直接対話する Agent。kuromajutsu の MCP ツールを呼び出して複数のサブ Agent を管理する |
| サブエージェント | Sub Agent | メインエージェントから `run_agent` で起動される Agent。特定の職種に基づいて動作する |
| 職種 / ロール | Role | Agent に割り当てる役割の定義。システムプロンプト、モデル、ツールセット等で構成される |
| グループ | Group | 関連する Agent の実行をまとめる論理的な単位。`create_group` で作成し、Agent 実行時に `groupId` を指定して紐付ける |

## プロトコル・通信

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| MCPサーバー | MCP Server | Model Context Protocol に準拠したサーバー。Cursor と stdio で通信し、ツールを提供する |
| MCPツール | MCP Tool | MCPサーバーが公開する操作。`create_group`, `delete_group`, `run_agent`, `list_agents`, `get_agent_status`, `wait_agent`, `report_result`, `list_roles` の8つ |
| stdio | Standard I/O | 標準入出力。MCPサーバーと Cursor 間の通信トランスポート |
| WebSocket | WebSocket | 双方向リアルタイム通信プロトコル。ダッシュボード UI とサーバー間で使用 |

## Agent 実行

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| ヘッドレスモード | Headless Mode | Cursor CLI の非対話モード（`agent -p --force`）。GUI なしで Agent を実行する |
| stream-json | Stream JSON | Cursor CLI の `--output-format stream-json` で出力される NDJSON 形式のイベントストリーム |
| NDJSON | Newline Delimited JSON | 改行区切りの JSON 形式。各行が1つの JSON オブジェクトを表す |
| Agent ID | Agent ID | Agent の一意識別子。`{role}-{timestamp}-{random4hex}` 形式 |
| Group ID | Group ID | グループの一意識別子。`grp-{unixTimestamp}-{random4hex}` 形式 |
| AgentResult | Agent Result | Agent 実行完了後の結果データ。サマリ、編集ファイル一覧、所要時間等を含む |
| AgentState | Agent State | Agent の現在の状態を表すデータ構造。ステータス、経過時間、ツール呼び出し数等を含む |

## UI・システム

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| ダッシュボード | Dashboard | ブラウザで表示する管理 UI。Agent の状態をリアルタイムで監視する。ポート 9696 で配信 |
| ヘルスチェック | Health Check | MCPサーバー起動時に各職種が正しく動作するか検証する自動チェック処理 |
| モデル検証 | Model Validation | 各職種に設定されたモデルが Cursor で利用可能かを確認する処理 |

## 開発・運用

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| SSOT | Single Source of Truth | 唯一の信頼できる情報源。本プロジェクトでは `docs/spec.md` がこれに該当する |
| TDD | Test-Driven Development | テスト駆動開発。テストを先に書き、テストを通す実装を行う開発手法 |
| Docker | Docker | コンテナ技術。開発・テスト・ビルドの実行環境として使用する |
| Docker Compose | Docker Compose | 複数コンテナのオーケストレーションツール。`docker compose up` で開発環境を起動する |

## 設計コンポーネント

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| AgentManager | Agent Manager | Agent と Group のライフサイクルを一元管理する中核コンポーネント。インメモリ Map で状態を保持し、EventEmitter パターンで状態変更を通知する。`src/agent/manager.ts` に実装 |
| AgentExecutor | Agent Executor | Cursor CLI をヘッドレスモードで子プロセス（`child_process.spawn`）として起動・管理するコンポーネント。タイムアウト処理も担う。`src/agent/executor.ts` に実装 |
| StreamJsonParser | Stream JSON Parser | Cursor CLI が出力する NDJSON をリアルタイムにパースする Transform ストリーム（`readableObjectMode: true`）。`"event"` カスタムイベントを emit し、readable 側に StreamEvent オブジェクトを push する。`extractFileChanges()` で write/edit ツール呼び出しからファイル変更を抽出する。`src/agent/parser.ts` に実装 |
| StreamEvent | Stream Event | StreamJsonParser がパースする NDJSON 1行分のイベント型。`type`（system/user/assistant/tool_call/result）、`subtype`（init/started/completed/success）、`data` フィールドで構成される。`src/agent/parser.ts` で定義 |
| FileChanges | File Changes | `StreamJsonParser.extractFileChanges()` が返すオブジェクト型。`editedFiles` と `createdFiles` の文字列配列を持つ |
| ExecutorOptions | Executor Options | `AgentExecutor.execute()` に渡すオプション型。`model`, `prompt`, `workingDirectory?`, `timeout_ms?` で構成。`src/agent/executor.ts` で定義 |
| ExecutorCallbacks | Executor Callbacks | `AgentExecutor.execute()` に渡すコールバック群の型。`onStreamEvent`, `onExit`, `onError` の3つ。`src/agent/executor.ts` で定義 |
| registerTools | Register Tools | 全 8 つの MCP ツールを McpServer に一括登録する関数。各ツールハンドラに AgentManager を注入する。`src/mcp/tools/index.ts` に実装 |
| handle* 関数 | Handle Functions | 各 MCP ツールのビジネスロジックをエクスポートした関数群（`handleCreateGroup`, `handleDeleteGroup` 等）。テストから直接呼び出し可能にするため、`server.tool()` コールバックとは分離して定義。`src/mcp/tools/*.ts` に実装 |
| errorResponse | Error Response | MCP ツールがエラーを返す際の共通ヘルパー関数。`{ content: [{ type: "text", text: JSON.stringify({ error, code, message }) }], isError: true }` 形式のレスポンスを構築する |

## UI コンポーネント

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| AgentCard | Agent Card | 1つの Agent のステータス・経過時間・ツール呼び出し数等をカード形式で表示する React コンポーネント。ステータスに応じた色分けとアニメーションを持つ |
| GroupSection | Group Section | グループ単位で Agent カードをまとめるアコーディオン型の React コンポーネント。グループの進捗状況をヘッダーに表示する |
| RoleEditor | Role Editor | 職種の設定（モデル、システムプロンプト等）をインライン編集する React コンポーネント。変更を YAML ファイルに反映する |
| HistoryTable | History Table | 完了した Agent の実行結果を一覧表示するテーブル型 React コンポーネント。グループ・ステータス・職種でフィルタリング可能 |
| HealthStatus | Health Status | 起動時ヘルスチェックの進行状況をステップ形式でリアルタイム表示する React コンポーネント |
| Layout | Layout | ヘッダー・ナビゲーション・コンテンツエリアを持つ共通レイアウト React コンポーネント |

## 設計パターン・概念

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| EventEmitter パターン | EventEmitter Pattern | Node.js の EventEmitter を継承し、状態変更を `emit` でブロードキャストするパターン。AgentManager が採用し、WebSocket を介してダッシュボードに中継する |
| イベント駆動アーキテクチャ | Event-Driven Architecture | AgentManager → WebSocket → ダッシュボード UI の通知フローに使用するアーキテクチャ。各コンポーネントはイベントの発行と購読で疎結合に連携する |
| ブロードキャスト | Broadcast | WebSocket サーバーが接続中の全クライアントにイベントを一斉送信する処理。AgentManager のイベントをリッスンし中継する |
| 依存性注入 | Dependency Injection | MCP ツールハンドラに AgentManager インスタンスを引数として渡すパターン。テスト時のモック化を容易にする |
| SPA フォールバック | SPA Fallback | 存在しないパスへのリクエストに対して index.html を返す HTTP サーバーの動作。React のクライアントサイドルーティングを実現する |
| 指数バックオフ | Exponential Backoff | WebSocket 再接続時の待機時間を 1s → 2s → 4s → 8s ... と指数的に増加させる戦略。サーバー復旧時の接続集中を防ぐ |
| 状態遷移 | State Transition | Agent のステータスが Queued → Running → Completed/Failed/TimedOut → ResultReported と一方向に遷移するルール。不正な遷移は無視する |

## エラーコード

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| GROUP_NOT_FOUND | Group Not Found | 指定された groupId に対応するグループが管理テーブルに存在しない場合のエラーコード |
| GROUP_NOT_ACTIVE | Group Not Active | 指定されたグループのステータスが "active" でない場合のエラーコード |
| GROUP_HAS_RUNNING_AGENTS | Group Has Running Agents | グループ削除時に実行中（queued/running）の Agent が残っている場合のエラーコード |
| ROLE_NOT_FOUND | Role Not Found | 指定された職種 ID が設定に存在しない場合のエラーコード |
| ROLE_UNAVAILABLE | Role Unavailable | 指定された職種がヘルスチェック未通過で利用不可の場合のエラーコード |
| MAX_CONCURRENT_REACHED | Max Concurrent Reached | Agent の同時実行数が設定上限（maxConcurrent）に達した場合のエラーコード |
| AGENT_NOT_FOUND | Agent Not Found | 指定された agentId に対応する Agent が管理テーブルに存在しない場合のエラーコード |

## 初期職種

| 職種 ID | 表示名 | 説明 |
|---------|--------|------|
| `impl-code` | コード実装者 | 仕様に基づいた高品質なコード実装を担当 |
| `code-review` | コードレビュワー | コードの品質・可読性・セキュリティ・パフォーマンスをレビュー |
| `text-review` | 文章レビュワー | テキストの文法・表現・構成・一貫性を確認 |
| `impl-test` | テスト実装者 | ユニットテスト・エッジケース・異常系テストを作成 |
