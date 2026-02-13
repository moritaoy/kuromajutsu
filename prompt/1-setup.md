# 1. プロジェクト準備

**あなたの役割:**
あなたは経験豊富なエンジニアです。
プロジェクトの初期セットアップを行い、開発の土台を整える任務を担っています。

---

## 固定要素

| 項目 | 値 |
|------|-----|
| 仕様書 | `docs/spec.md`【SSOT】 |
| 用語集 | `docs/glossary.md`【各ステップで更新】 |
| 起動方法 | `npm run dev` |
| 開発方針 | TDD |
| 実行環境 | Node.js（ローカル） |
| 言語 | **TypeScript** |
| パッケージマネージャ | npm |

**⚠️ 重要:**
- MCPサーバーは stdio トランスポートで Cursor と通信します
- ダッシュボード UI は MCPサーバーが内蔵 HTTP サーバー（ポート `9696`）で配信します
- Agent の実行には Cursor CLI のヘッドレスモード（`agent -p --force`）を使用します

---

## サーバー構成

| コンポーネント | トランスポート/ポート | 実装場所 |
|---------|-------|---------|
| MCPサーバー | stdio | `src/mcp/` |
| ダッシュボードUI | HTTP :9696 + WebSocket | `src/dashboard/` |
| Agent実行エンジン | 子プロセス（Cursor CLI） | `src/agent/` |

---

## プロセス

### Step 1: 仕様確認

`docs/spec.md` を読んで以下を把握してください：

- システム全体のアーキテクチャ
- MCPサーバーが提供する8つのツール定義（`create_group`, `delete_group`, `run_agent`, `list_agents`, `get_agent_status`, `wait_agent`, `report_result`, `list_roles`）
- グループ（Group）の構造と管理方法
- Agent 職種（Role）の構造と初期4職種
- Agent 実行ライフサイクルと stream-json パース仕様
- 結果データ構造（`AgentResult`）
- ヘルスチェック・モデル検証の仕組み
- ダッシュボード UI の画面構成と WebSocket イベント
- 設定ファイル（`kuromajutsu.config.yaml`）のスキーマ

### Step 2: プロジェクト構造を整える

以下の構造でフォルダを整備してください：

```
project-root/
├── package.json          # 【作成】依存関係・スクリプト定義
├── tsconfig.json         # 【作成】TypeScript設定
├── kuromajutsu.config.yaml # 【作成】設定ファイル（デフォルト値）
├── docs/
│   ├── spec.md           # 【既存】仕様書 ※編集不可
│   └── glossary.md       # 【作成】用語集（各ステップで更新）
├── prompt/               # 【既存】プロンプト集 ※編集不可
├── src/
│   ├── index.ts          # 【作成】エントリーポイント（MCPサーバー起動）
│   ├── mcp/              # MCPサーバー実装
│   │   ├── server.ts     # 【作成】MCPサーバー本体
│   │   └── tools/        # 【作成】各ツールの定義・ハンドラ
│   │       ├── create-group.ts
│   │       ├── delete-group.ts
│   │       ├── run-agent.ts
│   │       ├── list-agents.ts
│   │       ├── get-agent-status.ts
│   │       ├── wait-agent.ts
│   │       ├── report-result.ts
│   │       └── list-roles.ts
│   ├── agent/            # Agent 実行エンジン
│   │   ├── executor.ts   # 【作成】Cursor CLI 実行・プロセス管理
│   │   ├── parser.ts     # 【作成】stream-json パーサー
│   │   └── manager.ts    # 【作成】Agent ライフサイクル管理
│   ├── health/           # ヘルスチェック・モデル検証
│   │   └── checker.ts    # 【作成】起動時チェック処理
│   ├── config/           # 設定管理
│   │   └── loader.ts     # 【作成】YAML設定読み込み
│   ├── dashboard/        # ダッシュボード UI
│   │   ├── server.ts     # 【作成】HTTPサーバー + WebSocket
│   │   └── public/       # 【作成】フロントエンド（React SPA）
│   └── types/            # 型定義
│       └── index.ts      # 【作成】共通型定義
├── tests/                # テストコード
│   ├── mcp/
│   ├── agent/
│   └── health/
└── AGENTS.md             # 【作成】プロジェクト概要（AI向け）
```

**⚠️ 既存ファイルに注意:**
- `docs/spec.md` は既に存在します。編集しないでください
- `prompt/` ディレクトリは既に存在します。編集しないでください

### Step 3: 用語集を作成

`docs/glossary.md` を作成してください。

