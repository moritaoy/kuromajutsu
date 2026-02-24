# ダッシュボード UI 設計

## 画面一覧

| 画面 | パス | 説明 |
|------|------|------|
| ダッシュボード | `/` | 実行中 Agent 一覧（グループ単位のカード表示） |
| 職種管理 | `/roles` | 職種の一覧・設定編集 |
| 実行履歴 | `/history` | 過去の実行結果一覧 |
| ヘルスチェック | `/health` | 起動時チェック状況 |

## ファイル構成

```
src/dashboard/
├── server.ts              # HTTP サーバー + WebSocket サーバー
└── public/                # React SPA（ビルド済み静的ファイル）
    ├── index.html         # HTML エントリーポイント（React マウント）
    ├── app.tsx            # ルートコンポーネント（ルーティング）
    ├── components/
    │   ├── Layout.tsx     # 共通レイアウト（ヘッダー・ナビゲーション）
    │   ├── AgentCard.tsx  # Agent ステータスカード
    │   ├── GroupSection.tsx # グループセクション（アコーディオン）
    │   ├── RoleEditor.tsx # 職種設定エディタ
    │   ├── HistoryTable.tsx # 実行履歴テーブル
    │   └── HealthStatus.tsx # ヘルスチェック状況表示
    ├── hooks/
    │   ├── useWebSocket.ts  # WebSocket 接続管理フック
    │   └── useAgentStore.ts # Agent/Group 状態管理フック
    └── styles/
        └── theme.css      # ダークテーマ（魔術的デザイン）
```

## サーバーサイド設計

### server.ts

Express を使わず Node.js 標準の `http.createServer` で HTTP サーバーを構築済み（Step 1）。
Step 3 で WebSocket サーバー（`ws` パッケージ）を同ポートに追加する。

```typescript
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentManager } from "../agent/manager.js";
import type { ServerEvent, ClientEvent } from "../types/index.js";

export function startDashboardServer(
  config: AppConfig,
  manager: AgentManager  // ← Step 3 で追加
): Server {
  const server = createServer(/* 既存の静的ファイル配信 */);

  // WebSocket サーバーを同ポートで起動
  const wss = new WebSocketServer({ server });

  // クライアント接続管理
  wss.on("connection", (ws: WebSocket) => {
    // 初期データ送信（現在の状態スナップショット）
    sendInitialState(ws, manager);

    // クライアントからのイベント受信
    ws.on("message", (data: string) => {
      const event = JSON.parse(data) as ClientEvent;
      handleClientEvent(event, manager, config);
    });
  });

  // AgentManager のイベントを全クライアントにブロードキャスト
  setupBroadcast(wss, manager);

  server.listen(config.dashboard.port);
  return server;
}
```

### ブロードキャスト処理

```typescript
function setupBroadcast(wss: WebSocketServer, manager: AgentManager): void {
  const broadcast = (event: ServerEvent) => {
    const message = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  // AgentManager のイベントをリッスンしてブロードキャスト
  manager.on("group:created", (data) =>
    broadcast({ type: "group:created", data }));
  manager.on("group:deleted", (data) =>
    broadcast({ type: "group:deleted", data }));
  manager.on("agent:created", (data) =>
    broadcast({ type: "agent:created", data }));
  manager.on("agent:status_update", (data) =>
    broadcast({ type: "agent:status_update", data }));
  manager.on("agent:completed", (data) =>
    broadcast({ type: "agent:completed", data }));
  manager.on("agent:result_reported", (data) =>
    broadcast({ type: "agent:result_reported", data }));
}
```

### 初期状態送信

新しいクライアントが WebSocket 接続した際、現在の全状態をスナップショットとして送信する。

```typescript
function sendInitialState(ws: WebSocket, manager: AgentManager): void {
  // 1. サーバー起動通知
  ws.send(JSON.stringify({
    type: "server:startup",
    data: { startedAt: new Date().toISOString() }
  }));

  // 2. ヘルスチェック結果
  const healthResults = manager.getHealthCheckResults();
  if (healthResults.length > 0) {
    ws.send(JSON.stringify({
      type: "healthcheck:complete",
      data: { results: healthResults }
    }));
  }

  // 3. 現在の全 Agent 状態（group:created + agent:created を再送）
  // → クライアント側で状態を再構築
}
```

