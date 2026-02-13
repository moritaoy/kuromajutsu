# 3. TDD実装

**あなたの役割:**
あなたは経験豊富なエンジニアです。
TDD に従って、TypeScript で機能ごとに段階的に MCPサーバー、Agent 実行エンジン、ダッシュボード UI を実装する任務を担っています。

---

## 前提条件

- `1-setup.md` でプロジェクト構造が整っていること
- `AGENTS.md` が作成済みであること
- `docs/glossary.md` が作成済みであること
- `2-design.md` で設計が完了していること
- `src/mcp/design.md` が作成済みであること
- `src/agent/design.md` が作成済みであること
- `src/dashboard/design.md` が作成済みであること
- MCPサーバー起動とダッシュボード表示の動作確認が完了していること

---

## 入力ドキュメント

| ファイル | 用途 |
|---------|------|
| `docs/spec.md` | システム仕様書（SSOT） |
| `docs/glossary.md` | 用語集（参照・更新する） |
| `src/mcp/design.md` | MCPサーバー設計ドキュメント（実装順序を確認） |
| `src/agent/design.md` | Agent 実行エンジン設計ドキュメント（実装順序を確認） |
| `src/dashboard/design.md` | ダッシュボード UI 設計ドキュメント（実装順序を確認） |
| `kuromajutsu.config.yaml` | 設定ファイル |

---

## 実装フロー（機能ごとに繰り返す）

各 `design.md` の「実装順序」に従って、**機能ごと**に以下のサイクルを回します。

```
┌─────────────────────────────────────────────────┐
│  機能 N の実装                                    │
│                                                 │
│  1. テスト作成（Red）                             │
│       ↓                                         │
│  2. 実装（Green）                                │
│       ↓                                         │
│  3. テスト実行                                   │
│       ↓                                         │
│  4. 動作確認（MCP Inspector / ブラウザ）          │
│       ↓                                         │
│  5. コミット                                     │
│                                                 │
└─────────────────────────────────────────────────┘
         ↓ 次の機能へ
```

---

## Phase 1: Agent 実行エンジン実装

`src/agent/design.md` の実装順序に従います。

### 【Agent 機能 1】StreamParser — NDJSON パーサー

#### Step 1: テスト作成（Red）

`src/agent/design.md` の設計に基づいてテストを追加。

```typescript
// tests/agent/parser.test.ts
import { StreamParser } from '../../src/agent/parser';

describe('StreamParser', () => {
  it('should parse system init event', () => {
    const parser = new StreamParser();
    const events: any[] = [];
    parser.on('system', (event) => events.push(event));

    parser.feed('{"type":"system","subtype":"init","model":"claude-4-sonnet","session_id":"abc"}\n');

    expect(events).toHaveLength(1);
    expect(events[0].model).toBe('claude-4-sonnet');
  });

  it('should parse tool_call started event', () => {
    // ...
  });

  it('should parse result event', () => {
    // ...
  });
});
```

#### Step 2: 実装（Green）

テストを通す最小限のコードを実装。

#### Step 3: テスト実行

```bash
npm test -- --grep "StreamParser"
```

**確認:** すべてのテストが通ること（Green）

#### Step 4: コミット

```bash
git add .
git commit -m "feat(agent): StreamParser を実装"
```

#### ✅ 完了チェックリスト

- [ ] テストが通る
- [ ] 全イベントタイプのパースが正常動作
- [ ] コミット完了

---

### 【Agent 機能 2】AgentExecutor — Cursor CLI 実行

#### Step 1: テスト作成（Red）

```typescript
// tests/agent/executor.test.ts
import { AgentExecutor } from '../../src/agent/executor';

describe('AgentExecutor', () => {
  it('should build correct CLI command', () => {
    const executor = new AgentExecutor();
    const cmd = executor.buildCommand({
      model: 'claude-4-sonnet',
      prompt: 'Hello world',
    });

    expect(cmd.command).toBe('agent');
    expect(cmd.args).toContain('-p');
    expect(cmd.args).toContain('--force');
    expect(cmd.args).toContain('-m');
    expect(cmd.args).toContain('claude-4-sonnet');
  });

  it('should handle process exit with code 0', () => {
    // ...
  });

  it('should handle timeout', () => {
    // ...
  });
});
```

#### Step 2〜5: 実装 → テスト → 動作確認 → コミット

```bash
npm test -- --grep "AgentExecutor"
git add . && git commit -m "feat(agent): AgentExecutor を実装"
```

#### ✅ 完了チェックリスト

- [ ] テストが通る
- [ ] CLI コマンド構築が正しい
- [ ] プロセス管理（起動・終了・タイムアウト）が正常動作
- [ ] コミット完了

---

### 【Agent 機能 3〜5】AgentManager / 結果マージ / タイムアウト

