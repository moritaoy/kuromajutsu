# Kuromajutsu

Cursor Agent 並列実行管理システム。MCP サーバーとして Cursor と連携し、複数のサブ Agent を並列に起動・管理する。

## 前提条件

- Node.js >= 20
- Docker / Docker Compose（テスト・ビルド用）
- Cursor IDE（Agent 実行に必要）

## セットアップ

```bash
# ホスト側に依存関係をインストール（開発実行用）
npm install
```

### 文章レビュー用ツール（オプション）

文章レビュワー（`text-review`）職種で textlint を利用する場合は、追加パッケージのインストールが必要です。

```bash
npm install --save-dev textlint textlint-rule-preset-japanese textlint-rule-preset-jtf-style
```

インストール後、起動時のヘルスチェックで textlint の利用可否が自動検証されます。
textlint がインストールされていない場合、`text-review` 職種はヘルスチェック未通過となり利用できません。

textlint のルール設定はプロジェクトルートの `.textlintrc.json` で管理しています。

## 実行方法

### 開発モード（ホスト上で実行）

Cursor CLI（`agent` コマンド）を使うため、ホスト上で直接実行する。
ヘルスチェック・Agent 実行・モデル一覧取得がすべて動作する。

```bash
npm run dev

# ダッシュボード → http://localhost:9696
```

### ダッシュボード確認のみ（Docker）

Cursor CLI が不要な UI 確認用途。ヘルスチェックやAgent 実行は動作しない。

```bash
docker compose up

# ダッシュボード → http://localhost:9696
```

### テスト・ビルド（Docker）

CLI はテスト内でモック済み。Docker コンテナ内で実行する。

```bash
# テスト
docker compose run --rm app npm test

# ビルド
docker compose run --rm app npm run build

# 型チェック
docker compose run --rm app npx tsc --noEmit
```

## Cursor MCP 設定

まず、サーバーを起動します:

```bash
npm run dev
```

次に、`.cursor/mcp.json` に以下を追加:

```json
{
  "mcpServers": {
    "kuromajutsu": {
      "url": "http://localhost:9696/mcp"
    }
  }
}
```

**注意**: サーバーが起動している必要があります。サーバーを停止すると MCP 接続も切断されます。

## 使い方

Cursor Agent から MCP ツール経由で操作する。

```
1. list_roles          → 利用可能な職種・モデルを確認
2. create_group        → グループを作成（description を指定）
3. run_agent           → Agent を起動（groupId, role, prompt を指定）
4. wait_agent          → 完了を待機（agentIds を指定）
5. get_agent_status    → 詳細状況を確認
6. report_result       → 結果を登録（Agent 自身が呼び出す）
7. delete_group        → グループを削除
```

## 技術スタック

- TypeScript / Node.js
- MCP SDK (`@modelcontextprotocol/sdk`, HTTP トランスポート)
- WebSocket (`ws`)
- React SPA (CDN, ビルドステップなし)
- Docker / Docker Compose（テスト・ビルド用）
