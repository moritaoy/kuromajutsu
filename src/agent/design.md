# Agent 実行エンジン 設計

## コンポーネント一覧

| コンポーネント | ファイル | 説明 |
|---------|------|------|
| AgentExecutor | executor.ts | Cursor CLI 子プロセスの起動・管理 |
| StreamJsonParser | parser.ts | stream-json NDJSON パーサー |
| AgentManager | manager.ts | Agent / Group ライフサイクル管理・状態管理 |

## ファイル構成

```
src/agent/
├── executor.ts    # Cursor CLI 実行（child_process.spawn）
├── parser.ts      # stream-json パーサー（NDJSONイベント解析）
└── manager.ts     # Agent / Group ライフサイクル管理（Map ベース）
```

## AgentManager

全 Agent と Group のライフサイクルを管理する中核コンポーネント。インメモリ Map で状態を保持し、EventEmitter パターンで状態変更を外部に通知する。

### クラス設計

```typescript
import { EventEmitter } from "node:events";
import type {
  AgentState, AgentResult, GroupDefinition,
  HealthCheckResult, AppConfig, RoleDefinition,
} from "../types/index.js";

export class AgentManager extends EventEmitter {
  /** Group 管理テーブル: groupId → GroupDefinition */
  private groups: Map<string, GroupDefinition>;

  /** Agent 管理テーブル: agentId → AgentState */
  private agents: Map<string, AgentState>;

  /** ヘルスチェック結果: roleId → HealthCheckResult */
  private healthCheckResults: Map<string, HealthCheckResult>;

  /** Agent 完了待ちの Promise resolver: agentId → resolve[] */
  private waitResolvers: Map<string, Array<() => void>>;

  /** AgentExecutor インスタンス（内部保持） */
  private executor: AgentExecutor;

  constructor(private config: AppConfig) {
    super();
    this.groups = new Map();
    this.agents = new Map();
    this.healthCheckResults = new Map();
    this.waitResolvers = new Map();
    this.executor = new AgentExecutor();
  }
}
```

### Group 管理メソッド

```typescript
/** グループを作成し Map に登録する */
createGroup(description: string): GroupDefinition;

/** グループを取得する（存在しなければ undefined） */
getGroup(groupId: string): GroupDefinition | undefined;

/** グループを削除する（status を "deleted" に変更） */
deleteGroup(groupId: string): void;

/** グループに所属する Agent を取得する */
getAgentsByGroup(groupId: string): AgentState[];
```

### Agent 管理メソッド

```typescript
/** Agent を起動し Map に登録する。AgentExecutor にプロセス起動を委譲 */
startAgent(
  groupId: string,
  role: RoleDefinition,
  prompt: string,
  options?: { workingDirectory?: string; timeout_ms?: number }
): AgentState;

/** Agent の状態を取得する（存在しなければ undefined） */
getAgent(agentId: string): AgentState | undefined;

/** フィルタ付き Agent 一覧を取得する */
listAgents(filter?: { groupId?: string; status?: string }): AgentState[];

/** 現在実行中（queued + running）の Agent 数を取得する */
getRunningCount(): number;

/**
 * 指定 Agent の完了を待機する（Promise ベース）
 * @param mode "all" → 全完了で resolve / "any" → いずれか完了で resolve
 * @param timeout_ms タイムアウト（ミリ秒）
 */
waitForAgents(
  agentIds: string[],
  mode?: "all" | "any",
  timeout_ms?: number
): Promise<{ completed: AgentState[]; pending: AgentState[]; timedOut: boolean }>;

/** 結果を登録し、ステータスを resultReported に更新する */
reportResult(agentId: string, reportData: {
  status: "success" | "failure" | "timeout" | "cancelled";
  summary: string;
  editedFiles?: string[];
  createdFiles?: string[];
  errorMessage?: string;
}): AgentResult;
```

### ヘルスチェック結果管理

```typescript
/** ヘルスチェック結果を登録する */
setHealthCheckResults(results: HealthCheckResult[]): void;

/** 特定職種のヘルスチェック結果を取得する */
getHealthCheckResult(roleId: string): HealthCheckResult | undefined;

/** 全職種のヘルスチェック結果を取得する */
getHealthCheckResults(): HealthCheckResult[];
```

### 内部状態更新（StreamParser からのコールバック）

```typescript
/** Agent の状態を部分更新する（stream-json イベント由来） */
updateAgentState(agentId: string, partial: Partial<AgentState>): void;

/** Agent のステータスを遷移する */
private transitionStatus(agentId: string, newStatus: AgentStatus): void;

/** Agent の完了処理（waitResolvers の resolve、イベント通知） */
private handleAgentCompletion(agentId: string): void;
```

### イベント通知（EventEmitter）