同様のサイクルで実装を進めます。`src/agent/design.md` の実装順序に従ってください。

---

## Phase 2: MCPサーバー実装

`src/mcp/design.md` の実装順序に従います。

### 【MCP 機能 1】MCPサーバー骨組み

#### Step 1: テスト作成（Red）

```typescript
// tests/mcp/server.test.ts
import { createServer } from '../../src/mcp/server';

describe('MCPServer', () => {
  it('should initialize with all tools registered', async () => {
    const server = createServer();
    // ツール一覧に8つのツールが登録されていることを検証
  });
});
```

#### Step 2: 実装（Green）

`@modelcontextprotocol/sdk` を使って MCPサーバーを初期化し、8つのツールを登録。

#### Step 3: テスト実行

```bash
npm test -- --grep "MCPServer"
```

#### Step 4: 動作確認

```bash
# MCP Inspector で確認
npx @modelcontextprotocol/inspector node dist/index.js
```

**確認:** ツール一覧が正しく表示されること

#### Step 5: コミット

```bash
git add .
git commit -m "feat(mcp): MCPサーバー骨組みを実装"
```

#### ✅ 完了チェックリスト

- [ ] テストが通る
- [ ] MCP Inspector でツール一覧が表示される
- [ ] コミット完了

---

### 【MCP 機能 2】list_roles ツール

#### Step 1: テスト作成（Red）

```typescript
// tests/mcp/tools/list-roles.test.ts
describe('list_roles', () => {
  it('should return all configured roles', async () => {
    // 設定から4職種が返されることを検証
  });

  it('should include health check status', async () => {
    // ヘルスチェック結果が含まれることを検証
  });
});
```

#### Step 2〜5: 実装 → テスト → 動作確認 → コミット

```bash
npm test -- --grep "list_roles"
git add . && git commit -m "feat(mcp): list_roles ツールを実装"
```

---

### 【MCP 機能 3〜4】create_group / delete_group（グループ管理ツール）

同様のサイクルで実装を進めます。`src/mcp/design.md` の実装順序に従ってください。

グループ管理はAgent実行の前提条件となるため、`run_agent` より先に実装します。

---

### 【MCP 機能 5〜9】run_agent / list_agents / get_agent_status / wait_agent / report_result

同様のサイクルで実装を進めます。`src/mcp/design.md` の実装順序に従ってください。

**注意:** `run_agent` は `groupId` パラメータが必須です。グループの存在・アクティブチェックを実装に含めてください。

---

## Phase 3: ヘルスチェック実装

### 【ヘルスチェック】起動時自動検証

#### Step 1: テスト作成（Red）

```typescript
// tests/health/checker.test.ts
import { HealthChecker } from '../../src/health/checker';

describe('HealthChecker', () => {
  it('should validate available models', async () => {
    // agent models コマンドの結果と設定を照合
  });

  it('should mark role as unavailable when model is invalid', async () => {
    // 無効なモデルの職種が利用不可になることを検証
  });

  it('should run health check prompt for valid roles', async () => {
    // ヘルスチェックプロンプトの実行を検証
  });
});
```

#### Step 2〜5: 実装 → テスト → 動作確認 → コミット

```bash
npm test -- --grep "HealthChecker"
git add . && git commit -m "feat(health): 起動時ヘルスチェックを実装"
```

#### ✅ 完了チェックリスト

- [ ] テストが通る
- [ ] モデル検証が正しく動作
- [ ] ヘルスチェックプロンプトが実行される
- [ ] 結果がコンソールとUIに反映される
- [ ] コミット完了

---

## Phase 4: ダッシュボード UI 実装

`src/dashboard/design.md` の実装順序に従います。

### 【UI 機能 1】HTTPサーバー + 静的ファイル配信

#### Step 1: テスト作成（Red）

```typescript
// tests/dashboard/server.test.ts
import request from 'supertest';
import { createDashboardServer } from '../../src/dashboard/server';

describe('DashboardServer', () => {
  it('should serve index.html at /', async () => {
    const app = createDashboardServer();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
```

#### Step 2: 実装（Green）

Express で HTTP サーバーを構築し、React SPA の静的ファイルを配信。

#### Step 3: 動作確認

```bash
npm run dev
# ブラウザで http://localhost:9696 を確認
```

#### Step 4: コミット

```bash
git add .
git commit -m "feat(dashboard): HTTPサーバーを実装"
```

---

### 【UI 機能 2】WebSocket 接続管理

#### Step 1: テスト作成（Red）

```typescript
// tests/dashboard/websocket.test.ts
describe('WebSocket', () => {
  it('should accept client connections', () => {
    // WebSocket 接続が確立できることを検証
  });

  it('should broadcast agent:created event to all clients', () => {
    // イベントが全クライアントに配信されることを検証
  });
});
```

#### Step 2〜5: 実装 → テスト → 動作確認 → コミット