### クライアントイベント処理

```typescript
function handleClientEvent(
  event: ClientEvent,
  manager: AgentManager,
  config: AppConfig
): void {
  switch (event.type) {
    case "config:update_role": {
      // 1. config.roles から対象職種を検索
      // 2. フィールドを更新
      // 3. kuromajutsu.config.yaml に書き戻し
      // 4. broadcast("config:updated", updatedConfig)
      break;
    }
    case "config:revalidate_model": {
      // 1. 指定 roleId のモデルを再検証
      // 2. ヘルスチェックを再実行
      // 3. 結果をブロードキャスト
      break;
    }
  }
}
```

## クライアントサイド設計

### 技術選定

- **React 18:** SPA フレームワーク
- **バンドル:** CDN から ESM で読み込み（esbuild / Vite でのビルドは将来検討）
  - 初期実装では `<script type="module">` + importmap で CDN から React を読み込む
  - これにより、追加のビルドステップなしで React SPA を実現
- **ルーティング:** 簡易ハッシュベースルーター（`#/`, `#/roles`, `#/history`, `#/health`）
- **状態管理:** React の useReducer + Context（外部ライブラリ不使用）

### app.tsx（ルートコンポーネント）

```tsx
const App: React.FC = () => {
  const [route, setRoute] = useState(window.location.hash || "#/");
  const { state, dispatch } = useAgentStore();
  const ws = useWebSocket();

  // WebSocket イベントを state に反映
  useEffect(() => {
    ws.onMessage((event: ServerEvent) => {
      dispatch({ type: event.type, payload: event.data });
    });
  }, [ws]);

  // ハッシュベースルーティング
  const renderPage = () => {
    switch (route) {
      case "#/":        return <Dashboard state={state} />;
      case "#/roles":   return <RolesPage state={state} ws={ws} />;
      case "#/history": return <HistoryPage state={state} />;
      case "#/health":  return <HealthPage state={state} />;
      default:          return <Dashboard state={state} />;
    }
  };

  return (
    <Layout currentRoute={route} onNavigate={setRoute}>
      {renderPage()}
    </Layout>
  );
};
```

### useWebSocket フック

```typescript
interface UseWebSocketReturn {
  /** WebSocket 接続状態 */
  connected: boolean;
  /** メッセージ受信コールバックを登録 */
  onMessage: (handler: (event: ServerEvent) => void) => void;
  /** サーバーにイベントを送信 */
  send: (event: ClientEvent) => void;
}

function useWebSocket(): UseWebSocketReturn {
  // 1. WebSocket 接続を確立（ws://localhost:9696）
  // 2. 自動再接続（指数バックオフ: 1s, 2s, 4s, 8s, max 30s）
  // 3. 接続状態の管理
  // 4. メッセージの JSON パース・ディスパッチ
}
```

### useAgentStore フック（状態管理）

```typescript
interface AppState {
  /** グループ一覧: groupId → GroupDefinition */
  groups: Map<string, GroupDefinition>;
  /** Agent 一覧: agentId → AgentState */
  agents: Map<string, AgentState>;
  /** ヘルスチェック結果: roleId → HealthCheckResult */
  healthChecks: Map<string, HealthCheckResult>;
  /** アプリケーション設定 */
  config: AppConfig | null;
  /** サーバー接続状態 */
  serverStatus: "connecting" | "connected" | "disconnected";
}

type AppAction =
  | { type: "server:startup"; payload: { startedAt: string } }
  | { type: "group:created"; payload: GroupDefinition }
  | { type: "group:deleted"; payload: { groupId: string } }
  | { type: "agent:created"; payload: AgentState }
  | { type: "agent:status_update"; payload: Partial<AgentState> & { agentId: string } }
  | { type: "agent:completed"; payload: AgentState }
  | { type: "agent:result_reported"; payload: AgentResult }
  | { type: "healthcheck:complete"; payload: { results: HealthCheckResult[] } }
  | { type: "config:updated"; payload: AppConfig };

function agentReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "group:created":
      return { ...state, groups: new Map(state.groups).set(action.payload.id, action.payload) };
    case "agent:status_update": {
      const agents = new Map(state.agents);
      const current = agents.get(action.payload.agentId);
      if (current) {
        agents.set(action.payload.agentId, { ...current, ...action.payload });
      }
      return { ...state, agents };
    }
    // ... 他のアクション
  }
}
```

