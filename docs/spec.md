# Kuromajutsu 仕様書

> Cursor Agent 並列実行管理システム

## 1. システム概要

### 1.1 目的

Kuromajutsu は、Cursor の MCP（Model Context Protocol）サーバーとして動作し、メインの Cursor Agent から複数のサブ Agent を並列に起動・管理するためのシステムである。各 Agent は「職種（Role）」として定義された役割に基づいて動作し、コード実装、レビュー、テスト作成などのタスクを並行して処理できる。

Agent の実行は必ず「グループ（Group）」に所属させる。グループは関連するタスク群をまとめる単位であり、MCP ツール経由で事前に作成する。グループには目的の簡潔な説明を登録し、一意の ID が発番される。これにより、ダッシュボード UI 上で Agent をグループ単位で整理・表示でき、タスクの見通しが向上する。

### 1.2 全体アーキテクチャ

```mermaid
graph TB
    CursorMain["Cursor メインAgent"] -->|"MCP (stdio)"| MCPServer["kuromajutsu MCPサーバー"]
    MCPServer -->|"agent -p --force"| Agent1["Agent 1 (impl-code)"]
    MCPServer -->|"agent -p --force"| Agent2["Agent 2 (code-review)"]
    MCPServer -->|"agent -p --force"| Agent3["Agent N ..."]
    MCPServer -->|"HTTP :9696"| Dashboard["ダッシュボードUI (React)"]
    Agent1 -->|"stream-json"| MCPServer
    Agent2 -->|"stream-json"| MCPServer
    Agent3 -->|"stream-json"| MCPServer
    Dashboard -->|"WebSocket"| MCPServer
```

### 1.3 技術スタック

| コンポーネント | 技術 |
|---|---|
| MCPサーバー | TypeScript + Node.js（`@modelcontextprotocol/sdk`、stdio トランスポート） |
| ダッシュボードUI | React（MCPサーバーが内蔵HTTPサーバーでホスティング） |
| リアルタイム通信 | WebSocket（UI ⇔ MCPサーバー間） |
| Agent実行 | Cursor CLI ヘッドレスモード |
| 設定管理 | YAML（`kuromajutsu.config.yaml`） |
| コンテナ実行環境 | Docker / Docker Compose |

### 1.3.1 実行環境

テスト・ビルドは Docker コンテナ内で実行する。開発実行（`npm run dev`）は Cursor CLI（`agent` コマンド）を必要とするため、ホスト上で直接実行する。

**開発実行（ホスト）:**

```bash
# セットアップ（初回のみ）
npm install

# 開発モード（ホットリロード付き、Cursor CLI 利用可能）
npm run dev
```

**テスト・ビルド（Docker）:**

```bash
# ビルド
docker compose run --rm app npm run build

# テスト
docker compose run --rm app npm test
```

**ダッシュボード確認のみ（Docker）:**

```bash
# Docker でダッシュボードを起動（Cursor CLI 機能は動作しない）
docker compose up
```

**ポートマッピング:**
- `9696:9696` — ダッシュボード UI

**ボリューム:**
- プロジェクトルートをコンテナにマウント（ホットリロード対応）
- `node_modules` はコンテナ内に隔離（ホスト側の `node_modules` とは独立）

### 1.4 動作原理

1. Cursor のメイン Agent が MCP ツール `create_group` でグループを作成する
2. メイン Agent が `run_agents`（または `run_sequential`）にグループ ID を指定して Agent を起動する
3. MCPサーバーが Cursor CLI をヘッドレスモード（`agent -p --force`）で子プロセスとして起動する
4. 子プロセスの出力を `--output-format stream-json --stream-partial-output` でリアルタイムにパースし、進捗を追跡する
5. メイン Agent は `wait_agent` で完了を待機し、`report_result` で結果を収集する
6. 用が済んだら `delete_group` でグループを削除する
7. ダッシュボード UI は WebSocket 経由でリアルタイムにすべての Agent の状態をグループ単位で表示する

---

## 2. MCPサーバー

### 2.1 トランスポート

- Cursor との通信: **stdio**（標準入出力）
- ダッシュボード UI 配信: **HTTP**（ポート `9696`「くろくろ」）
- UI リアルタイム更新: **WebSocket**（同ポート）

### 2.2 提供ツール一覧

MCPサーバーは以下の **10個のツール** を提供する。

| ツール名 | 説明 |
|---|---|
| `create_group` | グループを作成する |
| `delete_group` | グループを削除する |
| `run_agents` | 1台以上の Agent を一括起動する（Concurrent グループ用） |
| `run_sequential` | ステージ制 Sequential 実行計画を投入する |
| `run_magentic` | Magentic パターン（Orchestrator 自律管理）でタスクを実行する |
| `list_agents` | 実行中の Agent 一覧を取得する |
| `get_agent_status` | Agent の詳細状況を取得する |
| `wait_agent` | Agent の完了を待機する |
| `report_result` | Agent の実行結果を登録する |
| `list_roles` | 利用可能な職種一覧を返す |

#### 2.2.1 `create_group` — グループを作成する

関連する Agent 群をまとめるグループを作成し、一意の ID を発番して返す。Agent を実行する前に、必ずグループを作成する必要がある。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `description` | `string` | はい | グループの目的の簡潔な説明（例: 「認証機能の実装・テスト・レビュー」） |
| `mode` | `string` | いいえ | 実行モード: `concurrent`（デフォルト）または `sequential` |
| `parentGroupId` | `string` | いいえ | 親グループ ID（Magentic モードの子グループ作成時に指定） |

**返却値:**

```json
{
  "groupId": "grp-1739487600-b4e1",
  "description": "認証機能の実装・テスト・レビュー",
  "mode": "concurrent",
  "createdAt": "2026-02-13T12:00:00.000Z",
  "status": "active"
}
```

**内部動作:**
1. ID を `grp-{unixTimestamp}-{random4hex}` 形式で発番する
2. `mode` を指定に従って設定する（未指定時は `concurrent`）
3. グループを管理テーブル（インメモリ Map）に登録する
4. WebSocket 経由でダッシュボード UI に通知する

#### 2.2.2 `delete_group` — グループを削除する

指定したグループを削除する。グループに所属する Agent がすべて完了済み（または未登録）であることが条件。実行中の Agent が存在する場合はエラーを返す。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `groupId` | `string` | はい | 削除対象のグループ ID |

**返却値:**

```json
{
  "deleted": true,
  "groupId": "grp-1739487600-b4e1"
}
```