AgentManager は `EventEmitter` を継承し、以下のイベントを emit する。
ダッシュボードの WebSocket サーバーがこれらのイベントをリッスンし、クライアントに中継する。

| イベント名 | ペイロード | トリガー |
|---|---|---|
| `group:created` | `GroupDefinition` | createGroup 呼び出し時 |
| `group:deleted` | `{ groupId: string }` | deleteGroup 呼び出し時 |
| `agent:created` | `AgentState` | startAgent 呼び出し時 |
| `agent:status_update` | `Partial<AgentState> & { agentId: string }` | stream-json イベント受信時 |
| `agent:completed` | `AgentState` | Agent プロセス終了時 |
| `agent:result_reported` | `AgentResult` | reportResult 呼び出し時 |

### 状態遷移ルール

```
Queued ──(spawn 成功)──→ Running
Queued ──(spawn 失敗)──→ Failed
Running ──(exit 0 + result イベント)──→ Completed
Running ──(非 0 exit / エラー)──→ Failed
Running ──(timeout)──→ TimedOut
Completed ──(report_result)──→ ResultReported
Failed ──(report_result)──→ ResultReported
TimedOut ──(report_result)──→ ResultReported
```

不正な遷移（例: Completed → Running）は無視してログを出力する。

### ID 発番

```typescript
/** Group ID を発番する */
private generateGroupId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.random().toString(16).slice(2, 6);
  return `grp-${timestamp}-${random}`;
}

/** Agent ID を発番する */
private generateAgentId(role: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.random().toString(16).slice(2, 6);
  return `${role}-${timestamp}-${random}`;
}
```

### waitForAgents 内部実装

```typescript
async waitForAgents(
  agentIds: string[],
  mode: "all" | "any" = "all",
  timeout_ms?: number
): Promise<{ completed: AgentState[]; pending: AgentState[]; timedOut: boolean }> {
  // 1. 既に完了している Agent を分離
  const alreadyDone = agentIds.filter(id => {
    const agent = this.agents.get(id);
    return agent && ["completed", "failed", "timedOut", "resultReported"].includes(agent.status);
  });
  const remaining = agentIds.filter(id => !alreadyDone.includes(id));

  // 2. mode="any" で既完了があればすぐ返却
  if (mode === "any" && alreadyDone.length > 0) {
    return { completed: [...], pending: [...], timedOut: false };
  }

  // 3. 未完了 Agent に対して Promise を作成し waitResolvers に登録
  const promises = remaining.map(id =>
    new Promise<void>(resolve => {
      const resolvers = this.waitResolvers.get(id) ?? [];
      resolvers.push(resolve);
      this.waitResolvers.set(id, resolvers);
    })
  );

  // 4. mode に応じて Promise.all / Promise.race
  // 5. timeout_ms があれば Promise.race で setTimeout と競合
  // 6. 結果を分類して返却
}
```

## AgentExecutor

Cursor CLI をヘッドレスモードで子プロセスとして起動・管理するコンポーネント。

### クラス設計

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { StreamJsonParser } from "./parser.js";

interface ExecutorOptions {
  /** 使用する LLM モデル名 */
  model: string;
  /** プロンプト（systemPrompt + "\n\n" + userPrompt） */
  prompt: string;
  /** 作業ディレクトリ */
  workingDirectory?: string;
  /** タイムアウト（ミリ秒） */
  timeout_ms?: number;
}

interface ExecutorCallbacks {
  /** stream-json イベント受信時のコールバック */
  onStreamEvent: (event: StreamEvent) => void;
  /** プロセス終了時のコールバック */
  onExit: (exitCode: number | null, signal: string | null) => void;
  /** エラー発生時のコールバック */
  onError: (error: Error) => void;
}

export class AgentExecutor {
  /** 実行中プロセスの管理: agentId → ChildProcess */
  private processes: Map<string, ChildProcess>;
  /** タイマーの管理: agentId → NodeJS.Timeout */
  private timeouts: Map<string, NodeJS.Timeout>;

  constructor() {
    this.processes = new Map();
    this.timeouts = new Map();
  }
}
```

### 主要メソッド

```typescript
/**
 * Cursor CLI を起動する
 * @returns 子プロセスの PID
 */
execute(agentId: string, options: ExecutorOptions, callbacks: ExecutorCallbacks): number;

/**
 * 実行中のプロセスを終了する（SIGTERM → 猶予後 SIGKILL）
 */
kill(agentId: string): void;

/**
 * 全プロセスを終了する（シャットダウン用）
 */
killAll(): void;
```

### 起動コマンド

```bash
agent -p --force \
  -m "{model}" \
  --output-format stream-json \
  --stream-partial-output \
  "{systemPrompt}\n\n{userPrompt}"