## コンポーネント設計

### Layout（共通レイアウト）

```
┌──────────────────────────────────────────┐
│  [Kuromajutsu]  v0.1.0                   │
│  ─────────────────────────────────────── │
│  [Dashboard] [Roles] [History] [Health]  │
├──────────────────────────────────────────┤
│                                          │
│  {children}                              │
│                                          │
└──────────────────────────────────────────┘
```

- ヘッダー: アプリ名、バージョン、接続状態インジケーター
- ナビゲーション: 4画面のタブ切り替え
- ダークテーマ: 魔術的なデザイン（紫のアクセントカラー）

### AgentCard（Agent ステータスカード）

1枚のカードが1つの Agent を表す。

```
┌─────────────────────────────────┐
│ 🔵 impl-code-1739487600-a3f2   │  ← ステータス色 + Agent ID
│ ───────────────────────────── │
│ 職種: コード実装者               │
│ モデル: claude-4-sonnet         │
│ 経過: 00:45 ▶                   │  ← ライブカウントアップ
│ ツール: 5回                      │  ← リアルタイムカウンター
│ ───────────────────────────── │
│ "ファイルを読み込んで実装を..."  │  ← 最新メッセージ（トランケート）
└─────────────────────────────────┘
```

**Props:**

```typescript
interface AgentCardProps {
  agent: AgentState;
}
```

**ステータス別の視覚効果:**

| ステータス | 色 | CSS クラス | 視覚効果 |
|---|---|---|---|
| `queued` | グレー (`#8b949e`) | `.status-queued` | 点滅アニメーション（opacity 0.5 ↔ 1.0） |
| `running` | 青 (`#58a6ff`) | `.status-running` | パルスアニメーション（box-shadow の拡縮） |
| `completed` | 緑 (`#3fb950`) | `.status-completed` | フェードインアニメーション |
| `failed` | 赤 (`#f85149`) | `.status-failed` | シェイクアニメーション → 静止 |
| `timedOut` | 黄/オレンジ (`#d29922`) | `.status-timeout` | 警告アイコン点滅 |
| `resultReported` | 濃緑 (`#238636`) | `.status-reported` | チェックマーク表示 |

### GroupSection（グループセクション）

グループ単位で Agent カードをまとめるアコーディオン。

```
┌──────────────────────────────────────────────┐
│ ▼ grp-1739487600-b4e1                        │
│   認証機能の実装・テスト・レビュー              │
│   Agent: 3/3 完了  [██████████] 100%         │
├──────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ Agent 1  │ │ Agent 2  │ │ Agent 3  │     │
│  │ ✅ 完了  │ │ ✅ 完了  │ │ ✅ 完了  │     │
│  └──────────┘ └──────────┘ └──────────┘     │
└──────────────────────────────────────────────┘
```

**Props:**

```typescript
interface GroupSectionProps {
  group: GroupDefinition;
  agents: AgentState[];
  defaultExpanded?: boolean;  // running Agent がある場合は展開
}
```

### RoleEditor（職種設定エディタ）

職種の設定をインライン編集するカード型コンポーネント。

```
┌──────────────────────────────────────────┐
│ impl-code — コード実装者  [✅ 利用可能]   │
├──────────────────────────────────────────┤
│ モデル: [claude-4-sonnet      ▼]         │  ← ドロップダウン
│ システムプロンプト:                        │
│ ┌──────────────────────────────────┐     │
│ │ あなたはコード実装の専門家です。   │     │  ← テキストエリア
│ │ ...                              │     │
│ └──────────────────────────────────┘     │
│ ヘルスチェックプロンプト:                  │
│ [Hello, respond with exactly: OK     ]    │
│                                          │
│ [保存] [モデル再検証]                      │
└──────────────────────────────────────────┘
```

**Props:**

```typescript
interface RoleEditorProps {
  role: RoleDefinition;
  healthCheck: HealthCheckResult | null;
  availableModels: string[];
  onSave: (updated: Partial<RoleDefinition>) => void;
  onRevalidate: () => void;
}
```

### HistoryTable（実行履歴テーブル）