**内部動作:**
1. グループの存在を検証する
2. グループに所属する実行中の Agent がないことを確認する（実行中の Agent がある場合はエラー）
3. グループのステータスを `"deleted"` に変更する
4. 完了済み Agent は履歴として保持する（削除しない）
5. 削除済みグループの Agent が全体で最大 20 件を超えた場合、古い Agent から自動的に削除する（Agent がなくなったグループは管理テーブルから除去する）
6. WebSocket 経由でダッシュボード UI に通知する

#### 2.2.3 `run_agents` — Agent を一括起動する

指定した職種とプロンプトで 1 台以上の Agent を一括起動する（Concurrent グループ用）。各 Agent は必ずグループに所属させる。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `groupId` | `string` | はい | 所属するグループ ID |
| `agents` | `array` | はい | 起動する Agent の定義配列。各要素: `{ role: string, prompt: string, workingDirectory?: string, timeout_ms?: number }` |

**モデルの決定:** `run_agents` はモデルパラメータを受け付けない。使用するモデルは職種（Role）の設定に従う。

**返却値:**

```json
{
  "agents": [
    {
      "agentId": "impl-code-1739487600-a3f2",
      "groupId": "grp-1739487600-b4e1",
      "role": "impl-code",
      "model": "claude-4-sonnet",
      "status": "queued"
    }
  ],
  "total": 1
}
```

**エラーコード:** `GROUP_NOT_FOUND`, `GROUP_NOT_ACTIVE`, `MODE_MISMATCH`, `ROLE_NOT_FOUND`, `ROLE_UNAVAILABLE`, `MAX_CONCURRENT_REACHED`, `AGENTS_START_FAILED`, `EMPTY_AGENTS`

**内部動作:**
1. 指定された `groupId` が存在し、アクティブかつ `mode: "concurrent"` であることを検証する
2. 各 Agent の `role` が存在し、利用可能（ヘルスチェック通過済み）か検証する
3. 各 Agent に ID を `{role}-{timestamp}-{random4}` 形式で発番する
4. Agent をグループに紐付けて管理テーブルに登録する
5. Cursor CLI を各 Agent ごとに起動する
6. 子プロセスの stream-json 出力をリアルタイムでパースし、内部状態を更新する
7. WebSocket 経由でダッシュボード UI に通知する

#### 2.2.4 `run_sequential` — Sequential 実行計画を投入する

ステージ制の Sequential 実行計画を投入する。各ステージ内は並列実行、ステージ間は直列に実行される。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `groupId` | `string` | はい | 所属するグループ ID（`mode: "sequential"` で作成済み） |
| `stages` | `array` | はい | 実行ステージの配列。各要素: `{ tasks: [{ role, prompt, workingDirectory?, timeout_ms? }] }` |

**返却値:**

```json
{
  "groupId": "grp-1739487600-b4e1",
  "totalStages": 3,
  "currentStageIndex": 0,
  "stages": [...],
  "agents": [...],
  "total": 1
}
```

**前ステージ結果の自動注入:** Stage N（N > 0）の Agent 起動時、直前ステージの全 Agent の `summary` + `response` をプロンプトに自動注入する。

**エラーコード:** `GROUP_NOT_FOUND`, `GROUP_NOT_ACTIVE`, `MODE_MISMATCH`, `ROLE_NOT_FOUND`, `ROLE_UNAVAILABLE`, `MAX_CONCURRENT_REACHED`, `EMPTY_STAGES`, `EMPTY_STAGE_TASKS`, `SEQUENTIAL_START_FAILED`

#### 2.2.5 `list_agents` — 実行中の Agent 一覧を取得する

現在管理しているすべての Agent（実行中・完了済み含む）の一覧を返す。グループ ID を指定して、特定グループに所属する Agent のみをフィルタリングできる。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `groupId` | `string` | いいえ | フィルタ: 指定したグループに所属する Agent のみ取得 |
| `status` | `string` | いいえ | フィルタ: `running`, `completed`, `failed`, `all`（デフォルト: `all`） |

**返却値:**

```json
{
  "agents": [
    {
      "agentId": "impl-code-1739487600-a3f2",
      "groupId": "grp-1739487600-b4e1",
      "role": "impl-code",
      "model": "claude-4-sonnet",
      "status": "running",
      "startedAt": "2026-02-13T12:00:00.000Z",
      "elapsed_ms": 15000,
      "toolCallCount": 3
    }
  ],
  "total": 1
}
```

#### 2.2.6 `get_agent_status` — Agent の詳細状況を取得する

指定した ID の Agent のリアルタイム詳細情報を返す。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `agentId` | `string` | はい | Agent ID |

**返却値:**

```json
{
  "agentId": "impl-code-1739487600-a3f2",
  "groupId": "grp-1739487600-b4e1",
  "role": "impl-code",
  "model": "claude-4-sonnet",
  "status": "running",
  "startedAt": "2026-02-13T12:00:00.000Z",
  "elapsed_ms": 15000,
  "toolCallCount": 5,
  "result": null
}
```

> **設計意図:** メイン Agent のコンテキストを圧迫しないよう、`recentToolCalls`・`lastAssistantMessage`・`editedFiles`・`createdFiles` は返却しない。これらはダッシュボード UI（WebSocket 経由）で別途確認可能。完了済み Agent の場合は `result` フィールドに `summary`・`response`・`editedFiles`・`createdFiles` 等が含まれる。

#### 2.2.7 `wait_agent` — Agent の完了を待機する

指定した Agent（複数可）が完了するまでブロックする。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `agentIds` | `string[]` | はい | 待機対象の Agent ID の配列 |
| `timeout_ms` | `number` | いいえ | 全体のタイムアウト（ミリ秒）。デフォルト: 無制限 |
| `mode` | `string` | いいえ | `all`（全て完了で返却）または `any`（いずれか完了で返却）。デフォルト: `all` |

**返却値:**

```json
{
  "completed": [
    {
      "agentId": "impl-code-1739487600-a3f2",
      "status": "completed",
      "duration_ms": 45000
    }
  ],
  "pending": [],
  "timedOut": false
}
```

#### 2.2.8 `report_result` — Agent の実行結果を登録する

Agent の実行完了後に、結果データを登録する。このツールは Agent 自身がプロンプト内の指示に従い MCP 経由で呼び出す想定。成功・失敗いずれの場合でも登録できる。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `agentId` | `string` | はい | Agent ID |
| `status` | `string` | はい | `success`, `failure`, `timeout`, `cancelled` のいずれか |
| `summary` | `string` | はい | 実行結果の要約（1-2文で簡潔に） |
| `response` | `string` | はい | 実行結果の構造化レポート（実施内容・成果・判断理由・注意点・申し送り事項を整理して記載） |
| `editedFiles` | `string[]` | いいえ | 編集したファイルパス一覧 |
| `createdFiles` | `string[]` | いいえ | 新規作成したファイルパス一覧 |
| `errorMessage` | `string` | いいえ | 失敗時のエラーメッセージ |

