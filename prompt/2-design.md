# 2. 設計

**あなたの役割:**
あなたは経験豊富なエンジニアです。
`docs/spec.md` を読み、TypeScript での MCPサーバー、Agent実行エンジン、ダッシュボードUI の設計を整理する任務を担っています。

---

## 入力ドキュメント

| ファイル | 用途 |
|---------|------|
| `docs/spec.md` | システム仕様書（SSOT） |
| `docs/glossary.md` | 用語集（参照・更新する） |
| `kuromajutsu.config.yaml` | 設定ファイル（Step 1 で作成済み） |

---

## プロセス

### Step 1: MCP ツール定義の整理

`docs/spec.md` セクション 2 から全ツールをリストアップ：

| ツール名 | 説明 | 主要パラメータ |
|---------|------|-------------|
| `create_group` | グループ作成 | description |
| `delete_group` | グループ削除 | groupId |
| `run_agent` | Agent を実行 | groupId, role, prompt, workingDirectory?, timeout_ms? |
| `list_agents` | 実行中 Agent 一覧 | groupId?, status? |
| `get_agent_status` | Agent 詳細状況 | agentId |
| `wait_agent` | Agent 完了待機 | agentIds, timeout_ms?, mode? |
| `report_result` | 結果登録 | agentId, status, summary, editedFiles?, createdFiles?, errorMessage? |
| `list_roles` | 職種一覧 | なし |

### Step 2: Agent 実行エンジンの設計

`docs/spec.md` セクション 4 に基づいて、Agent のライフサイクル管理を設計：

- Cursor CLI 起動コマンドの構築方法
- stream-json イベントのパース処理
- 状態遷移管理（Queued → Running → Completed/Failed/TimedOut → ResultReported）
- タイムアウト処理
- 結果の自動収集（writeToolCall からのファイル一覧抽出等）

### Step 3: ダッシュボード UI コンポーネントの設計

`docs/spec.md` セクション 7 に基づいて UI を設計：

- 画面構成（ダッシュボード、職種管理、実行履歴、ヘルスチェック状況）
- WebSocket イベントの定義
- リアルタイム更新の仕組み
- ステータスの色分け・アニメーション仕様

### Step 4: ヘルスチェック・設定管理の設計

`docs/spec.md` セクション 6, 8 に基づいて設計：

- 起動時のモデル検証フロー
- ヘルスチェック実行フロー
- 設定ファイルの読み込みとバリデーション
- UI からの設定変更と YAML への反映

### Step 5: 用語集の更新

`docs/glossary.md` を参照し、設計フェーズで新たに定義・使用した用語を追記してください。

追加が想定される用語の例：
- 設計で導入したクラス名・コンポーネント名（`AgentManager`, `StreamParser`, `AgentExecutor` 等）
- デザインパターン名（イベント駆動、Observer パターン等）
- UI コンポーネント名（`AgentCard`, `RoleEditor` 等）
- 通信プロトコル上の概念（イベント名の命名規則等）

**⚠️ 重要:** 用語集はチーム内・AI 間で認識を揃えるための重要なドキュメントです。曖昧さが残る用語は定義を明確にしてください。

---

## 成果物

### `src/mcp/design.md`

以下のテンプレートで設計ドキュメントを作成してください：

```markdown
# MCPサーバー 設計

## ツール一覧

| ツール名 | 説明 | 入力パラメータ | 返却値 |
|---------|------|-------------|--------|
| create_group | グループ作成 | description | { groupId, description, createdAt, status } |
| delete_group | グループ削除 | groupId | { deleted, groupId } |
| run_agent | Agent を実行 | groupId, role, prompt, workingDirectory?, timeout_ms? | { agentId, groupId, role, model, status } |
| list_agents | Agent 一覧取得 | groupId?, status? | { agents[], total } |
| get_agent_status | Agent 詳細取得 | agentId | { agentId, groupId, status, toolCallCount, ... } |
| wait_agent | Agent 完了待機 | agentIds, timeout_ms?, mode? | { completed[], pending[], timedOut } |
| report_result | 結果登録 | agentId, status, summary, ... | { registered, agentId } |
| list_roles | 職種一覧取得 | なし | { roles[] } |

## ファイル構成

```
src/mcp/
├── server.ts             # MCPサーバー本体（@modelcontextprotocol/sdk）
└── tools/
    ├── create-group.ts   # create_group ツール定義・ハンドラ
    ├── delete-group.ts   # delete_group ツール定義・ハンドラ
    ├── run-agent.ts      # run_agent ツール定義・ハンドラ
    ├── list-agents.ts    # list_agents ツール定義・ハンドラ
    ├── get-agent-status.ts # get_agent_status ツール定義・ハンドラ
    ├── wait-agent.ts     # wait_agent ツール定義・ハンドラ
    ├── report-result.ts  # report_result ツール定義・ハンドラ
    └── list-roles.ts     # list_roles ツール定義・ハンドラ