完了した Agent の結果を表形式で表示。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ フィルタ: [グループ ▼] [ステータス ▼] [職種 ▼]                            │
├──────┬────────────┬──────────┬────────┬──────────┬───────┬──────────────┤
│ ID   │ グループ    │ 職種     │ 状態   │ サマリ    │ 時間  │ 日時         │
├──────┼────────────┼──────────┼────────┼──────────┼───────┼──────────────┤
│ ...  │ 認証機能... │ impl-code│ ✅成功 │ 実装完了 │ 45.0s │ 2026-02-14.. │
│ ...  │ 認証機能... │ impl-test│ ✅成功 │ テスト.. │ 32.1s │ 2026-02-14.. │
└──────┴────────────┴──────────┴────────┴──────────┴───────┴──────────────┘
```

**Props:**

```typescript
interface HistoryTableProps {
  agents: AgentState[];  // resultReported / completed / failed の Agent
  groups: Map<string, GroupDefinition>;
}
```

### HealthStatus（ヘルスチェック状況）

起動時ヘルスチェックの進行状況をステップ形式で表示。

```
[1/3] モデル検証
  ├─ impl-code (claude-4-sonnet)    ✅ 有効
  ├─ code-review (claude-4-sonnet)  ✅ 有効
  ├─ text-review (claude-4-sonnet)  ✅ 有効
  └─ impl-test (claude-4-sonnet)    ✅ 有効

[2/3] ヘルスチェック実行
  ├─ impl-code     🔄 チェック中... (1.2s)
  ├─ code-review   ✅ OK (0.8s)
  ├─ text-review   ⏳ 待機中
  └─ impl-test     ⏳ 待機中

[3/3] 完了サマリ
  全 4 職種中 4 職種が利用可能です
```

**Props:**

```typescript
interface HealthStatusProps {
  results: HealthCheckResult[];
  phase: "model_validation" | "health_check" | "complete";
}
```

## ステータス色分け CSS

```css
/* ステータスアニメーション */
.status-queued {
  border-left: 4px solid #8b949e;
  animation: blink 1.5s ease-in-out infinite;
}

.status-running {
  border-left: 4px solid #58a6ff;
  animation: pulse 2s ease-in-out infinite;
}

.status-completed {
  border-left: 4px solid #3fb950;
  animation: fadeIn 0.5s ease-in;
}

.status-failed {
  border-left: 4px solid #f85149;
  animation: shake 0.5s ease-in-out;
}

.status-timeout {
  border-left: 4px solid #d29922;
}
.status-timeout .warning-icon {
  animation: blink 1s ease-in-out infinite;
}