**自動付与されるフィールド（サーバー側で計算）:**

| フィールド | 型 | 説明 |
|---|---|---|
| `groupId` | `string` | 所属グループ ID |
| `duration_ms` | `number` | 実行所要時間（ミリ秒、開始〜現在の差分） |
| `model` | `string` | 使用モデル（職種設定から） |
| `role` | `string` | 職種 ID |
| `toolCallCount` | `number` | stream-json から計測したツール呼び出し回数 |
| `timestamp` | `string` | 完了時刻（ISO 8601） |

**返却値:**

```json
{
  "registered": true,
  "agentId": "impl-code-1739487600-a3f2"
}
```

#### 2.2.9 `list_roles` — 利用可能な職種一覧を返す

設定されている全職種の一覧を返す。

**入力パラメータ:** なし

**返却値:**

```json
{
  "roles": [
    {
      "id": "impl-code",
      "name": "コード実装者",
      "description": "コードの実装・修正を行う。新機能の追加、バグ修正、リファクタリングなど、ファイルの編集を伴うタスクに使用する",
      "model": "claude-4-sonnet"
    },
    {
      "id": "code-review",
      "name": "コードレビュワー",
      "description": "コードの品質をレビューする。実装完了後の品質チェック、セキュリティ・パフォーマンス観点のフィードバックに使用する。ファイルの編集は行わない",
      "model": "claude-4-sonnet"
    }
  ]
}
```

#### 2.2.10 `run_magentic` — Magentic パターンでタスクを実行する

Magentic パターン（Orchestrator Agent による自律管理）でタスクを実行する。Orchestrator Agent が計画→委任→評価→リプランのループを自律的に繰り返し、タスクを完了するまで実行する。

**入力パラメータ:**

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `description` | `string` | はい | グループの説明 |
| `task` | `string` | はい | 達成すべきタスクの詳細な説明 |
| `completionCriteria` | `string` | はい | 完了条件（どうなったらタスク完了とみなすか） |
| `scope` | `string` | はい | 操作範囲（変更してよいファイル・ディレクトリの範囲） |
| `constraints` | `string` | いいえ | 追加制約（守るべきルールや禁止事項） |
| `context` | `string` | いいえ | 補足コンテキスト（背景情報、関連仕様書パス等） |
| `availableRoles` | `string[]` | いいえ | 使用可能な職種（デフォルト: orchestrator 以外の全職種） |
| `maxIterations` | `number` | いいえ | 最大反復回数（デフォルト: 10） |
| `timeout_ms` | `number` | いいえ | 全体タイムアウト（ミリ秒） |

**返却値:**

```json
{
  "groupId": "grp-1739487600-b4e1",
  "orchestratorAgentId": "orchestrator-1739487600-a3f2",
  "status": "started"
}
```

**内部動作:**
1. `mode: "magentic"` でグループを作成する
2. `orchestrator` ロール（opus-4.6-thinking）で Orchestrator Agent を起動する
3. Orchestrator のプロンプトに task, completionCriteria, scope, constraints, context, availableRoles, maxIterations を注入する
4. Orchestrator が自律的に計画→委任→評価→リプランのループを実行する（サブ Agent は `create_group` + `run_agents` で起動）

---

## 3. グループ（Group）定義

### 3.1 概要

グループは、関連する Agent の実行をまとめる論理的な単位である。メインの Cursor Agent が MCP ツール `create_group` で作成し、Agent 実行時に `groupId` を指定して紐付ける。

グループの用途:
- **タスク管理:** 関連する複数の Agent（実装・テスト・レビュー等）を1つのグループにまとめて管理する
- **UI 整理:** ダッシュボード UI 上で Agent をグループ単位で整理・表示し、タスクの見通しを向上させる
- **ライフサイクル管理:** グループ内の全 Agent が完了した後、グループを削除して整理できる

### 3.2 グループのデータ構造

```typescript
type GroupMode = "concurrent" | "sequential";

interface GroupDefinition {
  /** 一意識別子（`grp-{unixTimestamp}-{random4hex}` 形式） */
  id: string;
  /** グループの目的の簡潔な説明 */
  description: string;
  /** 実行モード: concurrent（並列）または sequential（ステージ制直列） */
  mode: GroupMode;
  /** グループのステータス */
  status: "active" | "deleted";
  /** 作成日時（ISO 8601） */
  createdAt: string;
  /** 所属する Agent ID の一覧 */
  agentIds: string[];
  /** 親グループ ID（Magentic モードの子グループで設定） */
  parentGroupId?: string;
  /** Orchestrator Agent ID（Magentic モードの親グループで設定） */
  orchestratorAgentId?: string;
}
```

**mode の説明:**
- `concurrent`: 並列実行モード。`run_agents` で 1 台以上の Agent を同時に起動する
- `sequential`: ステージ制実行モード。`run_sequential` でステージ配列を投入し、各ステージ内は並列、ステージ間は直列に実行する

### 3.3 ID 発番ルール

- 形式: `grp-{unixTimestamp}-{random4hex}`
- 例: `grp-1739487600-b4e1`
- グループ管理テーブル（インメモリ Map）のキーとして使用する

### 3.4 グループの管理

- グループはインメモリの Map で管理する（Agent 管理テーブルと同様）
- `create_group` で作成、`delete_group` で削除する
- Agent 実行時（`run_agents` または `run_sequential`）に `groupId` を指定して紐付ける
- グループに所属する実行中の Agent がある場合、そのグループは削除できない
- ダッシュボード UI からグループ一覧を確認できる

---

## 4. Agent 職種（Role）定義

### 4.1 職種のデータ構造

```typescript
interface RoleDefinition {
  /** 一意識別子 */
  id: string;
  /** 表示名 */
  name: string;
  /** 職種の概要と使いどころの説明（list_roles で返却される） */
  description: string;
  /** Agent に渡すシステムプロンプト */
  systemPrompt: string;
  /** 使用する LLM モデル名（Cursor CLI の -m オプションに渡す値） */
  model: string;
  /** 使用可能なツール ID の一覧（ツールレジストリで定義されたツールを参照） */
  tools?: string[];
  /** ヘルスチェック時に使用する簡易テストプロンプト */
  healthCheckPrompt: string;
}
```

### 4.2 初期職種一覧

#### `impl-code` — コード実装者

| プロパティ | 値 |
|---|---|
| id | `impl-code` |
| name | コード実装者 |
| description | コードの実装・修正を行う。新機能の追加、バグ修正、リファクタリングなど、ファイルの編集を伴うタスクに使用する |
| model | `claude-4-sonnet`（デフォルト） |
| systemPrompt | あなたはコード実装の専門家です。与えられた仕様や指示に基づき、高品質なコードを実装してください。実装が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。 |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

