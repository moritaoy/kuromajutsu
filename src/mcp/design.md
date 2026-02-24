# MCPサーバー 設計

## ツール一覧

| ツール名 | 説明 | 入力パラメータ | 返却値 |
|---------|------|-------------|--------|
| create_group | グループ作成 | description | { groupId, description, createdAt, status } |
| delete_group | グループ削除 | groupId | { deleted, groupId } |
| run_agents | 1台以上の Agent を一括起動 | groupId, agents[] | { agents[], total } |
| run_sequential | ステージ制 Sequential 実行計画を投入 | groupId, stages[] | { groupId, stages[], agents[], total } |
| list_agents | Agent 一覧取得 | groupId?, status? | { agents[], total } |
| get_agent_status | Agent 詳細取得 | agentId | { agentId, groupId, status, toolCallCount, ... } |
| wait_agent | Agent 完了待機 | agentIds, timeout_ms?, mode? | { completed[], pending[], timedOut } |
| report_result | 結果登録 | agentId, status, summary, ... | { registered, agentId } |
| list_roles | 職種一覧取得 | なし | { roles[] } |

## ファイル構成

```
src/mcp/
├── server.ts             # MCPサーバー本体（@modelcontextprotocol/sdk、stdio トランスポート）
└── tools/
    ├── index.ts          # 全9ツールの一括登録エントリーポイント
    ├── create-group.ts   # create_group ツール定義・ハンドラ
    ├── delete-group.ts   # delete_group ツール定義・ハンドラ
    ├── run-agents.ts     # run_agents ツール定義・ハンドラ
    ├── run-sequential.ts # run_sequential ツール定義・ハンドラ
    ├── list-agents.ts    # list_agents ツール定義・ハンドラ
    ├── get-agent-status.ts # get_agent_status ツール定義・ハンドラ
    ├── wait-agent.ts     # wait_agent ツール定義・ハンドラ
    ├── report-result.ts  # report_result ツール定義・ハンドラ
    └── list-roles.ts     # list_roles ツール定義・ハンドラ
```

## アーキテクチャ

### server.ts

MCPサーバー本体。`@modelcontextprotocol/sdk` の `McpServer` クラスを利用し、stdio トランスポートで Cursor と通信する。

```typescript
// 既存の実装（Step 1 で作成済み）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// createMcpServer(config) → McpServer を生成し、registerTools で 9 ツールを登録
// startMcpServer(server) → StdioServerTransport で接続
```

### tools/index.ts

全 9 ツールを `registerTools(server, config)` で一括登録する。各ツールハンドラには `AgentManager` インスタンスを注入する。

**依存関係の注入パターン:**

```typescript
// Step 3 で AgentManager を引数に追加する
export function registerTools(
  server: McpServer,
  config: AppConfig,
  manager: AgentManager       // ← 追加予定
): void {
  registerCreateGroup(server, config, manager);
  registerDeleteGroup(server, config, manager);
  registerRunAgents(server, config, manager);
  registerRunSequential(server, config, manager);
  registerListAgents(server, config, manager);
  registerGetAgentStatus(server, config, manager);
  registerWaitAgent(server, config, manager);
  registerReportResult(server, config, manager);
  registerListRoles(server, config, manager);
}
```

## ツール設計

### create_group

- **入力:** `{ description: string }`
- **Zod スキーマ:** `{ description: z.string().describe("グループの目的の簡潔な説明") }`
- **処理:**
  1. ID 発番: `grp-{Math.floor(Date.now()/1000)}-{random4hex}`
  2. `GroupDefinition` オブジェクトを構築（status: "active", agentIds: []）
  3. `AgentManager.createGroup(groupDef)` でインメモリ Map に登録
  4. `AgentManager.emit("group:created", groupDef)` で WebSocket 通知をトリガー
- **出力:** `{ groupId, description, createdAt, status: "active" }`
- **エラー:** なし（ID 衝突は実質的に発生しない）

### delete_group