```

## ツール設計

### create_group

- 入力: `{ description }`
- 処理:
  1. ID 発番（`grp-{timestamp}-{random4hex}`）
  2. グループ管理テーブルに登録
  3. WebSocket で UI に通知
- 出力: `{ groupId, description, createdAt, status: "active" }`

### delete_group

- 入力: `{ groupId }`
- 処理:
  1. グループの存在チェック
  2. 実行中 Agent がないことを確認
  3. グループ管理テーブルから削除
  4. WebSocket で UI に通知
- 出力: `{ deleted: true, groupId }`

### run_agent

- 入力: `{ groupId, role, prompt, workingDirectory?, timeout_ms? }`
- 処理:
  1. groupId の存在・アクティブチェック
  2. role の存在・利用可能チェック
  3. ID 発番（`{role}-{timestamp}-{random4hex}`）
  4. Agent をグループに紐付けて AgentManager に実行を委譲
  5. WebSocket で UI に通知
- 出力: `{ agentId, groupId, role, model, status: "queued" }`

### list_agents

- 入力: `{ status? }`
- 処理: AgentManager からフィルタ付きで一覧取得
- 出力: `{ agents[], total }`

### get_agent_status

- 入力: `{ agentId }`
- 処理: AgentManager から詳細状態を取得
- 出力: Agent の完全な状態オブジェクト

### wait_agent

- 入力: `{ agentIds, timeout_ms?, mode? }`
- 処理: Promise ベースで指定 Agent の完了を待機
- 出力: `{ completed[], pending[], timedOut }`

### report_result

- 入力: `{ agentId, status, summary, editedFiles?, createdFiles?, errorMessage? }`
- 処理:
  1. Agent の存在チェック
  2. 自動収集データとマージ
  3. AgentResult を構築・保存
  4. WebSocket で UI に通知
- 出力: `{ registered: true, agentId }`

### list_roles

- 入力: なし
- 処理: 設定から全職種を取得、ヘルスチェック結果を付与
- 出力: `{ roles[] }`（各職種の利用可否ステータス含む）

## テスト方針

- 各ツールに対してユニットテストを作成
- AgentManager をモック化してツール単体で検証
- Zod スキーマによる入力バリデーションテスト
- `npm test` で全テスト実行

## 実装順序

| 順序 | 機能 | 説明 |
|------|------|------|
| 1 | MCPサーバー骨組み | @modelcontextprotocol/sdk でサーバー初期化 |
| 2 | list_roles | 設定読み込み + 職種一覧返却 |
| 3 | create_group | グループ作成 |
| 4 | delete_group | グループ削除 |
| 5 | run_agent | Agent 起動の基本フロー（groupId 必須） |
| 6 | list_agents | Agent 一覧取得（groupId フィルタ対応） |
| 7 | get_agent_status | Agent 詳細取得 |
| 8 | wait_agent | 完了待機 |
| 9 | report_result | 結果登録 |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] MCP Inspector で動作確認 OK
- [ ] コミット完了
```

### `src/agent/design.md`

以下のテンプレートで設計ドキュメントを作成してください：

```markdown
# Agent 実行エンジン 設計

## コンポーネント一覧

| コンポーネント | ファイル | 説明 |
|---------|------|------|
| AgentExecutor | executor.ts | Cursor CLI 子プロセスの起動・管理 |
| StreamParser | parser.ts | stream-json NDJSON パーサー |
| AgentManager | manager.ts | Agent ライフサイクル管理・状態管理 |

## ファイル構成

```
src/agent/
├── executor.ts    # Cursor CLI 実行（child_process.spawn）
├── parser.ts      # stream-json パーサー（NDJSONイベント解析）
└── manager.ts     # Agent ライフサイクル管理（Map ベース）
```

## AgentExecutor

Cursor CLI をヘッドレスモードで子プロセスとして起動する。

```typescript
interface ExecutorOptions {
  model: string;
  prompt: string;         // systemPrompt + userPrompt
  workingDirectory?: string;
  timeout_ms?: number;
}
```

**起動コマンド:**
```bash
agent -p --force -m "{model}" --output-format stream-json --stream-partial-output "{prompt}"
```

**処理:**
1. `child_process.spawn` で Cursor CLI を起動
2. stdout を StreamParser にパイプ
3. stderr をエラーバッファに蓄積
4. プロセス終了時に exit code を AgentManager に通知
5. タイムアウト時は SIGTERM → 一定時間後 SIGKILL

## StreamParser

NDJSON の各行をパースし、イベントタイプに応じたコールバックを呼び出す。

**パースするイベント:**

| イベント type | subtype | 処理 |
|---|---|---|
| system | init | モデル名・セッション ID を記録 |
| user | - | プロンプト送信を記録 |
| assistant | - | 最新メッセージを保持 |
| tool_call | started | ツール呼び出しカウント +1、ツール情報記録 |
| tool_call | completed | 結果記録、writeToolCall ならファイル一覧更新 |
| result | success | 完了。duration_ms・最終テキスト記録 |

## AgentManager

全 Agent のライフサイクルを管理する。インメモリ Map でAgent 状態を保持。

```typescript
interface AgentState {
  id: string;
  role: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed" | "timedOut" | "resultReported";
  startedAt: string;
  elapsed_ms: number;
  toolCallCount: number;
  lastAssistantMessage: string;
  recentToolCalls: ToolCallInfo[];
  editedFiles: string[];
  createdFiles: string[];
  result: AgentResult | null;
  process: ChildProcess | null;
}
```

**主要メソッド:**
- `startAgent(role, prompt, options)`: Agent を起動し Map に登録
- `getAgent(agentId)`: Agent の状態を取得
- `listAgents(filter?)`: フィルタ付き一覧取得
- `waitForAgents(agentIds, mode, timeout?)`: Promise ベースの完了待機
- `reportResult(agentId, result)`: 結果を登録
- `onAgentUpdate(callback)`: 状態変更時のコールバック登録（WebSocket 通知用）

## テスト方針

- AgentExecutor: Cursor CLI のモック化、プロセス管理のテスト
- StreamParser: 各イベントタイプのパーステスト（NDJSONサンプルデータ使用）
- AgentManager: ライフサイクル遷移、待機処理、結果マージのテスト

## 実装順序

| 順序 | 機能 | 説明 |
|------|------|------|
| 1 | StreamParser | NDJSON パース基盤 |
| 2 | AgentExecutor | Cursor CLI 起動・プロセス管理 |
| 3 | AgentManager | ライフサイクル管理・状態管理 |
| 4 | 結果マージ | 自動収集 + report_result のマージ処理 |
| 5 | タイムアウト | タイムアウト処理の実装 |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] Agent 起動〜完了の E2E フロー確認 OK
- [ ] コミット完了
```