#### `code-review` — コードレビュワー

| プロパティ | 値 |
|---|---|
| id | `code-review` |
| name | コードレビュワー |
| description | コードの品質をレビューする。実装完了後の品質チェック、セキュリティ・パフォーマンス観点のフィードバックに使用する。ファイルの編集は行わない |
| model | `claude-4-sonnet`（デフォルト） |
| systemPrompt | あなたはコードレビューの専門家です。与えられたコードを精査し、品質・可読性・セキュリティ・パフォーマンスの観点からフィードバックを提供してください。レビューが完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。 |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

#### `text-review` — 文章レビュワー

| プロパティ | 値 |
|---|---|
| id | `text-review` |
| name | 文章レビュワー |
| description | 文章の品質をレビューする。ドキュメント・仕様書・READMEなどの文法・表現・構成チェックに使用する。ファイルの編集は行わない |
| model | `claude-4-sonnet`（デフォルト） |
| systemPrompt | あなたは文章レビューの専門家です。与えられたテキストの文法、表現、構成、一貫性を確認し、改善提案を提供してください。レビューが完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。 |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

#### `research` — 調査員

| プロパティ | 値 |
|---|---|
| id | `research` |
| name | 調査員 |
| description | 調査・情報収集を行う。技術選定、ベストプラクティスの調査、コードベースの分析などに使用する。ファイルの編集は行わない |
| model | `composer-1.5`（デフォルト） |
| systemPrompt | あなたは調査・情報収集の専門家です。与えられたテーマやトピックについて、Web検索やローカルファイルの検索を駆使して情報を収集し、整理された調査レポートとして報告してください。調査が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。 |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

**特記事項:**
- ファイルの編集は行わず、調査結果をテキストで報告するのみ
- Web検索（WebSearch）、ファイル検索（Grep, Glob, SemanticSearch）、ファイル読み込み（Read）を活用
- 調査結果は「調査概要・調査結果・参考情報・所見」の構造で整理して報告する

#### `impl-test` — テスト実装者

| プロパティ | 値 |
|---|---|
| id | `impl-test` |
| name | テスト実装者 |
| description | テストコードの実装を行う。ユニットテスト・統合テストの作成、テストカバレッジの向上に使用する |
| model | `claude-4-sonnet`（デフォルト） |
| systemPrompt | あなたはテスト実装の専門家です。与えられた仕様やコードに対して、包括的なテストを作成してください。ユニットテスト、エッジケース、異常系のテストを含めてください。実装が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。 |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

#### `orchestrator` — オーケストレーター

| プロパティ | 値 |
|---|---|
| id | `orchestrator` |
| name | オーケストレーター |
| description | Magentic パターンのオーケストレーションを担当する。タスクの分析・計画立案・サブ Agent への委任・結果評価・リプランニングを自律的に行う |
| model | `opus-4.6-thinking` |
| systemPrompt | （Magentic 専用のシステムプロンプト。計画→委任→評価→リプランのループを指示） |
| healthCheckPrompt | `Hello, respond with exactly: OK` |

### 4.3 職種の管理

- 職種の定義は設定ファイル `kuromajutsu.config.yaml` で管理する
- ダッシュボード UI からモデル・プロンプトをインラインで編集可能とする
- UI から変更した場合、設定ファイルにも反映する
- 将来的にカスタム職種の追加に対応する

### 4.4 ロールツール機能

職種には外部ツールを紐付けることができる。ツールは `kuromajutsu.config.yaml` の `roles[].tools` にツール ID を指定して有効化する。有効化されたツールの使用方法は、Agent 起動時にプロンプトへ自動注入される。

#### 4.4.1 ツール定義の構造

```typescript
interface RoleToolDefinition {
  /** ツール ID（roles[].tools で参照する値） */
  id: string;
  /** 表示名 */
  name: string;
  /** ツールの概要説明 */
  description: string;
  /** Agent のプロンプトに注入する使用方法の説明（Markdown 形式） */
  promptInstructions: string;
}
```

#### 4.4.2 ビルトインツール一覧

| ツール ID | 名前 | 説明 |
|-----------|------|------|
| `textlint` | textlint | 文章の品質チェックツール。日本語の文法・表現ルールに基づいて問題を検出する |

#### 4.4.3 プロンプトへの注入

Agent 起動時、`buildFullPrompt()` が以下の5層構造で構築される（5.3.1 参照）:

1. ロールのシステムプロンプト（設定ファイル由来）
2. kuromajutsu メタデータブロック（agentId, groupId, report_result 指示）
3. **ツールブロック**（ロールに紐付くツールの使用方法。ツール未設定時は省略）
4. **前ステージ結果ブロック**（Sequential モードの Stage N>0 の場合のみ。直前ステージの summary + response）
5. ユーザープロンプト

#### 4.4.4 設定例

```yaml
roles:
  - id: text-review
    name: 文章レビュワー
    model: claude-4-sonnet
    systemPrompt: |
      あなたは文章レビューの専門家です。...
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools:
      - textlint
```

---

## 5. Agent 実行ライフサイクル

### 5.1 状態遷移

```mermaid
stateDiagram-v2
    [*] --> Queued: run_agents / run_sequential 呼び出し
    Queued --> Running: 子プロセス起動成功
    Queued --> Failed: 子プロセス起動失敗
    Running --> Completed: exit code 0 かつ result イベント受信
    Running --> Failed: 非ゼロ exit code またはエラー
    Running --> TimedOut: タイムアウト到達
    Running --> ResultReported: Agent 自身が実行中に report_result 呼び出し
    Completed --> ResultReported: report_result 呼び出し
    Failed --> ResultReported: report_result 呼び出し
    TimedOut --> ResultReported: report_result 呼び出し
    ResultReported --> [*]
```

### 5.2 ID 発番ルール

- 形式: `{role}-{unixTimestamp}-{random4hex}`
- 例: `impl-code-1739487600-a3f2`
- Agent 管理テーブル（インメモリ Map）のキーとして使用する

### 5.3 Cursor CLI 起動コマンド

```bash
agent -p --force \
  -m "{role.model}" \
  --output-format stream-json \
  --stream-partial-output \
  "{fullPrompt}"
```

- `--force`: 確認なしでファイル変更を許可
- `-m`: 職種に設定されたモデルを指定
- `--output-format stream-json`: NDJSON 形式でイベントをストリーム出力
- `--stream-partial-output`: 文字単位のリアルタイム差分を有効化

#### 5.3.1 プロンプト構築

Agent に渡すプロンプト（`fullPrompt`）は以下の5層構造で動的に構築する:

```
{role.systemPrompt}

---
【kuromajutsu システム情報】

あなたは kuromajutsu Agent 管理システムによって起動されたサブ Agent です。

- Agent ID: {agentId}
- Group ID: {groupId}
- Role: {role.id}

【重要: タスク完了時の結果報告】
タスクが完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
以下のパラメータを指定してください:

  agentId: "{agentId}"
  status: "success" または "failure"
  summary: "実行結果の要約（1-2文で簡潔に）"
  response: "実行結果の詳細レポート（下記ガイドライン参照）"
  editedFiles: ["編集したファイルパスの配列"]  // 省略可
  createdFiles: ["新規作成したファイルパスの配列"]  // 省略可
  errorMessage: "エラーメッセージ"  // 失敗時のみ

**response のガイドライン:**
response は生の実行ログではなく、実行結果を適切にまとめた構造化レポートです。
メイン Agent や人間が読んで内容を正確に把握できるよう、以下を整理して記載してください:
- 何を実施したか（実施内容）
- 結果どうなったか（成果・変更点）
- 判断や選択の理由（なぜそうしたか）
- 注意点・懸念事項（あれば）
- 次のステップへの申し送り事項（あれば）

report_result を呼ばないとメイン Agent が結果を受け取れません。タスクの成否に関わらず必ず呼び出してください。
---

{toolBlock}  ← ロールに紐付くツールがある場合のみ

{previousStageResultsBlock}  ← Sequential モードかつ Stage N (N>0) の場合のみ。直前ステージの全 Agent の summary + response

{userPrompt}
```

**各層の役割:**

| 層 | 内容 | ソース |
|---|---|---|
| 第1層: ロールプロンプト | 職種固有の指示（専門家としての振る舞い等） | `kuromajutsu.config.yaml` の `systemPrompt` |
| 第2層: メタデータブロック | Agent ID、Group ID、`report_result` の呼び出し指示 | `AgentManager.buildFullPrompt()` で動的生成 |
| 第3層: ツールブロック | ロールに紐付くツールの使用方法 | `kuromajutsu.config.yaml` の `roles[].tools`（ツール未設定の場合は省略） |
| 第4層: 前ステージ結果ブロック | 直前ステージの全 Agent の summary + response | Sequential モードの Stage N（N>0）で自動注入 |
| 第5層: ユーザープロンプト | メイン Agent が `run_agents` / `run_sequential` で指定した具体的タスク内容 | ツールの `prompt` パラメータ |

**設計意図:**

- サブ Agent は自身の `agentId` を知る必要がある（`report_result` の必須パラメータ）
- メイン Agent が `report_result` を代理呼び出しすることは想定しない。サブ Agent 自身が MCP 経由で呼び出す
- 第2層のメタデータブロックにより、設定ファイルの `systemPrompt` を変更せずに動的な情報を注入できる
- Sequential モードでは前ステージの結果を次ステージの Agent に自動引き継ぎ、パイプライン処理を可能にする

### 5.4 stream-json パース

Cursor CLI が出力する NDJSON の各イベントタイプをパースして Agent の状態を更新する:

| イベント type | 処理 |
|---|---|
| `system` (subtype: `init`) | Agent の初期化完了を記録。使用モデルを確認 |
| `user` | ユーザープロンプトの送信を記録 |
| `assistant` | 最新のアシスタントメッセージを保持 |
| `tool_call` (subtype: `started`) | ツール呼び出しカウントをインクリメント。呼び出し中のツール情報を記録 |
| `tool_call` (subtype: `completed`) | ツール実行結果を記録。writeToolCall の場合はファイル一覧を更新 |
| `result` | Agent 実行完了。duration_ms と最終テキストを記録。ステータスを更新 |

### 5.5 タイムアウト処理

- `run_agents` / `run_sequential` 呼び出し時に `timeout_ms` を指定可能
- 指定なしの場合はタイムアウトなし（無制限）
- 設定ファイルの `defaultTimeout_ms` でデフォルト値を設定することも可能（オプション）
- タイムアウト到達時に子プロセスを SIGTERM で終了し、ステータスを `TimedOut` に更新

---

## 6. 結果データ構造

### 6.1 AgentResult インターフェース

```typescript
interface AgentResult {
  /** Agent ID */
  agentId: string;
  /** 所属グループ ID */
  groupId: string;
  /** 実行ステータス */
  status: "success" | "failure" | "timeout" | "cancelled";
  /** 実行結果の要約（1-2文） */
  summary: string;
  /** 実行結果を整理した構造化レポート */
  response: string;
  /** 編集したファイルパス一覧 */
  editedFiles: string[];
  /** 新規作成したファイルパス一覧 */
  createdFiles: string[];
  /** 実行所要時間（ミリ秒） */
  duration_ms: number;
  /** 使用モデル */
  model: string;
  /** 職種 ID */
  role: string;
  /** ツール呼び出し回数 */
  toolCallCount: number;
  /** 失敗時のエラーメッセージ */
  errorMessage?: string;
  /** 生の Agent 出力テキスト（オプション） */
  rawOutput?: string;
  /** 完了時刻（ISO 8601） */
  timestamp: string;
}
```

### 6.2 結果の収集方法

1. **自動収集（stream-json パース由来）:** Agent の子プロセスが出力する stream-json から、`tool_call` イベント（writeToolCall）を解析し、`editedFiles` / `createdFiles` を自動的に収集する。`result` イベントから `duration_ms` を取得する。

2. **Agent 自身による報告（`report_result` ツール）:** プロンプト構築時にメタデータブロック（5.3.1 参照）で `agentId` と `report_result` の呼び出し方法を注入する。サブ Agent はこの情報をもとに MCP ツール `report_result` を呼び出し、`summary`・`response`・`status` などの情報を登録する。`response` は実行結果を適切にまとめた構造化レポートであり、生の実行ログではない。

3. **結合:** サーバー側は自動収集したデータと Agent の自己報告データをマージして最終的な `AgentResult` を構築する。

### 6.3 失敗ケースの取り扱い

| 失敗パターン | status | 処理 |
|---|---|---|
| Agent が正常に report_result を呼んだが失敗を報告 | `failure` | Agent の報告をそのまま記録 |
| 子プロセスが非ゼロ終了コードで異常終了 | `failure` | stderr の内容を `errorMessage` に記録 |
| タイムアウトで強制終了 | `timeout` | それまでに収集した情報で結果を構築 |
| report_result が呼ばれなかった場合 | 自動判定 | exit code と result イベントから status を判定。summary は最終アシスタントメッセージを使用 |

> **注:** `report_result` は `running` 状態でも受け付ける。サブ Agent が MCP 経由で `report_result` を呼ぶタイミングは、Agent プロセスが終了する前（`result` イベント受信前）であるため、`running` 状態での呼び出しが正常なフローである。