- **入力:** `{ groupId: string }`
- **Zod スキーマ:** `{ groupId: z.string().describe("削除対象のグループ ID") }`
- **処理:**
  1. `AgentManager.getGroup(groupId)` でグループ存在チェック → 無ければエラー
  2. `AgentManager.getAgentsByGroup(groupId)` で実行中 Agent がないことを確認 → あればエラー
  3. `AgentManager.deleteGroup(groupId)` で管理テーブルから削除（status を "deleted" に更新）
  4. `AgentManager.emit("group:deleted", { groupId })` で WebSocket 通知
- **出力:** `{ deleted: true, groupId }`
- **エラー:**
  - `GROUP_NOT_FOUND`: 指定された groupId が存在しない
  - `GROUP_HAS_RUNNING_AGENTS`: 実行中の Agent が存在する

### run_agents

- **入力:** `{ groupId, agents: [{ role, prompt, workingDirectory?, timeout_ms? }, ...] }`
- **Zod スキーマ:**
  ```typescript
  {
    groupId: z.string().describe("所属するグループ ID"),
    agents: z.array(agentSchema).min(1).describe("起動する Agent の定義配列"),
  }
  // agentSchema = { role, prompt, workingDirectory?, timeout_ms? }
  ```
- **処理:**
  1. `AgentManager.getGroup(groupId)` で存在・アクティブ・モードチェック（concurrent 必須）→ エラーハンドリング
  2. 全タスクの `role` を事前検証（存在チェック・ヘルスチェック結果）
  3. `AgentManager.getRunningCount()` で同時実行数チェック → 上限到達ならエラー
  4. `AgentManager.startAgents(groupId, taskDefs)` に委譲
  5. AgentManager 内で各 Agent を起動し、グループの agentIds に追加
  6. 各 Agent について `AgentManager.emit("agent:created", agentState)` で WebSocket 通知
- **出力:** `{ agents: [{ agentId, groupId, role, model, status }], total }`
- **エラー:**
  - `EMPTY_AGENTS`: agents 配列が空
  - `GROUP_NOT_FOUND`: groupId が存在しない
  - `GROUP_NOT_ACTIVE`: グループが active でない
  - `MODE_MISMATCH`: グループが concurrent でない
  - `ROLE_NOT_FOUND`: 指定された職種が存在しない
  - `ROLE_UNAVAILABLE`: 職種がヘルスチェック未通過
  - `MAX_CONCURRENT_REACHED`: 同時実行上限に到達
  - `AGENTS_START_FAILED`: 起動中にエラー

### run_sequential

- **入力:** `{ groupId, stages: [{ tasks: [{ role, prompt, workingDirectory?, timeout_ms? }] }] }`
- **Zod スキーマ:**
  ```typescript
  {
    groupId: z.string().describe("所属するグループ ID（mode: sequential で作成済み）"),
    stages: z.array(stageSchema).min(1).describe("実行ステージの配列（先頭から順に実行）"),
  }
  // stageSchema = { tasks: z.array(taskSchema).min(1) }
  // taskSchema = { role, prompt, workingDirectory?, timeout_ms? }
  ```
- **処理:**
  1. stages が空でないこと、各ステージの tasks が空でないことを検証
  2. `AgentManager.getGroup(groupId)` で存在・アクティブ・モードチェック（sequential 必須）→ エラーハンドリング
  3. 全ステージの全タスクの `role` を事前検証
  4. 最大ステージタスク数で `maxConcurrent` 残枠をチェック
  5. `AgentManager.submitSequential(groupId, stages)` に委譲
  6. 第1ステージの Agent を起動し、以降は完了に応じて次ステージを自動起動
- **出力:** `{ groupId, totalStages, currentStageIndex, stages: [{ stageIndex, agentIds }], agents: [...], total }`
- **エラー:**
  - `EMPTY_STAGES`: stages 配列が空
  - `EMPTY_STAGE_TASKS`: いずれかのステージの tasks が空
  - `GROUP_NOT_FOUND`: groupId が存在しない
  - `GROUP_NOT_ACTIVE`: グループが active でない
  - `MODE_MISMATCH`: グループが sequential でない
  - `ROLE_NOT_FOUND`: 指定された職種が存在しない
  - `ROLE_UNAVAILABLE`: 職種がヘルスチェック未通過
  - `MAX_CONCURRENT_REACHED`: 最大ステージタスク数が残枠を超える
  - `SEQUENTIAL_START_FAILED`: 計画投入中にエラー