```

### execute メソッドの処理フロー

```typescript
execute(agentId: string, options: ExecutorOptions, callbacks: ExecutorCallbacks): number {
  // 1. コマンド引数を構築
  const args = [
    "-p", "--force",
    "-m", options.model,
    "--output-format", "stream-json",
    "--stream-partial-output",
    options.prompt,
  ];

  // 2. child_process.spawn で起動
  const child = spawn("agent", args, {
    cwd: options.workingDirectory ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],  // stdin 不使用、stdout/stderr をパイプ
  });

  // 3. stdout を StreamJsonParser にパイプ
  const parser = new StreamJsonParser();
  parser.on("event", callbacks.onStreamEvent);
  child.stdout?.pipe(parser);

  // 4. stderr をバッファに蓄積
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  // 5. プロセス終了ハンドリング
  child.on("exit", (code, signal) => {
    this.clearTimeout(agentId);
    this.processes.delete(agentId);
    callbacks.onExit(code, signal);
  });

  child.on("error", (err) => {
    this.clearTimeout(agentId);
    this.processes.delete(agentId);
    callbacks.onError(err);
  });

  // 6. プロセスを Map に登録
  this.processes.set(agentId, child);

  // 7. タイムアウト設定
  if (options.timeout_ms) {
    const timer = setTimeout(() => {
      this.kill(agentId);
    }, options.timeout_ms);
    this.timeouts.set(agentId, timer);
  }

  return child.pid!;
}
```

### タイムアウト処理

```typescript
kill(agentId: string): void {
  const child = this.processes.get(agentId);
  if (!child) return;

  // 1. SIGTERM を送信（graceful shutdown）
  child.kill("SIGTERM");

  // 2. 5秒後にまだ生きていたら SIGKILL で強制終了
  setTimeout(() => {
    if (this.processes.has(agentId)) {
      child.kill("SIGKILL");
    }
  }, 5000);
}
```

## StreamJsonParser

NDJSON（改行区切り JSON）の各行をパースし、イベントタイプに応じたコールバックを呼び出す Transform ストリーム。

### クラス設計

```typescript
import { Transform, type TransformCallback } from "node:stream";

/** stream-json のイベント型 */
export interface StreamEvent {
  type: "system" | "user" | "assistant" | "tool_call" | "result";
  subtype?: "init" | "started" | "completed" | "success";
  /** イベント固有のデータ */
  data: Record<string, unknown>;
}

export class StreamJsonParser extends Transform {
  /** 行バッファ（不完全な行を保持） */
  private lineBuffer: string;

  constructor() {
    super({ readableObjectMode: true });
    this.lineBuffer = "";
  }
}
```

### パース処理

```typescript
_transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
  this.lineBuffer += chunk.toString();

  // 改行で分割し、完全な行をパース
  const lines = this.lineBuffer.split("\n");
  // 最後の要素は不完全な可能性があるのでバッファに戻す
  this.lineBuffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as StreamEvent;
      this.emit("event", event);
      this.push(event);
    } catch {
      // パース失敗行はスキップ（ログ出力）
      console.error(`[parser] JSON パース失敗: ${trimmed.slice(0, 100)}`);
    }
  }

  callback();
}

_flush(callback: TransformCallback): void {
  // 残りのバッファを処理
  if (this.lineBuffer.trim()) {
    try {
      const event = JSON.parse(this.lineBuffer.trim()) as StreamEvent;
      this.emit("event", event);
      this.push(event);
    } catch {
      // ignore
    }
  }
  callback();
}
```

### パースするイベント詳細

| イベント type | subtype | 処理内容 | 更新する AgentState フィールド |
|---|---|---|---|
| `system` | `init` | モデル名・セッション ID を記録 | model（検証用） |
| `user` | - | プロンプト送信を記録（ログ用） | なし |
| `assistant` | - | 最新メッセージを保持 | lastAssistantMessage |
| `tool_call` | `started` | ツール呼び出しカウント +1 | toolCallCount, recentToolCalls |
| `tool_call` | `completed` | 結果記録。writeToolCall ならファイル一覧更新 | recentToolCalls, editedFiles, createdFiles |
| `result` | `success` | 完了。duration_ms と最終テキスト記録 | status → completed, elapsed_ms |

### writeToolCall の検出とファイル一覧抽出

```typescript
/** tool_call completed イベントから editedFiles / createdFiles を抽出する */
private extractFileChanges(event: StreamEvent): {
  editedFiles: string[];
  createdFiles: string[];
} {
  const data = event.data;
  const editedFiles: string[] = [];
  const createdFiles: string[] = [];

  // writeToolCall（ファイル書き込み）の場合
  if (data.toolName === "write" || data.toolName === "edit") {
    const filePath = data.args?.path as string | undefined;
    if (filePath) {
      // 新規作成 vs 編集 の判定は toolName で行う
      if (data.toolName === "write") {
        createdFiles.push(filePath);
      } else {
        editedFiles.push(filePath);
      }
    }
  }

  return { editedFiles, createdFiles };
}
```

## AgentManager と AgentExecutor の連携フロー

```
MCPツール(run_agents)
    │
    ▼