---

## 7. ヘルスチェック・モデル検証

### 7.1 実行タイミング

MCPサーバー起動時に以下の順序で **自動実行** する。MCP ツールとしては提供しない。

```mermaid
sequenceDiagram
    participant Server as MCPサーバー
    participant CLI as Cursor CLI
    participant UI as ダッシュボードUI

    Server->>UI: 起動通知（ヘルスチェック開始）
    Server->>CLI: agent models（利用可能モデル一覧取得）
    CLI-->>Server: モデル一覧
    Server->>UI: モデル検証結果を送信

    loop 各職種（モデル検証通過済み）
        Server->>UI: 職種チェック開始通知
        Server->>CLI: agent -p -m {model} "{healthCheckPrompt}"
        CLI-->>Server: レスポンス
        Server->>UI: 職種チェック結果通知
    end

    Server->>UI: ヘルスチェック完了サマリ
```

### 7.2 モデル検証

1. MCPサーバー起動時に `agent models` コマンドを実行し、Cursor で利用可能なモデル一覧を取得する
2. 各職種に設定されたモデルが一覧に存在するか照合する
3. 利用不可のモデルが設定されている場合:
   - コンソールに警告ログを出力する
   - ダッシュボード UI に該当職種のエラーを表示する（赤色バッジ + 利用可能モデルへの変更を促す UI）
   - 該当職種での Agent 実行をブロックする（`run_agents` / `run_sequential` でエラーを返す）

### 7.3 ヘルスチェック

1. モデル検証を通過した職種に対して、`healthCheckPrompt` を Cursor CLI で実行する
   ```bash
   agent -p -m "{role.model}" "{role.healthCheckPrompt}"
   ```
2. 正常にレスポンスが返ればチェック通過とする
3. 結果をコンソールと UI にリアルタイムでレポートする（成功/失敗、応答時間）
4. すべてのチェック完了後にサマリを出力する

### 7.4 ヘルスチェック結果の構造

```typescript
interface HealthCheckResult {
  /** チェック対象の職種 ID */
  roleId: string;
  /** モデル検証結果 */
  modelValidation: {
    status: "valid" | "invalid";
    message?: string;
    checkedAt: string;
  };
  /** ヘルスチェック結果 */
  healthCheck: {
    status: "passed" | "failed" | "skipped";
    reason?: string;
    responseTime_ms?: number;
    checkedAt?: string;
  };
  /** この職種が利用可能かどうか */
  available: boolean;
}
```

---

## 8. ダッシュボード UI

### 8.1 概要

- MCPサーバーが内蔵 HTTP サーバーで配信する（デフォルトポート: `9696`「くろくろ」）
- React で構築する SPA（Single Page Application）
- WebSocket でサーバーとリアルタイム双方向通信する
- ダークテーマベースの魔術的なデザイン

### 8.2 画面構成

#### 8.2.1 ダッシュボード（メイン画面）

実行中の Agent 一覧をグループ単位でカード形式で表示する。

**グループ表示:**
- グループはアコーディオン/セクション形式で表示する
- 各グループのヘッダーにはグループ ID、説明、所属 Agent 数、全体の進捗状況を表示する
- グループ内の Agent カードはグリッドまたはリスト形式で並べる
- グループに所属しない Agent は「未分類」セクションに表示する（通常は存在しない）

**Agent カード表示内容:**
- Agent ID
- 職種名・アイコン
- 使用モデル
- 実行ステータス
- 経過時間（ライブカウントアップ）
- ツール呼び出し回数（リアルタイムカウンター）
- 最新のアシスタントメッセージ（トランケート表示）

**ステータス色分け:**

| ステータス | 色 | 視覚効果 |
|---|---|---|
| `queued` | グレー | 点滅（待機中） |
| `running` | 青 | パルスアニメーション（実行中） |
| `completed` / `success` | 緑 | フェードイン完了表示 |
| `failed` | 赤 | シェイクアニメーション → 静止 |
| `timeout` | 黄/オレンジ | 警告アイコン点滅 |
| `resultReported` | 緑（濃） | チェックマーク表示 |

#### 8.2.2 職種管理画面

使用可能な職種一覧を表示し、設定をインライン編集できる。

**表示・編集項目:**
- 職種 ID（読み取り専用）
- 表示名
- モデル（ドロップダウン: 利用可能モデル一覧から選択）
- システムプロンプト（テキストエリア編集）
- ヘルスチェックプロンプト
- 利用可否ステータス

**操作:**
- モデル変更時にリアルタイムでモデル検証を再実行する
- 変更を保存すると `kuromajutsu.config.yaml` に反映する

#### 8.2.3 実行履歴画面

過去の Agent 実行結果一覧を表示する。

**表示項目:**
- Agent ID
- グループ ID・説明
- 職種
- ステータス
- サマリ
- 所要時間
- 編集/作成ファイル一覧
- ツール呼び出し回数
- 実行日時

**機能:**
- グループ、ステータス、職種でのフィルタリング
- グループ単位でのグルーピング表示
- 時系列ソート

#### 8.2.4 ヘルスチェック状況画面

起動時のヘルスチェック進行状況をリアルタイムで表示する。

**進行ステップの表示:**

```
[1/3] モデル検証中...
  ├─ impl-code (claude-4-sonnet)    ✅ 有効
  ├─ code-review (claude-4-sonnet)  ✅ 有効
  ├─ text-review (claude-4-sonnet)  ✅ 有効
  └─ impl-test (claude-4-sonnet)    ✅ 有効

[2/3] ヘルスチェック実行中...
  ├─ impl-code     🔄 チェック中... (1.2s)
  ├─ code-review   ✅ OK (0.8s)
  ├─ text-review   ⏳ 待機中
  └─ impl-test     ⏳ 待機中

[3/3] 完了
  全 4 職種中 4 職種が利用可能です
```

**UI表現:**
- チェック中の職種カード: スピナーアニメーション表示
- チェック完了（成功）: 緑チェックアイコンに切替
- チェック完了（失敗）: 赤バツアイコンに切替
- モデル検証エラー: 警告バッジ + 利用可能モデルの提案表示

#### 8.2.5 システム情報画面

サーバー環境に関する情報を表示する。職種登録時のモデル名確認に使用する。

**表示項目:**
- 利用可能モデル一覧（`agent models` コマンドで取得したモデル名のリスト）

**UI表現:**
- モデル名はモノスペースフォントで表示し、テキスト選択可能にする
- モデルが0件の場合は「モデル情報がありません」と表示する
- モデル数のサマリバッジを表示する

### 8.3 WebSocket イベント

サーバーからクライアント（UI）へ送信するイベント:

| イベント名 | 説明 | タイミング |
|---|---|---|
| `server:startup` | サーバー起動通知（`availableModels` を含む） | MCPサーバー起動時 |
| `healthcheck:model_validation` | モデル検証結果 | モデル検証完了時 |
| `healthcheck:role_start` | 職種チェック開始 | 各職種のヘルスチェック開始時 |
| `healthcheck:role_complete` | 職種チェック完了 | 各職種のヘルスチェック完了時 |
| `healthcheck:complete` | ヘルスチェック全体完了 | 全チェック完了時 |
| `group:created` | グループ作成通知 | `create_group` 呼び出し時 |
| `group:deleted` | グループ削除通知 | `delete_group` 呼び出し時 |
| `group:stage_advanced` | Sequential ステージ進行通知 | Sequential グループのステージが次に進んだ時 |
| `agent:created` | Agent 作成通知 | `run_agents` / `run_sequential` 呼び出し時 |
| `agent:status_update` | Agent 状態更新 | stream-json イベント受信時 |
| `agent:completed` | Agent 完了通知 | Agent プロセス終了時 |
| `agent:result_reported` | 結果登録通知 | `report_result` 呼び出し時 |
| `config:updated` | 設定変更通知 | UI から設定変更時 |

クライアントからサーバーへ送信するイベント:

| イベント名 | 説明 |
|---|---|
| `config:update_role` | 職種設定の変更リクエスト |
| `config:revalidate_model` | モデル再検証リクエスト |

---

## 9. 設定ファイル

### 9.1 ファイル構成

`kuromajutsu.config.yaml` で全設定を管理する。

### 9.2 設定スキーマ

```yaml
# kuromajutsu.config.yaml

# ダッシュボード設定
dashboard:
  port: 9696          # HTTP/WebSocket ポート（デフォルト: 9696「くろくろ」）

# Agent 実行設定
agent:
  # defaultTimeout_ms: 300000  # デフォルトタイムアウト（省略時: タイムアウトなし）
  maxConcurrent: 10          # 最大同時実行数

# ログ設定
log:
  level: info          # debug | info | warn | error

# 職種定義
roles:
  - id: impl-code
    name: コード実装者
    description: コードの実装・修正を行う。新機能の追加、バグ修正、リファクタリングなど、ファイルの編集を伴うタスクに使用する
    model: claude-4-sonnet
    systemPrompt: |
      あなたはコード実装の専門家です。
      与えられた仕様や指示に基づき、高品質なコードを実装してください。
      実装が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools: []

  - id: code-review
    name: コードレビュワー
    description: コードの品質をレビューする。実装完了後の品質チェック、セキュリティ・パフォーマンス観点のフィードバックに使用する。ファイルの編集は行わない
    model: claude-4-sonnet
    systemPrompt: |
      あなたはコードレビューの専門家です。
      与えられたコードを精査し、品質・可読性・セキュリティ・パフォーマンスの観点からフィードバックを提供してください。
      レビューが完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools: []

  - id: text-review
    name: 文章レビュワー
    description: 文章の品質をレビューする。ドキュメント・仕様書・READMEなどの文法・表現・構成チェックに使用する。ファイルの編集は行わない
    model: claude-4-sonnet
    systemPrompt: |
      あなたは文章レビューの専門家です。
      与えられたテキストの文法、表現、構成、一貫性を確認し、改善提案を提供してください。
      レビューが完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools: []

  - id: research
    name: 調査員
    description: 調査・情報収集を行う。技術選定、ベストプラクティスの調査、コードベースの分析などに使用する。ファイルの編集は行わない
    model: composer-1.5
    systemPrompt: |
      あなたは調査・情報収集の専門家です。
      与えられたテーマやトピックについて、Web検索やローカルファイルの検索を駆使して
      情報を収集し、整理された調査レポートとして報告してください。
      調査が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools: []

  - id: impl-test
    name: テスト実装者
    description: テストコードの実装を行う。ユニットテスト・統合テストの作成、テストカバレッジの向上に使用する
    model: claude-4-sonnet
    systemPrompt: |
      あなたはテスト実装の専門家です。
      与えられた仕様やコードに対して、包括的なテストを作成してください。
      ユニットテスト、エッジケース、異常系のテストを含めてください。
      実装が完了したら、必ず kuromajutsu MCP の `report_result` ツールを呼び出して結果を報告してください。
    healthCheckPrompt: "Hello, respond with exactly: OK"
    tools: []
```

### 9.3 設定の読み込み優先順位

1. 環境変数（`KUROMAJUTSU_PORT` 等で個別オーバーライド可能）
2. `kuromajutsu.config.yaml`（プロジェクトルート）
3. ビルトインデフォルト値

---

## 10. Cursor MCP 連携設定

### 10.1 mcp.json 設定例

プロジェクトの `.cursor/mcp.json` に以下を追加する:

```json
{
  "mcpServers": {
    "kuromajutsu": {
      "command": "npx",
      "args": ["tsx", "path/to/kuromajutsu/src/index.ts"],
      "env": {
        "CURSOR_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### 10.2 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `CURSOR_API_KEY` | はい | Cursor CLI 認証用 API キー |
| `KUROMAJUTSU_PORT` | いいえ | ダッシュボードポート（デフォルト: `9696`） |
| `KUROMAJUTSU_CONFIG` | いいえ | 設定ファイルパス（デフォルト: `./kuromajutsu.config.yaml`） |
| `KUROMAJUTSU_LOG_LEVEL` | いいえ | ログレベル（デフォルト: `info`） |

---

## 11. 利用フロー例

### 11.1 メイン Agent からの並列実行（Concurrent モード）

```
ユーザー → メインAgent: 「この機能を実装して、テストも書いて、レビューもして」

メインAgent:
  1. list_roles で利用可能な職種を確認
  2. create_group(description: "〇〇機能の実装・テスト・レビュー", mode: "concurrent") → groupId
  3. run_agents(groupId, agents: [
       { role: "impl-code", prompt: "〇〇機能を実装して" },
       { role: "impl-test", prompt: "〇〇機能のテストを書いて" }
     ]) → { agents: [{ agentId: agentId_1 }, { agentId: agentId_2 }], total: 2 }
  4. wait_agent(agentIds: [agentId_1, agentId_2], mode: "all")
  5. get_agent_status(agentId_1) で実装結果を確認
  6. run_agents(groupId, agents: [
       { role: "code-review", prompt: "agentId_1 の実装をレビューして" }
     ]) → { agents: [{ agentId: agentId_3 }], total: 1 }
  7. wait_agent(agentIds: [agentId_3])
  8. 結果を統合してユーザーに報告
  9. delete_group(groupId) でグループを削除