.status-reported {
  border-left: 4px solid #238636;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
  50% { box-shadow: 0 0 0 8px rgba(88, 166, 255, 0); }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
```

## ダークテーマ（魔術的デザイン）

```css
:root {
  /* 背景 */
  --bg-primary: #0d1117;       /* 最深背景 */
  --bg-secondary: #161b22;     /* セカンダリ背景 */
  --bg-card: #1c2128;          /* カード背景 */

  /* テキスト */
  --text-primary: #e6edf3;     /* メインテキスト */
  --text-secondary: #8b949e;   /* サブテキスト */

  /* アクセントカラー（魔術的な紫〜青のグラデーション） */
  --accent-purple: #a371f7;    /* メインアクセント */
  --accent-blue: #58a6ff;      /* セカンダリアクセント */
  --accent-green: #3fb950;     /* 成功 */
  --accent-red: #f85149;       /* エラー */
  --accent-yellow: #d29922;    /* 警告 */

  /* ボーダー */
  --border: #30363d;

  /* グラデーション */
  --gradient-header: linear-gradient(135deg, var(--accent-purple), var(--accent-blue));
}
```

## WebSocket イベント

### サーバー → クライアント

| イベント | 説明 | タイミング | ペイロード |
|---------|------|----------|----------|
| `server:startup` | サーバー起動通知 | MCPサーバー起動時 | `{ startedAt }` |
| `healthcheck:model_validation` | モデル検証結果 | モデル検証完了時 | `{ results: HealthCheckResult[] }` |
| `healthcheck:role_start` | 職種チェック開始 | 各職種のチェック開始時 | `{ roleId }` |
| `healthcheck:role_complete` | 職種チェック完了 | 各職種のチェック完了時 | `HealthCheckResult` |
| `healthcheck:complete` | 全体チェック完了 | 全チェック完了時 | `{ results: HealthCheckResult[] }` |
| `group:created` | グループ作成通知 | `create_group` 呼び出し時 | `GroupDefinition` |
| `group:deleted` | グループ削除通知 | `delete_group` 呼び出し時 | `{ groupId }` |
| `agent:created` | Agent 作成通知 | `run_agents` / `run_sequential` 呼び出し時 | `AgentState` |
| `agent:status_update` | Agent 状態更新 | stream-json イベント受信時 | `Partial<AgentState> & { agentId }` |
| `agent:completed` | Agent 完了通知 | Agent プロセス終了時 | `AgentState` |
| `agent:result_reported` | 結果登録通知 | `report_result` 呼び出し時 | `AgentResult` |
| `config:updated` | 設定変更通知 | UI から設定変更時 | `AppConfig` |

### クライアント → サーバー

| イベント | 説明 | ペイロード |
|---------|------|----------|
| `config:update_role` | 職種設定の変更 | `Partial<RoleDefinition> & { id }` |
| `config:revalidate_model` | モデル再検証 | `{ roleId }` |

## REST API（将来拡張用）

Step 1 で `/api/` エンドポイントの骨組みを実装済み。将来的に以下を追加する可能性がある:

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/status` | サーバー状態取得 |
| GET | `/api/agents` | Agent 一覧取得 |
| GET | `/api/groups` | Group 一覧取得 |
| GET | `/api/health` | ヘルスチェック結果取得 |

※ 現時点ではリアルタイム性が重要なため WebSocket を主通信手段とする。

## テスト方針

### サーバーサイド（`tests/dashboard/`）

- **HTTP サーバーテスト (`server.test.ts`):**
  - 静的ファイル配信（index.html, CSS, JS）
  - SPA フォールバック（存在しないパスで index.html が返ること）
  - MIME タイプの正確性
  - `/api/` エンドポイントのレスポンス

- **WebSocket テスト (`websocket.test.ts`):**
  - 接続・切断の管理
  - ブロードキャスト: AgentManager イベント → 全クライアントへの中継
  - 初期状態送信: 接続時に現在の状態スナップショットが送信されること
  - クライアントイベント処理: `config:update_role`, `config:revalidate_model`

### クライアントサイド（オプション）

- React コンポーネントのレンダリングテスト（将来的に Jest + Testing Library で追加）
- 初期実装ではブラウザでの手動動作確認を優先

### テストファイル構成

```
tests/dashboard/
├── server.test.ts     # HTTP サーバーのユニットテスト
└── websocket.test.ts  # WebSocket の送受信テスト
```

## 実装順序

| 順序 | 機能 | 説明 | 完了条件 |
|------|------|------|---------|
| 1 | HTTP サーバー | Express ベースではなく Node.js http（Step 1 で完了済み） | 静的ファイル配信テスト通過 |
| 2 | WebSocket サーバー | `ws` パッケージで接続管理・ブロードキャスト | 送受信テスト通過 |
| 3 | AgentManager イベント中継 | manager のイベントを WebSocket にブリッジ | ブロードキャストテスト通過 |
| 4 | React SPA 骨組み | index.html に React CDN + ルーティング | ブラウザで表示確認 |
| 5 | ダッシュボード画面 | GroupSection + AgentCard コンポーネント | Agent カードが表示される |
| 6 | ヘルスチェック画面 | HealthStatus コンポーネント | チェック状況がリアルタイム表示 |
| 7 | 職種管理画面 | RoleEditor コンポーネント + 設定保存 | 設定変更が YAML に反映 |
| 8 | 実行履歴画面 | HistoryTable コンポーネント + フィルタリング | フィルタ付き一覧表示 |
| 9 | アニメーション | ステータス色分け・パルス・シェイク等 | 全ステータスの視覚効果 |
| 10 | WebSocket 再接続 | 指数バックオフによる自動再接続 | 切断→再接続のテスト |

**各機能の完了条件:**
- [ ] テストが通る
- [ ] ブラウザで表示・動作確認 OK
- [ ] コミット完了