AgentManager.startAgent()
    │ 1. AgentState を構築（status: "queued"）
    │ 2. Map に登録
    │ 3. emit("agent:created")
    │
    ▼
AgentExecutor.execute()
    │ 1. child_process.spawn で Cursor CLI 起動
    │ 2. stdout → StreamJsonParser にパイプ
    │
    ├──→ StreamJsonParser
    │       │ NDJSON 各行をパース
    │       │ "event" イベントを emit
    │       ▼
    │    AgentManager.updateAgentState()
    │       │ toolCallCount++
    │       │ lastAssistantMessage 更新
    │       │ editedFiles / createdFiles 追加
    │       │ emit("agent:status_update")
    │       ▼
    │    WebSocket → ダッシュボード UI
    │
    └──→ onExit コールバック
            │ exit code を判定
            │ status を Completed / Failed に遷移
            │ emit("agent:completed")
            ▼
         AgentManager.handleAgentCompletion()
            │ waitResolvers を resolve
            ▼
         MCPツール(wait_agent) の Promise が resolve
```

## テスト方針

### StreamJsonParser テスト（`tests/agent/parser.test.ts`）

- **正常系:** 各イベントタイプ（system/init, user, assistant, tool_call/started, tool_call/completed, result）のパーステスト
- **NDJSON サンプルデータ:** 複数行を一度に流してすべてパースされることを検証
- **不完全な行:** チャンク境界で行が分割される場合のバッファリング処理
- **不正な JSON:** パースエラー時にスキップされることを検証
- **writeToolCall 検出:** ファイルパスの抽出が正しく行われることを検証

### AgentExecutor テスト（`tests/agent/executor.test.ts`）

- **起動テスト:** 正しいコマンド引数で spawn が呼ばれることをモックで検証
- **プロセス終了:** exit コールバックが正しく呼ばれることを検証
- **タイムアウト:** 指定時間後に SIGTERM → SIGKILL の順序で終了することを検証
- **kill:** 実行中プロセスの終了が正しく行われることを検証
- **killAll:** 全プロセスが終了されることを検証

### AgentManager テスト（`tests/agent/manager.test.ts`）

- **Group 管理:** 作成・取得・削除の基本 CRUD
- **Agent 管理:** startAgent → 状態取得 → listAgents のフロー
- **状態遷移:** Queued → Running → Completed → ResultReported の正常フロー
- **不正な遷移:** Completed → Running が無視されることを検証
- **waitForAgents:**
  - mode="all": 全 Agent 完了で resolve
  - mode="any": いずれか完了で resolve
  - timeout: タイムアウト時の pending 分類
  - 既完了 Agent が含まれる場合の即時返却
- **reportResult:** 自動収集データとのマージ、重複排除
- **同時実行数制御:** maxConcurrent 超過時のエラー
- **イベント通知:** 各メソッド呼び出し時に正しいイベントが emit されることを検証

### テストファイル構成

```
tests/agent/
├── parser.test.ts     # StreamJsonParser のユニットテスト
├── executor.test.ts   # AgentExecutor のユニットテスト（spawn モック）
└── manager.test.ts    # AgentManager のユニットテスト
```

## 実装順序

| 順序 | 機能 | 説明 | 完了条件 |
|------|------|------|---------|
| 1 | StreamJsonParser | NDJSON パース基盤（Transform ストリーム） | パーステスト全通過 |
| 2 | AgentExecutor | Cursor CLI 起動・プロセス管理（spawn ラッパー） | spawn モックテスト全通過 |
| 3 | AgentManager（Group） | Group の CRUD 管理 | Group 管理テスト全通過 |
| 4 | AgentManager（Agent 基本） | Agent 登録・状態取得・一覧取得 | Agent 基本テスト全通過 |
| 5 | AgentManager（起動連携） | startAgent → Executor → Parser の連携 | 起動フローテスト全通過 |
| 6 | AgentManager（待機） | waitForAgents の Promise 処理 | wait テスト全通過 |
| 7 | AgentManager（結果マージ） | reportResult の自動収集データマージ | マージテスト全通過 |
| 8 | タイムアウト処理 | タイムアウト → SIGTERM → SIGKILL | タイムアウトテスト全通過 |
| 9 | イベント通知統合 | 全状態変更で正しいイベントが emit される | イベントテスト全通過 |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] Agent 起動〜完了の E2E フロー確認 OK
- [ ] コミット完了