```

### 11.2 Sequential モード（パイプライン実行）

調査 → 実装（並列 3 台）→ テストのパイプライン例:

```
ユーザー → メインAgent: 「〇〇機能の調査から実装・テストまで一気にやって」

メインAgent:
  1. list_roles で利用可能な職種を確認
  2. create_group(description: "〇〇機能のパイプライン実行", mode: "sequential") → groupId
  3. run_sequential(groupId, stages: [
       { tasks: [{ role: "research", prompt: "〇〇機能に必要な技術・既存実装を調査して" }] },
       { tasks: [
           { role: "impl-code", prompt: "調査結果を元に〇〇機能の A 部分を実装して" },
           { role: "impl-code", prompt: "調査結果を元に〇〇機能の B 部分を実装して" },
           { role: "impl-code", prompt: "調査結果を元に〇〇機能の C 部分を実装して" }
         ] },
       { tasks: [{ role: "impl-test", prompt: "前ステージの実装結果を踏まえてテストを書いて" }] }
     ]) → { groupId, totalStages: 3, agents: [...] }
  4. wait_agent(agentIds: [...]) で全 Agent の完了を待機
  5. 結果を統合してユーザーに報告
  6. delete_group(groupId) でグループを削除
```

**Sequential のポイント:**
- Stage 1 の調査結果は Stage 2 の各実装 Agent のプロンプトに自動注入される
- Stage 2 の実装結果は Stage 3 のテスト Agent のプロンプトに自動注入される
- 各ステージ内は並列実行、ステージ間は直列

### 11.3 Magentic モード（Orchestrator 自律実行）

複雑なタスクを Orchestrator Agent に委任し、自律的に計画→委任→評価→リプランを繰り返して完了させる例:

```
ユーザー → メインAgent: 「認証機能を実装して。テストが通るまでやって」

メインAgent:
  1. list_roles で利用可能な職種を確認
  2. run_magentic(
       description: "認証機能の実装",
       task: "認証機能を実装する。ログイン、ログアウト、セッション管理を含む",
       completionCriteria: "全テストが通り、code-review で問題なしと判定されること",
       scope: "src/auth/ 配下のみ。既存の src/user/ は参照のみ",
       constraints: "既存の API インターフェースを変更しないこと",
       context: "認証仕様は docs/auth-spec.md を参照"
     ) → { groupId, orchestratorAgentId, status: "started" }
  3. wait_agent(agentIds: [orchestratorAgentId])
  4. get_agent_status(orchestratorAgentId) で最終結果を確認
  5. delete_group(groupId)
```

**Magentic のポイント:**
- メイン Agent はタスク・完了条件・範囲を指定するだけで、実行計画は Orchestrator に任せる
- Orchestrator が create_group → run_agents → wait_agent を自律的に繰り返す
- 失敗時は Orchestrator がリプランして再委任する
- maxIterations または timeout_ms で全体の制限が可能

### 11.4 ダッシュボードでの監視

1. ブラウザで `http://localhost:9696` を開く
2. 起動時のヘルスチェック状況がリアルタイムで表示される
3. グループが作成されると、ダッシュボードにグループセクションが追加される
4. Agent が起動されるとグループ内にカードが追加される
5. 各 Agent の進捗がリアルタイムで更新される
6. 完了した Agent の結果を履歴画面で確認できる（グループ単位でのフィルタリングも可能）

---

## 12. 将来の拡張ポイント

- **カスタム職種の UI 定義:** ダッシュボード UI から新しい職種を作成・編集・削除できるようにする
- **Magentic パターンの改善:** プロンプトチューニング、評価精度向上、Ledger フォーマットの最適化等
- **実行結果の永続化:** SQLite 等でセッション間をまたいで実行履歴を保持する
- **Agent のキャンセル機能:** 実行中の Agent を MCP ツール経由で中断する `cancel_agent` ツールの追加
- **ツール機能の拡張:** 現在はビルトインの textlint ツールのみ対応。カスタムツール定義や設定ファイルからのツール登録に対応する
- **実行コスト追跡:** API 使用量やトークン数を記録し、コスト分析を可能にする
- **通知機能:** Agent の完了や失敗をシステム通知やチャットで知らせる

---

## 付録 A. 用語集

本仕様書で使用する用語の定義。用語集は `docs/glossary.md` として独立管理し、開発フェーズの進行に合わせて更新する。

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| エージェント | Agent | Cursor CLI ヘッドレスモードで起動される独立した AI 実行単位。子プロセスとして動作する |
| メインエージェント | Main Agent | Cursor IDE 上でユーザーと直接対話する Agent。kuromajutsu の MCP ツールを呼び出して複数のサブ Agent を管理する |
| サブエージェント | Sub Agent | メインエージェントから `run_agents` または `run_sequential` で起動される Agent。特定の職種に基づいて動作する |
| 職種 / ロール | Role | Agent に割り当てる役割の定義。システムプロンプト、モデル、ツールセット等で構成される |
| MCPサーバー | MCP Server | Model Context Protocol に準拠したサーバー。Cursor と stdio で通信し、ツールを提供する |
| MCPツール | MCP Tool | MCPサーバーが公開する操作。`run_agents` 等の10個のツールを指す |
| ダッシュボード | Dashboard | ブラウザで表示する管理 UI。Agent の状態をリアルタイムで監視する |
| ヘッドレスモード | Headless Mode | Cursor CLI の非対話モード（`agent -p --force`）。GUI なしで Agent を実行する |
| stream-json | Stream JSON | Cursor CLI の `--output-format stream-json` で出力される NDJSON 形式のイベントストリーム |
| NDJSON | Newline Delimited JSON | 改行区切りの JSON 形式。各行が1つの JSON オブジェクトを表す |
| ヘルスチェック | Health Check | MCPサーバー起動時に各職種が正しく動作するか検証する自動チェック処理 |
| モデル検証 | Model Validation | 各職種に設定されたモデルが Cursor で利用可能かを確認する処理 |
| Agent ID | Agent ID | Agent の一意識別子。`{role}-{timestamp}-{random4hex}` 形式 |
| AgentResult | Agent Result | Agent 実行完了後の結果データ。サマリ、編集ファイル一覧、所要時間等を含む |
| AgentState | Agent State | Agent の現在の状態を表すデータ構造。ステータス、経過時間、ツール呼び出し数等を含む |
| stdio | Standard I/O | 標準入出力。MCPサーバーと Cursor 間の通信トランスポート |
| WebSocket | WebSocket | 双方向リアルタイム通信プロトコル。ダッシュボード UI とサーバー間で使用 |
| SSOT | Single Source of Truth | 唯一の信頼できる情報源。本プロジェクトでは `docs/spec.md` がこれに該当する |
| TDD | Test-Driven Development | テスト駆動開発。テストを先に書き、テストを通す実装を行う開発手法 |
