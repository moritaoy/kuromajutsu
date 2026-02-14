# Phase 3 完了メモ — ヘルスチェック実装

## 実施日
2026-02-14

## 概要
`3-implement.md` の **Phase 3: ヘルスチェック実装** を TDD で実装完了。
起動時のモデル検証（`agent models` コマンド）とヘルスチェックプロンプト実行を実装し、テストを作成した。

## 実装したコンポーネント

| ファイル | クラス/型 | テスト数 | 説明 |
|---------|----------|---------|------|
| `src/health/checker.ts` | `HealthChecker` | 20 | モデル検証 + ヘルスチェックプロンプト実行 |
| `src/health/checker.ts` | `CliRunner` (interface) | — | CLI コマンド実行の DI インターフェース |
| `src/health/checker.ts` | `DefaultCliRunner` | — | `child_process.execFile` による実プロセス実装 |
| `src/health/checker.ts` | `HealthCheckCallbacks` | — | 進行状況通知のコールバック型 |
| `src/index.ts` | — | — | コールバックで AgentManager にヘルスチェックイベントを中継 |

**テスト合計: 136 件（Phase 3 新規: 19 件）/ 全体: 136 件**

## テストファイル

| ファイル | テスト数 | カバー範囲 |
|---------|---------|-----------|
| `tests/health/checker.test.ts` | 20 | モデル検証・ヘルスチェックプロンプト・コールバック通知・結果構造・コンソール出力 |

### テスト内訳

**モデル検証（agent models コマンド）: 6 件**
- `agent models` コマンド実行確認
- 有効モデルの valid 判定
- 無効モデルの invalid 判定（availableModels 付き）
- `agent models` 失敗時の全職種 invalid
- `agent models` 例外時の全職種 invalid
- 空行・空白除去によるモデル名抽出

**ヘルスチェックプロンプト実行: 5 件**
- モデル検証通過職種に対する CLI コマンド実行確認
- 成功時の passed + responseTime_ms 記録
- CLI 非ゼロ終了時の failed 記録
- CLI 例外時の failed 記録（エラーメッセージ付き）
- モデル検証失敗職種のスキップ（healthCheckPrompt 未実行確認）

**コールバック通知: 5 件**
- onModelValidation コールバック呼び出し
- onRoleCheckStart コールバック（各職種で呼ばれる）
- onRoleCheckComplete コールバック（各職種で呼ばれる）
- onComplete コールバック（全職種完了後）
- モデル検証失敗職種は onRoleCheckStart/Complete が呼ばれない

**結果構造: 3 件**
- 全職種分の結果返却 + プロパティ検証
- デフォルト CliRunner でのインスタンス化
- 職種 0 件時の空配列

**コンソール出力: 1 件**
- ヘルスチェック開始・完了のログ出力

## 設計パターン

### CliRunner インターフェース（DI パターン）
テスト時に CLI コマンド実行をモックに差し替えるため、`CliRunner` インターフェースを導入。
`HealthChecker` のコンストラクタでオプショナルに注入でき、省略時は `DefaultCliRunner`（`child_process.execFile`）を使用。

### HealthCheckCallbacks（コールバック通知）
ヘルスチェックの進行状況を外部に通知するため、`HealthCheckCallbacks` 型を導入。
`index.ts` で AgentManager の `emit` に中継し、ダッシュボード WebSocket イベントとして配信する。

### ヘルスチェックフロー
1. `agent models` → 利用可能モデル一覧取得
2. 各職種のモデルを一覧と照合（モデル検証）
3. モデル検証通過済み職種に `agent -p -m {model} "{healthCheckPrompt}"` 実行
4. 結果を HealthCheckResult[] として返却

## テスト実行方法

```bash
# 全テスト
docker compose run --rm app npm test

# ヘルスチェッカーのみ
docker compose run --rm app npm test -- tests/health/checker.test.ts
```

## 次のフェーズ（Phase 4: ダッシュボード UI 実装）

`3-implement.md` と `src/dashboard/design.md` に従い、以下を実装する:

1. **HTTPサーバー + 静的ファイル配信** — Express で React SPA を配信
2. **WebSocket 接続管理** — クライアント接続の管理とイベントブロードキャスト
3. **各画面実装** — ダッシュボード、ヘルスチェック状況、職種管理、実行履歴
4. **アニメーション** — ステータス色分け・視覚効果

**重要:** テスト・ビルドは必ず `docker compose run --rm app ...` で実行すること。ローカル実行は禁止。