### `src/dashboard/design.md`

以下のテンプレートで設計ドキュメントを作成してください：

```markdown
# ダッシュボード UI 設計

## 画面一覧

| 画面 | パス | 説明 |
|------|------|------|
| ダッシュボード | `/` | 実行中 Agent 一覧（カード表示） |
| 職種管理 | `/roles` | 職種の一覧・設定編集 |
| 実行履歴 | `/history` | 過去の実行結果一覧 |
| ヘルスチェック | `/health` | 起動時チェック状況 |

## ファイル構成

```
src/dashboard/
├── server.ts              # Express + WebSocket サーバー
└── public/                # React SPA（ビルド済み静的ファイル）
    ├── index.html
    ├── app.tsx            # ルートコンポーネント
    ├── components/
    │   ├── AgentCard.tsx   # Agent ステータスカード
    │   ├── RoleEditor.tsx  # 職種設定エディタ
    │   ├── HistoryTable.tsx # 実行履歴テーブル
    │   └── HealthStatus.tsx # ヘルスチェック状況
    ├── hooks/
    │   └── useWebSocket.ts # WebSocket 接続管理
    └── styles/
        └── theme.css      # ダークテーマ
```

## ステータス色分け

| ステータス | 色 | 視覚効果 |
|---|---|---|
| queued | グレー | 点滅 |
| running | 青 | パルスアニメーション |
| completed / success | 緑 | フェードイン |
| failed | 赤 | シェイク → 静止 |
| timeout | 黄/オレンジ | 警告アイコン点滅 |
| resultReported | 緑（濃） | チェックマーク |

## WebSocket イベント

### サーバー → クライアント

| イベント | 説明 |
|---------|------|
| server:startup | サーバー起動通知 |
| healthcheck:model_validation | モデル検証結果 |
| healthcheck:role_start | 職種チェック開始 |
| healthcheck:role_complete | 職種チェック完了 |
| healthcheck:complete | 全体チェック完了 |
| agent:created | Agent 作成通知 |
| agent:status_update | Agent 状態更新 |
| agent:completed | Agent 完了通知 |
| agent:result_reported | 結果登録通知 |
| config:updated | 設定変更通知 |

### クライアント → サーバー

| イベント | 説明 |
|---------|------|
| config:update_role | 職種設定の変更 |
| config:revalidate_model | モデル再検証 |

## テスト方針

- HTTPサーバーのレスポンステスト
- WebSocket イベントの送受信テスト
- React コンポーネントのレンダリングテスト（オプション）

## 実装順序

| 順序 | 機能 | 説明 |
|------|------|------|
| 1 | HTTPサーバー | Express + 静的ファイル配信 |
| 2 | WebSocket | 接続管理・イベント配信基盤 |
| 3 | ダッシュボード画面 | Agent カード表示 |
| 4 | ヘルスチェック画面 | 起動時チェック状況表示 |
| 5 | 職種管理画面 | 設定編集 UI |
| 6 | 実行履歴画面 | 結果一覧表示 |
| 7 | アニメーション | ステータス色分け・視覚効果 |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] ブラウザで表示・動作確認 OK
- [ ] コミット完了
```

---

## 次のアクション

→ `3-implement.md` へ進んで TDD 実装を開始

**注意:** `3-implement.md` では各 `design.md` の「実装順序」に従って、機能ごとに段階的に実装を進めます。