`docs/spec.md` の「付録 A. 用語集」に定義されている初期用語をベースに作成します。
仕様書を読み進める中で理解した用語や、プロジェクト固有の概念を追加してください。

**⚠️ 重要:** 用語集は以降のステップ（設計・実装）でも継続的に参照・更新します。新しい概念やパターン名が出てきたら、その都度追記してください。

### Step 4: AGENTS.md を作成

プロジェクトルートに `AGENTS.md` を作成してください。

### Step 5: 動作確認（MCPサーバー起動 / ダッシュボード表示）

環境が正しくセットアップされたことを確認するため、最小限の動作確認を行います。

**1. MCPサーバー: 起動確認**

MCP サーバーが stdio で起動し、ツール一覧を返せることを確認：

```bash
# ビルド確認
npm run build

# MCP Inspector で確認（オプション）
npx @modelcontextprotocol/inspector node dist/index.js
```

**2. ダッシュボード: 表示確認**

```bash
npm run dev
```

ブラウザで `http://localhost:9696` にアクセスし、ダッシュボードの骨組みが表示されることを確認。

**3. 確認完了後**

MCPサーバーの起動とダッシュボードの表示が確認できたら、本実装でさらに機能を追加していきます。

---

## テスト方法

```bash
# 全テスト実行
npm test

# 特定テスト実行
npm test -- --grep "MCPServer"

# ウォッチモード
npm run test:watch
```

---

## 成果物

### 1. `src/` 配下

- `index.ts`（エントリーポイント）
- `mcp/server.ts`（MCPサーバー骨組み）
- `dashboard/server.ts`（HTTPサーバー骨組み）
- `config/loader.ts`（設定読み込み）
- `types/index.ts`（型定義）

### 2. プロジェクト設定

- `package.json`（依存関係・スクリプト定義）
- `tsconfig.json`（TypeScript設定）
- `kuromajutsu.config.yaml`（デフォルト設定）

### 3. `docs/glossary.md`

`docs/spec.md` の「付録 A. 用語集」をベースに作成。セットアップ段階で理解した用語を網羅する。

### 4. `AGENTS.md`

以下のテンプレートを参考に作成：

```markdown
# プロジェクト: kuromajutsu

## 概要
Cursor Agent 並列実行管理システム。MCPサーバーとしてCursorと連携し、複数のサブAgentを並列に起動・管理する。

## 仕様書【重要】
- `docs/spec.md` : システム仕様書（SSOT）
- `docs/glossary.md` : 用語集（各ステップで更新）

## プロジェクト構造

```
project-root/
├── package.json
├── tsconfig.json
├── kuromajutsu.config.yaml   # 設定ファイル
├── docs/
│   └── spec.md               # 仕様書
├── src/
│   ├── index.ts              # エントリーポイント
│   ├── mcp/                  # MCPサーバー
│   ├── agent/                # Agent実行エンジン
│   ├── health/               # ヘルスチェック
│   ├── config/               # 設定管理
│   ├── dashboard/            # ダッシュボードUI
│   └── types/                # 型定義
└── tests/                    # テスト
```

## 技術スタック

| 項目 | 値 |
|------|-----|
| 言語 | TypeScript |
| ランタイム | Node.js |
| MCPサーバー | @modelcontextprotocol/sdk (stdio) |
| ダッシュボード | React SPA (HTTP :9696) |
| リアルタイム通信 | WebSocket |
| 設定 | YAML (kuromajutsu.config.yaml) |

## コンポーネント構成

| コンポーネント | 説明 |
|---------|------|
| MCPサーバー | Cursorと stdio で通信、8つのツールを提供 |
| Agent実行エンジン | Cursor CLI ヘッドレスモードで子プロセスを管理 |
| ダッシュボードUI | ブラウザで Agent 状況をリアルタイム監視 |
| ヘルスチェック | 起動時にモデル検証・職種動作確認を自動実行 |

## テスト

| 項目 | コマンド |
|------|---------|
| 全テスト | `npm test` |
| ウォッチ | `npm run test:watch` |

## 開発ルール

1. **TDD**: テストを先に書く
2. **仕様書優先**: 実装前に `docs/spec.md` を必ず確認
3. **型安全**: TypeScript の strict モードを使用

## 起動方法

```bash
# 開発モード
npm run dev

# ビルド
npm run build

# ダッシュボード確認
# ブラウザで http://localhost:9696 を開く
```
```

---

## 次のアクション

→ `2-design.md` へ進んで設計を整理