---

### 【UI 機能 3〜7】各画面の実装

同様のサイクルで実装を進めます。`src/dashboard/design.md` の実装順序に従ってください。

- ダッシュボード画面（Agent カード表示）
- ヘルスチェック画面（起動時チェック状況表示）
- 職種管理画面（設定編集 UI）
- 実行履歴画面（結果一覧表示）
- アニメーション（ステータス色分け・視覚効果）

---

## 用語集の更新

各 Phase の実装が完了するごとに `docs/glossary.md` を確認・更新してください。

追加が想定される用語の例：
- 実装で導入した具体的なクラス名・関数名・定数名
- エラーハンドリングのパターン名
- テストで使用するモック・フィクスチャの名称
- 設定値のキー名とその意味

**⚠️ タイミング:** 各 Phase の最後（コミット前）に用語集を見直し、新しい用語があれば追記してください。

---

## 最終確認

すべての機能の実装が完了したら、全体の動作確認を実施：

### テスト実行

```bash
# 全テスト
npm test

# カバレッジ確認
npm run test:coverage
```

### E2E 動作確認

```bash
# MCPサーバー + ダッシュボード起動
npm run dev
```

### チェック項目

| チェック項目 | 確認方法 |
|------------|---------|
| MCPサーバーが起動する | MCP Inspector でツール一覧確認 |
| 全8ツールが動作する | MCP Inspector で各ツールを呼び出し |
| グループの作成・削除ができる | `create_group` → `delete_group` フロー確認 |
| ダッシュボードが表示される | ブラウザで `http://localhost:9696` |
| ヘルスチェックが自動実行される | 起動時のコンソール出力確認 |
| ヘルスチェック状況がUIに表示される | ダッシュボードのヘルスチェック画面確認 |
| Agent が起動・完了する | `create_group` → `run_agent` → `wait_agent` フロー確認 |
| Agent がグループ単位で表示される | ダッシュボードでグループ別に Agent が整理されているか |
| 結果が登録される | `report_result` → 実行履歴画面確認 |
| 職種の設定が変更できる | 職種管理画面で編集 → YAML反映確認 |
| WebSocket で リアルタイム更新 | Agent 実行中にダッシュボードが更新されるか |
| ステータス色分け・アニメーション | 各ステータスで適切な色・効果が表示されるか |
| 用語集が最新である | `docs/glossary.md` に実装で追加した用語が反映されているか |

---

## トラブルシューティング

### テストが失敗する場合
```bash
# 詳細出力でテスト実行
npm test -- --verbose

# 特定テストのみ実行
npm test -- --grep "StreamParser"
```

### ビルドが失敗する場合
```bash
# TypeScript コンパイルエラーの確認
npx tsc --noEmit

# 依存関係の問題
rm -rf node_modules && npm install
```

### MCPサーバーが起動しない場合
```bash
# MCP Inspector で確認
npx @modelcontextprotocol/inspector node dist/index.js

# ログレベルを上げて確認
KUROMAJUTSU_LOG_LEVEL=debug npm run dev
```

### ダッシュボードが表示されない場合
```bash
# ポートが使用中でないか確認
lsof -i :9696

# サーバーログ確認
npm run dev
# コンソール出力を確認
```

### Cursor CLI が動作しない場合
```bash
# CLI のインストール確認
which agent

# 認証確認
agent status

# モデル一覧確認
agent models
```

### WebSocket が接続できない場合
```bash
# ブラウザの開発者ツール > Network > WS タブで確認
# ws://localhost:9696 への接続を確認
```

---

## 実装の優先順位

全体を通した推奨実装順序：

| 優先度 | Phase | 機能 | 理由 |
|--------|-------|------|------|
| 1 | Phase 1 | StreamParser | Agent 実行の基盤 |
| 2 | Phase 1 | AgentExecutor | CLI 起動の基盤 |
| 3 | Phase 1 | AgentManager | 状態管理の基盤 |
| 4 | Phase 2 | MCPサーバー骨組み | ツール提供の基盤 |
| 5 | Phase 2 | list_roles | 最もシンプルなツール |
| 6 | Phase 2 | create_group / delete_group | Agent 実行の前提条件 |
| 7 | Phase 2 | run_agent | コア機能（groupId 必須） |
| 8 | Phase 2 | list_agents / get_agent_status | 状況確認（groupId フィルタ対応） |
| 9 | Phase 2 | wait_agent | 完了待機 |
| 10 | Phase 2 | report_result | 結果登録 |
| 11 | Phase 3 | ヘルスチェック | 起動時検証 |
| 12 | Phase 4 | HTTPサーバー + WebSocket | UI 基盤 |
| 13 | Phase 4 | 各画面実装（グループ表示含む） | ビジュアル |
| 14 | Phase 4 | アニメーション | 仕上げ |