### list_agents

- **入力:** `{ groupId?: string, status?: string }`
- **Zod スキーマ:**
  ```typescript
  {
    groupId: z.string().optional().describe("フィルタ: グループ ID"),
    status: z.string().optional().describe("フィルタ: running, completed, failed, all"),
  }
  ```
- **処理:**
  1. `AgentManager.listAgents(filter)` でフィルタ付き一覧取得
  2. groupId 指定時: 該当グループの Agent のみ返却
  3. status 指定時: 該当ステータスの Agent のみ返却（"all" または未指定は全件）
  4. 各 Agent から公開用フィールド（agentId, groupId, role, model, status, startedAt, elapsed_ms, toolCallCount）を抽出
- **出力:** `{ agents: [...], total: number }`

### get_agent_status

- **入力:** `{ agentId: string }`
- **Zod スキーマ:** `{ agentId: z.string().describe("Agent ID") }`
- **処理:**
  1. `AgentManager.getAgent(agentId)` で Agent 状態を取得 → 無ければエラー
  2. `elapsed_ms` を現在時刻から再計算（running の場合）
  3. 完全な AgentState を返却（pid を除く）
- **出力:** AgentState の公開フィールド全体
- **エラー:**
  - `AGENT_NOT_FOUND`: agentId が存在しない

### wait_agent

- **入力:** `{ agentIds, timeout_ms?, mode? }`
- **Zod スキーマ:**
  ```typescript
  {
    agentIds: z.array(z.string()).describe("待機対象の Agent ID 配列"),
    timeout_ms: z.number().optional().describe("全体のタイムアウト（ミリ秒）"),
    mode: z.enum(["all", "any"]).optional().describe("all: 全完了 / any: いずれか完了"),
  }
  ```
- **処理:**
  1. 各 agentId の存在チェック → 無ければエラー
  2. `AgentManager.waitForAgents(agentIds, mode, timeout_ms)` に委譲
  3. 内部実装: 各 Agent に対して完了時に resolve する Promise を作成
  4. mode="all" → `Promise.all`, mode="any" → `Promise.race`
  5. timeout_ms 指定時は `Promise.race` で setTimeout と競合させる
  6. タイムアウト到達時: timedOut=true、未完了 Agent を pending に分類
- **出力:** `{ completed: [...], pending: [...], timedOut: boolean }`
- **エラー:**
  - `AGENT_NOT_FOUND`: いずれかの agentId が存在しない

### report_result

- **入力:** `{ agentId, status, summary, editedFiles?, createdFiles?, errorMessage? }`
- **Zod スキーマ:**
  ```typescript
  {
    agentId: z.string().describe("Agent ID"),
    status: z.enum(["success", "failure", "timeout", "cancelled"]).describe("結果ステータス"),
    summary: z.string().describe("端的なテキストサマリ"),
    editedFiles: z.array(z.string()).optional().describe("編集したファイルパス一覧"),
    createdFiles: z.array(z.string()).optional().describe("新規作成したファイルパス一覧"),
    errorMessage: z.string().optional().describe("失敗時のエラーメッセージ"),
  }
  ```
- **処理:**
  1. `AgentManager.getAgent(agentId)` で Agent 存在チェック → 無ければエラー
  2. 自動収集データ（stream-json 由来）を取得:
     - `editedFiles`: Agent の自動収集 + report_result 入力のマージ（重複排除）
     - `createdFiles`: 同上
     - `toolCallCount`: stream-json から計測
     - `duration_ms`: startedAt からの経過時間
  3. `AgentResult` を構築（自動付与フィールドを追加）:
     - groupId, role, model: AgentState から取得
     - timestamp: 現在時刻
  4. `AgentManager.reportResult(agentId, result)` でステータスを `resultReported` に更新
  5. `AgentManager.emit("agent:result_reported", result)` で WebSocket 通知
- **出力:** `{ registered: true, agentId }`
- **エラー:**
  - `AGENT_NOT_FOUND`: agentId が存在しない

### list_roles

