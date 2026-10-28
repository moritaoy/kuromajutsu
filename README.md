# Kuromajutsu

Cursor / Claude マルチ Provider Agent 並列実行管理システム。MCP サーバーとして Cursor / Claude Code と連携し、複数のサブ Agent を並列に起動・管理する。職種ごとに Provider（`cursor` / `claude`）とモデルを指定でき、複数 Provider のモデルを混在させて実行できる。

## 前提条件

- Node.js >= 20
- Docker / Docker Compose（テスト・ビルド用）
- Agent 実行に使う Provider の CLI（職種で使うものだけ必要）
  - `cursor`: Cursor CLI（`agent` コマンド）
  - `claude`: Claude Code CLI（`claude` コマンド）

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

Cursor CLI（`agent`）/ Claude Code CLI（`claude`）を使うため、ホスト上で直接実行する。
ヘルスチェック・Agent 実行・モデル一覧取得がすべて動作する。

```bash
npm run dev

# ダッシュボード → http://localhost:9696
```

### ダッシュボード確認のみ（Docker）

Provider の CLI が不要な UI 確認用途。ヘルスチェックやAgent 実行は動作しない。

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

## Provider とモデルの設定

職種ごとに `kuromajutsu.config.yaml` の `provider` と `model` を指定する（`provider` 省略時は `cursor`）。

```yaml
roles:
  - id: impl-code
    provider: claude      # Claude Code CLI
    model: sonnet         # sonnet / opus / haiku または claude-* の完全 ID
    ...
  - id: code-review
    provider: cursor      # Cursor CLI
    model: composer-2.5-fast   # `agent models` で表示される ID
    ...

# 省略可: Claude Code の --permission-mode（デフォルト bypassPermissions）
providers:
  claude:
    permissionMode: bypassPermissions
```

- `claude` Provider のサブ Agent は無人実行のため、デフォルトでは権限確認をすべてバイパスする（Cursor の `--force` 相当）。制限したい場合は `permissionMode` を変更する
- サブ Agent の `report_result` 用に、`--mcp-config` で `http://localhost:9696/mcp` が自動的に渡される

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

## Claude Code MCP 設定

メイン Agent として Claude Code から使う場合:

```bash
claude mcp add --transport http kuromajutsu http://localhost:9696/mcp
```

## 使い方

メイン Agent（Cursor / Claude Code）から MCP ツール経由で操作する。

```
1. list_roles          → 利用可能な職種・モデルを確認
2. create_group        → グループを作成（description を指定）
3. run_agents          → Agent を一括起動（groupId, agents を指定）
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

Magentic テスト実行済み
