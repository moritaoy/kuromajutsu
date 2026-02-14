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
├── Dockerfile                   # Docker コンテナ定義
├── docker-compose.yml           # Docker Compose 設定
├── kuromajutsu.config.yaml      # 設定ファイル
├── docs/
│   ├── spec.md                  # 仕様書（SSOT）
│   └── glossary.md              # 用語集
├── prompt/                      # プロンプト集（編集不可）
├── src/
│   ├── index.ts                 # エントリーポイント
│   ├── mcp/                     # MCPサーバー
│   │   ├── server.ts            # サーバー本体
│   │   └── tools/               # 8つのMCPツール
│   ├── agent/                   # Agent実行エンジン
│   │   ├── executor.ts          # Cursor CLI 実行
│   │   ├── parser.ts            # stream-json パーサー
│   │   └── manager.ts           # ライフサイクル管理
│   ├── health/                  # ヘルスチェック
│   │   └── checker.ts           # 起動時チェック
│   ├── config/                  # 設定管理
│   │   └── loader.ts            # YAML読み込み
│   ├── dashboard/               # ダッシュボードUI
│   │   ├── server.ts            # HTTPサーバー + WebSocket
│   │   └── public/              # フロントエンド（React SPA）
│   └── types/                   # 型定義
│       └── index.ts             # 共通型定義
└── tests/                       # テスト
    ├── mcp/
    ├── agent/
    ├── health/
    └── config/
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
| コンテナ | Docker / Docker Compose |

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
| 全テスト | `docker compose run --rm app npm test` |
| ウォッチ | `docker compose run --rm app npm run test:watch` |

## 開発ルール

1. **TDD**: テストを先に書く
2. **仕様書優先**: 実装前に `docs/spec.md` を必ず確認
3. **型安全**: TypeScript の strict モードを使用
4. **ハイブリッド実行**: テスト・ビルドは Docker、開発実行はホスト

### 実行環境の使い分け

| 用途 | 実行環境 | 理由 |
|------|---------|------|
| テスト (`npm test`) | Docker | CLI はモック済み。隔離環境で実行 |
| ビルド (`npm run build`) | Docker | TypeScript コンパイルに CLI 不要 |
| 開発実行 (`npm run dev`) | **ホスト** | Cursor CLI (`agent`) が必要 |
| ダッシュボード確認のみ | Docker (`docker compose up`) | CLI 不要の UI 確認用 |

### ⚠️ テスト・ビルドは Docker で実行

```bash
# ✅ テスト・ビルド（Docker）
docker compose run --rm app npm test
docker compose run --rm app npm run build
docker compose run --rm app npx tsc --noEmit

# ❌ テスト・ビルドのローカル直接実行は禁止
npm test            # Docker 経由で実行すること
npm run build       # Docker 経由で実行すること
```

### ⚠️ 開発実行はホストで実行

Cursor CLI（`agent` コマンド）はホスト側にしか存在しないため、
ヘルスチェック・Agent 実行・モデル一覧取得を動かすにはホスト上で直接実行する。

```bash
# セットアップ（初回のみ）
npm install

# ✅ 開発実行（ホスト）
npm run dev

# ダッシュボード確認のみ（Docker — CLI 機能なし）
docker compose up

# ダッシュボード → http://localhost:9696
```
