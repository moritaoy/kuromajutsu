# kuromajutsu — Makefile
# ============================================================

# --------------- ホスト実行（Cursor CLI が必要） ---------------

## ホットリロードあり開発実行
dev:
	npx tsx watch src/index.ts

## ホットリロードなし開発実行（1回起動）
run:
	npx tsx src/index.ts

# --------------- Docker 実行 --------------------------------

## テスト実行
test:
	docker compose run --rm app npm test

## テスト（ウォッチモード）
test-watch:
	docker compose run --rm app npm run test:watch

## ビルド
build:
	docker compose run --rm app npm run build

## 型チェック
typecheck:
	docker compose run --rm app npx tsc --noEmit

## ダッシュボード確認（Docker）
up:
	docker compose up

## Docker コンテナ停止
down:
	docker compose down

# --------------- ヘルプ -------------------------------------

## ターゲット一覧を表示
help:
	@echo ""
	@echo "kuromajutsu — 利用可能なコマンド"
	@echo "============================================================"
	@echo ""
	@echo "  ホスト実行（Cursor CLI が必要）"
	@echo "  ─────────────────────────────"
	@echo "  make dev          ホットリロードあり開発実行"
	@echo "  make run          ホットリロードなし開発実行（1回起動）"
	@echo ""
	@echo "  Docker 実行"
	@echo "  ─────────────────────────────"
	@echo "  make test         テスト実行"
	@echo "  make test-watch   テスト（ウォッチモード）"
	@echo "  make build        ビルド"
	@echo "  make typecheck    型チェック"
	@echo "  make up           ダッシュボード確認（Docker）"
	@echo "  make down         Docker コンテナ停止"
	@echo ""

.PHONY: dev run test test-watch build typecheck up down help