- **入力:** なし
- **Zod スキーマ:** `{}`（空オブジェクト）
- **処理:**
  1. `config.roles` から全職種を取得
  2. `AgentManager.getHealthCheckResults()` から各職種のヘルスチェック結果を取得
  3. 各職種にヘルスチェック結果と利用可否ステータスを付与
- **出力:** `{ roles: [...] }` （各職種の id, name, model, available, healthCheck, modelValidation を含む）

## エラーレスポンス規約

全ツール共通のエラーレスポンス形式:

```typescript
// MCP SDK の仕様に従い isError: true を返す
return {
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: true,
        code: "GROUP_NOT_FOUND",       // エラーコード（定数）
        message: "グループ 'grp-xxx' が見つかりません",  // 人間可読メッセージ
      }),
    },
  ],
  isError: true,
};
```

**エラーコード一覧:**

| コード | 説明 | 発生するツール |
|--------|------|--------------|
| `GROUP_NOT_FOUND` | グループが存在しない | delete_group, run_agents, run_sequential |
| `GROUP_NOT_ACTIVE` | グループが active でない | run_agents, run_sequential |
| `GROUP_HAS_RUNNING_AGENTS` | 実行中 Agent が残っている | delete_group |
| `ROLE_NOT_FOUND` | 職種が存在しない | run_agents, run_sequential |
| `ROLE_UNAVAILABLE` | 職種がヘルスチェック未通過 | run_agents, run_sequential |
| `MAX_CONCURRENT_REACHED` | 同時実行上限 | run_agents, run_sequential |
| `MODE_MISMATCH` | グループモードがツールと不一致 | run_agents, run_sequential |
| `AGENT_NOT_FOUND` | Agent が存在しない | get_agent_status, wait_agent, report_result |
| `EMPTY_AGENTS` | agents 配列が空 | run_agents |
| `EMPTY_STAGES` | stages 配列が空 | run_sequential |
| `EMPTY_STAGE_TASKS` | ステージの tasks が空 | run_sequential |
| `AGENTS_START_FAILED` | Agent 一括起動に失敗 | run_agents |
| `SEQUENTIAL_START_FAILED` | Sequential 計画投入に失敗 | run_sequential |

## テスト方針

- 各ツールに対してユニットテストを作成（`tests/mcp/tools/` 配下）
- `AgentManager` をモック化してツール単体で検証
- Zod スキーマによる入力バリデーションテスト（必須パラメータ欠落、不正な型等）
- エラーケース（存在しない groupId / agentId、実行中 Agent がある状態での削除等）
- `npm test` で全テスト実行

**テストファイル構成:**

```
tests/mcp/
├── tools/
│   ├── create-group.test.ts
│   ├── delete-group.test.ts
│   ├── run-agents.test.ts
│   ├── run-sequential.test.ts
│   ├── list-agents.test.ts
│   ├── get-agent-status.test.ts
│   ├── wait-agent.test.ts
│   ├── report-result.test.ts
│   └── list-roles.test.ts
└── server.test.ts
```

## 実装順序

| 順序 | 機能 | 説明 | 依存関係 |
|------|------|------|---------|
| 1 | MCPサーバー骨組み | @modelcontextprotocol/sdk でサーバー初期化 | なし（Step 1 で完了済み） |
| 2 | AgentManager 基盤 | Group/Agent のインメモリ管理、ID 発番 | なし |
| 3 | create_group | AgentManager.createGroup を呼び出す | AgentManager 基盤 |
| 4 | delete_group | 存在チェック・実行中チェック後に削除 | AgentManager 基盤 |
| 5 | list_roles | 設定読み込み + ヘルスチェック結果付与 | config |
| 6 | run_agents | 検証 → Agent 一括起動を AgentManager に委譲 | AgentManager + AgentExecutor |
| 6b | run_sequential | 検証 → Sequential 実行計画を AgentManager に投入 | AgentManager + AgentExecutor |
| 7 | list_agents | AgentManager からフィルタ付き一覧取得 | AgentManager |
| 8 | get_agent_status | AgentManager から詳細状態取得 | AgentManager |
| 9 | wait_agent | Promise ベースの完了待機 | AgentManager |
| 10 | report_result | 自動収集データとのマージ・結果登録 | AgentManager |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] MCP Inspector で動作確認 OK
- [ ] コミット完了
