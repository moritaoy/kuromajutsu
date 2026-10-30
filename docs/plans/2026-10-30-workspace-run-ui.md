# Workspace 実行画面の改善計画（2026-10-30）

対象: Workspace（`#/workspace`）の実行画面・完了レポート・Orchestrator 連携。
状態: **計画のみ。実装は未着手。** 実装は Sonnet サブエージェントに分割して依頼し、各フェーズの出口でテスト + レビュー + 人間の確認を置く（従来どおり）。

前提と制約:

- kuromajutsu は現在稼働中。**サーバーの再起動・Orchestrator への操作・実機 E2E は許可が出るまで行わない。** 検証は Docker のテスト（`docker compose run --rm app npm test` / `npx tsc --noEmit`）に限る。
- 作業ツリーには未コミットの変更（`resume` / RecoverPanel、ヘルスチェック並列化）が残っている。本計画の実装に入る前に、それらを先に別コミットとして切り分ける。
- 仕様書 `docs/spec.md` が SSOT。各フェーズで該当節と `docs/glossary.md` を更新する。

---

## 1. 要望と対応方針の一覧

| # | 要望 | 原因 / 現状 | 対応 | フェーズ |
|---|---|---|---|---|
| A | 実行中 Agent のツール呼び出し数などをダッシュボードのように見たい | `AgentState` に `toolCallCount` / `recentToolCalls` / `elapsed_ms` / `editedFiles` はあり WebSocket で届いているが、RunView は起動・完了の行しか出していない。Agent と手順（stepId）の対応が無い | Agent ↔ 手順の対応（`stepId`）を導入し、カード・詳細・サイドタブに Agent の活動を出す | P1（サーバー）/ P4（UI） |
| B | 実行に入ったら実行外のフェーズは縮め、トグルで展開 | PlanBoard は常に全フェーズを展開 | run モードに折りたたみを追加。自動規則 + 手動トグル | P3 |
| C | モデル別の消費トークンを集計し、結果表示で統計を見たい | トークンはどこにも記録していない。Claude Code の stream-json にはある（要実機確認）。Cursor CLI には無い見込み | Provider → AgentState → レポート `stats.usage` に集約。レポートに表、実行中は累計 | P2（サーバー）/ P4（UI） |
| D | 計画表が右にはみ出す | `.board.bd-p{min-width:max-content}` + `.card{width:196px;flex:none}` + `.prow` が折り返さない | 折り返し可能にし、カードは縮む。線の描画をサブ行対応 | P3 |
| E | Agent が report_result で完了しても実行状況が更新されない | カードの「実行中」・RUN 数・委任中チップは Task Ledger の `scheduledSteps.status` だけから決まる。サブ Agent の完了では台帳は変わらず、Orchestrator が次に `update_ledger(progress, scheduledSteps)` を送るまで古いまま（省略されると永久に古い） | A の `stepId` を使い、サーバーが起動時に `in_progress`、成功報告で `completed` に台帳を同期して `group:ledger_updated` を出す | P1 |
| G | 実行時間のタイムライン（フェーズ / 手順 / Agent の横棒）を実行中・実行後の両方で見たい | 時間軸の表示は無い。レポートの「経過」も一覧と時系列テキストのみ | 実行画面の下に「実行タイムライン」を置く（モック: `src/dashboard/public/mock/timeline.html`）。1 フェーズ 1 行、実行中のフェーズだけ手順 → Agent の行に展開、同時実行の Agent は縦に並べる。完了レポートの「経過」にも同じ部品 | P2（データ）/ P4（UI） |
| F | 開始直後に必ず replan が走り、全工程に「変更」タグが付く | Orchestrator の共通プロンプトが「最初に `update_ledger(type: "task")` で scheduledSteps を登録せよ」と指示しており、承認時にサーバーが投入済みの台帳を Orchestrator が自分の言葉で書き直して再送 → `description` 等が一致せず全 step が `replanned.changed` 扱い | プロンプト修正（Workspace では再登録しない）+ サーバー側で「初回の再登録」を吸収 | P1 |

---

## 2. 調査結果と設計

### A. 実行中 Agent の統計表示

**現状**

- `src/agent/manager.ts` の `handleStreamEvent` が `tool_call started` ごとに `toolCallCount` を増やし `agent:status_update` を出す。クライアントは `useAgentStore.js` の `state.agents` に持つ。
- `RunView.js` の `agentsOfWorkspace()` は、グループの `workspaceId` または Magentic 親グループの `parentGroupId` で Workspace の Agent を集める。活動ログに「起動 / 完了」だけ出す。
- `WorkspacePage.js` の PlanningView は Planner のツール回数を既に出している（表示の前例）。
- Agent がどの手順を担当しているかは **どこにも記録されない**（Orchestrator のプロンプト本文にしか無い）。

**設計**

1. 型: `AgentState.stepId?: string`、`AgentResult.stepId?: string`（`src/types/index.ts`）。
2. `run_agents` の agent 定義に `stepId?: string` を追加（`src/mcp/tools/run-agents.ts` の `agentSchema`、`manager.startAgents` → `startAgent` に伝搬）。
3. Workspace 注入ブロック（`src/workspace/orchestrator-prompt.ts` `buildWorkspaceInjectionBlock`）の実行ルールに「サブ Agent 起動時は `run_agents` の各 agent に担当手順の `stepId` を付ける（必須）」を追加。再開プロンプトにも同じ一文。
4. UI（P4）:
   - `StepCard`: 対応する Agent（`state.agents` から `stepId` 一致、最新 1 件）があれば、カード下部に live 行「◔ ツール 12 回 · 1 分 23 秒 · 直近: Edit」。完了後は「ツール 18 回 · 2 分 10 秒 · 編集 3 ファイル」。
   - `StepDetail`: その手順の Agent 一覧（agentId・職種・モデル・状態・経過・ツール回数・編集 / 新規ファイル・summary）。
   - `RunView` サイドに「Agent」タブを追加（実行中を上、完了を下。各行にツール回数・経過・トークン（C）・担当手順へのリンク）。`stepId` が無い Agent（Orchestrator、Planner、古い起動）は従来どおり一覧にだけ出す。
   - 経過時間は `AgentCard.js` と同じく `startedAt` からクライアントで刻む（実行中のみ）。

### B. 非アクティブフェーズの折りたたみ

**現状**: `PlanBoard.js` の `PhaseBand` が全フェーズの本体（`.pbody`）を常に描く。フェーズの状態は `plan-utils.js` の `phaseState()`（`done` / `active` / `waiting` / `pending`）。

**設計**（`PlanBoard.js` + `workspace.css`、run モードのみ。review モードは変更なし）

- 自動規則: `active` / `waiting` は展開、`done` / `pending` は折りたたむ。`selectedId` の手順を含むフェーズは展開。
- 手動: 見出しの ▸ / ▾ でトグル。トグルしたフェーズは手動状態を優先（`Map<phaseId, boolean>`）。そのフェーズの `phaseState` が変わった時点で手動状態を解除し、自動規則に戻す（例: `pending` → `active` になったら自動で開く）。
- 折りたたみ時の見出しに要約: 「手順 n/m」「ゲート: 合格 / 待ち / —」「実行中: s3 タイトル」。既存の `.pst` の横に出す。
- 本体は `display:none` ではなく **描画しない**。`drawEdges()` は `C[id]` が無い辺を既に除外するので崩れない。折りたたんだフェーズをまたぐ依存線は出ない（許容。spec に明記）。
- 修正フェーズ（`fixesOf`）は親フェーズの本体内に入れ子なので、親の展開に従う。親が `done` でも修正フェーズが `active` なら親を展開扱いにする。
- `ReadonlyBoard`（failed / aborted）は全フェーズが `pending` / `done` になりがちで全部閉じる → 見出し上に「すべて展開 / すべて閉じる」ボタンを置く（RunView にも同じボタン）。
- CSS: `.pband.collapsed .ph` の角丸を下にも付ける、トグルアイコン `.ptg`。

### C. モデル別の消費トークン

**現状**

- トークンはどの層にも無い。`StreamJsonParser` は行を素通しし、`ClaudeNormalizer.normalizeResult` は `result` の `data` をそのまま持っている（`src/agent/providers/claude.ts`）。
- Claude Code の stream-json（`--output-format stream-json --verbose`）の `result` には `usage`（`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`）、`total_cost_usd`、モデル別の `modelUsage` が入る。`assistant` イベントにも `message.usage` / `message.model` が入る。**実装の最初に、ホストで `claude -p "hi" --output-format stream-json --verbose` の最終行を取って形式を確かめる**（kuromajutsu には触らない）。
- Cursor CLI の `result` は `duration_ms` / `duration_api_ms` / `result` のみ（`tests/agent/parser.test.ts` の fixture と一致）。トークンは取れない前提で「不明」として扱う。

**設計**

1. 型（`src/types/index.ts`）:
   ```ts
   interface TokenUsage {
     inputTokens: number; outputTokens: number;
     cacheReadInputTokens: number; cacheCreationInputTokens: number;
     costUsd?: number;
   }
   AgentState.usage?: TokenUsage;   // 確定値（result 到着後）。途中は assistant の usage を累積（Claude のみ）
   AgentResult.usage?: TokenUsage;
   ```
2. Provider: `StreamNormalizer` が `result` を正規化するとき、共通形式 `data.usage: TokenUsage` を付ける（Claude: `usage` + `total_cost_usd` から。`modelUsage` が複数モデルなら合算。Cursor: 付けない）。`assistant` イベントの `message.usage` も `data.usage` に写す（途中経過用）。
3. `manager.handleStreamEvent`: `assistant` で `usage` を累積、`result` で確定値に置き換え、`agent:status_update` に含める。`reportResult` / `collectStageResults` で `AgentResult.usage` に写す。
4. レポート（`src/workspace/report.ts`）: `WorkspaceReport.progress.stats.usage` を追加。
   ```ts
   usage: {
     total: TokenUsage;
     byModel: { model: string; provider: AgentProviderId; roles: string[]; agents: number; toolCalls: number; usage: TokenUsage }[];
     unknownAgents: number; // usage が取れなかった Agent 数（Cursor など）
   }
   ```
   集計対象は `agentsOfRun(groupId)`（Orchestrator を含む）+ Planner グループ（`workspaceId` が一致する active でないグループも含める。`WorkspaceService` から Planner の groupId を引けるか確認し、引けなければ Planner は対象外と明記）。サーバー再起動後は Agent が失われるため、レポート生成時に確定して保存する。
5. UI（P4）: `ReportView.js` の「経過」に「モデル別の消費トークン」表（モデル / 職種 / Agent 数 / ツール回数 / 入力 / 出力 / キャッシュ読取 / キャッシュ作成 / 概算コスト）と合計行。`unknownAgents > 0` なら「トークン不明の Agent n 件（Cursor）」の注記。`RunView` の `runbar` に累計トークン（`state.agents` からクライアント集計、live）。
6. `kuromajutsu.config.yaml` にはコスト単価を持たない。コストは Provider が返す値のみ使う（無ければ表示しない）。

### D. 計画表の横はみ出し

**原因**（`src/dashboard/public/styles/workspace.css`）

- `.board.bd-p{min-width:max-content}` でボード幅が内容に合わせて伸びる。
- `.card{width:196px;flex:none}` でカードが縮まない。
- `.prow{display:flex;justify-content:center}` が折り返さないため、並列手順が多い段で 196px × n + 18px × (n−1) になる。
- `.board-wrap{overflow:auto}` なので横スクロールで逃げている。

**設計**

- `.board.bd-p` の `min-width:max-content` を外し `width:100%`。
- `.prow{flex-wrap:wrap}`、`.card{flex:0 1 196px;min-width:150px;width:auto}`。`.gaterow` のカードは 1 枚なので従来の幅で可。`.ttl` と `.top` に `overflow-wrap:anywhere`、`.top` を `flex-wrap:wrap`。`.card .role .mdl` の `max-width` はそのまま。
- `drawEdges()` のサブ行対応: 今は `.prow` 単位で「行」を決めているため、折り返しで 1 つの `.prow` が 2 段になると、下段へ向かう線が上段のカードの上を通りうる。各カードの `y0` を見て、同じ `.prow` 内でも `y0` が異なれば別の視覚行として扱う（`rowEls` をカードの `y0` でグルーピングし直す）。ResizeObserver での再描画は既存。
- `.runlayout` / `.layout` は `minmax(0,1fr)` 済みなので変更不要。`.drawer` 幅 430px は `min(430px, 100vw)`（1100px 以下は既に対応）に揃える。

### E. Agent 完了が実行状況に反映されない

**調査結果**

- 画面の手順状態は `modelFromLedger()`（`plan-utils.js`）が `ledger.taskLedger.scheduledSteps[].status` から決める。活動ログの Agent 行だけは `state.agents` 由来なので更新される。
- サブ Agent が `report_result` を呼んでも、サーバーは台帳を触らない（`manager.reportResult` は `agent:result_reported` を出すだけ）。台帳は Orchestrator が `update_ledger` で `scheduledSteps` を送ったときだけ変わる（`src/mcp/tools/update-ledger.ts`: `type: "progress"` で `scheduledSteps` が付いた時のみ反映）。
- 共通プロンプトは「進捗更新と同時に scheduledSteps を必ず含める」と書いているが、実際には省略されることがあり、その場合は次の `type: "task"` まで古いままになる。

**設計**（A の `stepId` を前提）

- `WorkspaceRunner`（`src/workspace/run.ts`）で `agent:created` / `agent:result_reported` を購読し、Workspace の実行配下（`agentsOfRun` と同じ判定）の `stepId` 付き Agent について:
  - 起動時: 台帳の該当 step が `pending` なら `in_progress` に。
  - 成功報告（`status: "success"`）: `completed` に。失敗・タイムアウト・中断は変えない（Orchestrator が判断する）。
  - `kind: "gate"` の step は対象外（ゲートの状態はサーバーのゲート処理が管理。`GATE_PROTECTED` の原則どおり）。
  - 変更があれば `manager.updateTaskLedger` 経由で `group:ledger_updated` を出す（`ledger-guard` は通さない。サーバー自身の同期なので）。
- Orchestrator が後から同じ `status` を送っても差分なし。先に Orchestrator が `completed` にしていればそのまま。
- UI の保険（P4）: `stepId` 付き Agent が `resultReported` なのに台帳が `in_progress` のままなら、カードの live 行に「完了報告済み（台帳更新待ち）」と出す。

### F. 開始直後の replan と全工程の「変更」タグ

**原因（コードから特定。高確度）**

1. 承認時にサーバーが Task Ledger を初期投入する（`run.ts` `approve()` → `toTaskLedgerInput()`（`src/workspace/plan.ts`）。`description` は `step.description || step.title`、`dependsOn` は実効依存、`doneCriteria` / `checks` / `onFail` 付き）。
2. Orchestrator の 7 層プロンプトの共通「台帳の記録ルール」（`src/agent/manager.ts` `buildMagenticOrchestratorPrompt` の `toolGuideBlock`）が **「1. タスク分析完了時: `update_ledger(type: "task")` で facts / plan / scheduledSteps を記録せよ」** と指示している。Workspace 注入ブロック（`orchestrator-prompt.ts`）は「Task Ledger は登録済みなので再登録しない」とは言っておらず、再開プロンプトだけが「未登録なら登録」と書いている。
3. Orchestrator は【Workspace 計画】（人向けに整形した title / description / DoD）を見て、scheduledSteps を **自分の言葉で書き直して** 送る。`ledger-guard.ts` の `classify()` は `stepContent()`（`role` / `description` / `dependsOn` / `phaseId` / `kind` / `doneCriteria` / `checks` / `onFail`）の深い比較で判定するため、`description` の言い換え、`doneCriteria` の省略（`INHERITED_KEYS` で補完されるが配列の順序や文言が違えば差分）、work の `dependsOn` 省略（`normalizeDeps` は `completed` 以外を実効依存に揃えるが、Orchestrator が同じフェーズ内の依存を省くと `origin()` に変わる）で **ほぼ全 step が `replanned.changed`** になる。
4. `run.ts` `applyLedgerUpdate()` が `workspace:replanned` を出し、クライアントの `useAgentStore.js` が `meta.replannedSteps[stepId] = "changed"` と `replanCount` を積む → `modelFromLedger()` が `mark: "modified"`（「変更」タグ）を付け、runbar に「1 REPLAN」が出る。`replannedSteps` は実行中ずっと消えない。

**対策（3 層）**

1. プロンプト（主対策）:
   - Workspace 注入ブロックの実行ルールに追加: 「Task Ledger は承認済みの計画で **登録済み**。最初に `update_ledger(type: "task")` で登録し直さない。手順を変えないときは `scheduledSteps` を省略する。変えるときも、変えない手順は **受け取った内容（`description` / `doneCriteria` / `dependsOn`）をそのまま** 含める（言い換えない）。」
   - 共通の `toolGuideBlock` の「1. タスク分析完了時」は Workspace のときだけ差し替える（`MagenticConfig` に `ledgerPreloaded: true` のようなフラグを足し、`buildMagenticOrchestratorPrompt` で文言を分岐）。
   - 再開プロンプトの `taskLedgerLines` も「登録済み。再登録しない」を明記。
2. サーバー（保険）: `applyLedgerUpdate()` / `classify()` で **初回の再登録** を吸収する。条件: まだ Progress Ledger が無い（反復 0）かつ `type: "task"` かつ追加・削除が無く、すべての既存 step の `status` が `pending`。このときは incoming の `description` / `doneCriteria` を current の値で上書きし（Orchestrator の言い換えを捨てる）、`replanned` を空にして `workspace:replanned` を出さない。それ以外の正当なリプラン（文言変更を含む）は従来どおり。
3. UI: 「変更」タグは `replanned.changed` が本当にあった手順にだけ付く状態を維持（変更なし）。`replanCount` は上記で 0 のまま。

**確認方法**: `tests/workspace/ledger-guard.test.ts` と `tests/workspace/service-run.test.ts` に「承認直後に Orchestrator が同じ step を言い換えて `type: "task"` で再送 → `workspace:replanned` が出ない・`description` は計画のまま」のケースを追加。`tests/workspace/orchestrator-prompt.test.ts` に文言のテスト。

### G. 実行タイムライン（追加要望 2026-10-30）

**モック**: [`src/dashboard/public/mock/timeline.html`](../../src/dashboard/public/mock/timeline.html)（`.claude/launch.json` の `mock-static` で `http://localhost:9797/timeline.html`）。シナリオ切替（実行中 / 差し戻しあり / 実行後）、フェーズの開閉、Agent 行の表示切替、ホバーの詳細を動かせる。

**表示の規則**

- 置き場所: RunView の `runlayout`（計画表 + サイド）の **下**、全幅。見出し行 + 本体（最大 220px、実行後は 260px、縦スクロール）+ 実行後は合計行。時間軸は本体の上に固定。
- **1 フェーズ = 1 行**（24px）。畳んだ行のバーは手順ごとのセグメント（色 = 職種）、ゲート（黄の斜線）、人間レビュー待ち（青の斜線）、修正フェーズ（橙の斜線）を 1 本に収める。右端にそのフェーズの「実行中の手順 · Agent n」。
- 展開すると **手順の行（18px）→ その手順を担当した Agent の行（15px）**。Agent は 1 Agent 1 行なので並列は縦に並ぶ。ラベルに職種・モデル・ツール回数・所要時間。ホバーで開始時刻・編集ファイル数・トークン。
- 開閉の自動規則は B（フェーズの折りたたみ）と同じ: 実行中 / レビュー待ちは展開、完了・未着手は畳む。手動開閉はフェーズの状態が変わるまで優先。計画表のカード選択（`selectedId`）と連動してそのフェーズを開く。
- 実行中のバーは右端の `now` 線まで伸び、縞が流れる（CSS アニメーション）。未着手フェーズは点線の空行（予測時間は出さない）。
- マーカー: ◆ ゲート（合格 緑 / 不合格 赤 / 実行中 黄）、👤 人間レビュー待ち（区間）、⚠ イレギュラー、⟲ 直前計画。
- 時間軸の目盛は全体の長さで 1 / 2 / 5 分刻みを選ぶ。ラベルは時刻 + 経過分。

**データの出所（実装時）**

| 要素 | 開始 / 終了 | 出所 |
|---|---|---|
| 手順（work） | 担当 Agent の最初の `startedAt` / 最後の完了（`startedAt + elapsed_ms`） | `state.agents`（A の `stepId` で紐付け）。Agent が無い手順は台帳の `status` 変化時刻（`group:ledger_updated` の受信時刻をクライアントで記録） |
| ゲート | 最初の attempt の最初の `check.at` の少し前（担当 Agent の起動）/ 最後の `closedAt` | `gateResults` + 担当 Agent |
| 人間レビュー待ち | `HumanReview.requestedAt` / `resolvedAt` | `humanReviews` |
| 修正フェーズ | 修正フェーズの手順の Agent | 台帳 `phases[].fix` + Agent |
| フェーズ | 最初の手順の開始 / 出口ゲートの `closedAt`（人間レビューなら `resolvedAt`） | 上の合成 |
| イレギュラー / 直前計画 | `GateChange.at` / `workspace:phase_planned` の受信時刻 | `gateChanges` / `meta.plannedSteps` |

- 実行中はすべてクライアント側（`state.agents` / `ledgers` / `workspace`）から組み立てる。サーバーの変更は A の `stepId` 以外は不要。
- **実行後（完了レポート）に残すため**、レポート生成時にサーバーが同じ構造を `WorkspaceReport.progress.timelineBars`（仮: `{ kind: "phase"|"step"|"agent"|"human"|"fix", id, parentId, label, role?, model?, start, end, toolCalls?, usage? }[]`）として保存する（サーバー再起動後は Agent が消えるため）。ReportView の「経過」で同じ部品を全フェーズ畳んだ状態 + 合計行（所要 / Agent 数 / ツール回数 / トークン / ゲート数 / 人間レビュー数）で出す。
- 部品は `src/dashboard/public/components/workspace/Timeline.js`（新規）に切り出し、RunView と ReportView で共用する。CSS は `workspace.css` に `.tl-*` を追加。

**フェーズへの割り当て**: データ構造（`timelineBars`）と report.ts の集計は **P2** に、`Timeline.js` と RunView / ReportView への組み込みは **P4** に追加する。spec は §13.8.10（画面の表示との対応）と §13.11（経過）に追記。

---

## 3. 実装フェーズと分割

依存関係: P1 と P2 と P3 は独立。P4 は P1・P2 の型とイベントに依存。P5 は全体の後。

| フェーズ | 内容 | 触るファイル | テスト |
|---|---|---|---|
| **P1 サーバー: Agent ↔ 手順の連携・台帳同期・初回 replan の抑止** | A-1〜3、E、F-1〜2 | `src/types/index.ts`、`src/mcp/tools/run-agents.ts`、`src/agent/manager.ts`（`startAgent(s)`、`toolGuideBlock` 分岐、`MagenticConfig`）、`src/workspace/run.ts`、`src/workspace/ledger-guard.ts`、`src/workspace/orchestrator-prompt.ts` | `tests/agent/manager.test.ts`、`tests/agent/tools.test.ts`、`tests/workspace/ledger-guard.test.ts`、`tests/workspace/service-run.test.ts`、`tests/workspace/orchestrator-prompt.test.ts` |
| **P2 サーバー: トークン集計・タイムラインの保存** | C-1〜4、6、G（`timelineBars`） | `src/types/index.ts`、`src/agent/providers/claude.ts`（必要なら `cursor.ts` / `types.ts`）、`src/agent/manager.ts`、`src/workspace/report.ts` | `tests/agent/providers/*`、`tests/agent/manager.test.ts`、`tests/workspace/report.test.ts` |
| **P3 UI: 折りたたみ・はみ出し** | B、D | `src/dashboard/public/components/workspace/PlanBoard.js`、`RunView.js`（展開ボタン）、`plan-utils.js`（要約）、`src/dashboard/public/styles/workspace.css` | ブラウザ確認は Docker の `docker compose up`（CLI 不要のダッシュボード確認）。ユーザーのモック `src/dashboard/public/mock/workspace.html` を参考にするが変更しない |
| **P4 UI: Agent 統計・完了反映・トークン表・タイムライン** | A-4、C-5、E の UI 保険、G（`Timeline.js`） | `Timeline.js`（新規）、`RunView.js`、`StepDetail.js`、`PlanBoard.js`（StepCard live 行）、`ReportView.js`、`useAgentStore.js`（`usage` のマージ） | 同上 |
| **P5 仕様・用語・E2E** | spec / glossary 更新、ホストで E2E（許可後） | `docs/spec.md`、`docs/glossary.md` | 全テスト + tsc + build |

spec の更新箇所（P5 でまとめるが、各フェーズで下書き）:

- §2（MCP ツール）`run_agents` の `stepId`、§6.x `AgentState` / `AgentResult` の `stepId` / `usage`。
- §8.3: `agent:*` の `data` に `stepId` / `usage`。
- §13.3.1 `WorkspaceReport.progress.stats.usage`。
- §13.5.5 / §13.8.2: Task Ledger は承認時に登録済みで Orchestrator は再登録しない、初回の再登録の吸収、サブ Agent の起動 / 成功報告による step status の同期。
- §13.8.10 / §13.10.1: 計画表の折りたたみ規則、カードの Agent 活動表示、Agent タブ。
- §13.11: 「経過」にモデル別トークンと実行タイムライン（`timelineBars`）。
- §13.8.10 / §13.10.1: 実行タイムライン（置き場所・1 フェーズ 1 行・開閉規則・マーカー）。
- 用語集: 「Agent ↔ 手順の対応（stepId）」「消費トークン（TokenUsage）」「フェーズの折りたたみ」。

各フェーズの進め方（従来どおり）: Sonnet に「目的・触ってよいファイル・完了条件・実行するテスト」を書いて依頼 → 別のサブエージェントがレビュー → Claude が差分と Docker テストで検証 → ユーザー確認 → コミット。

---

## 4. 決めてほしいこと

1. **未コミット分の扱い**: 先に `resume` / RecoverPanel とヘルスチェック並列化を別々にコミットしてから着手してよいか。
2. **Cursor のトークン**: Cursor CLI はトークンを返さない見込み。「不明」として件数だけ出す方針でよいか。
3. **折りたたみの初期規則**: 「完了 = 閉じる、未着手 = 閉じる、実行中・レビュー待ち = 開く、選択中の手順を含むフェーズ = 開く」でよいか。
4. **トークン表の位置**: 完了レポートの「経過」（折りたたみ）の中でよいか、最上部のサマリに合計だけ出すか。
5. **F の保険（初回再登録の吸収）** を入れるか、プロンプト修正だけにするか。推奨は両方（プロンプトだけでは Orchestrator の挙動に依存するため）。
6. **タイムラインのモック**（`timeline.html`）の見た目・規則でよいか。特に「畳んだフェーズのバーに手順の区切りを色分けで入れる」「Agent 行は既定で表示」「本体の高さ 220px」。

---

## 5. 検証計画

- 各フェーズ: `docker compose run --rm app npm test`、`docker compose run --rm app npx tsc --noEmit`。P3 / P4 は `docker compose up` でダッシュボードを開き、保存済みの Workspace（`.kuromajutsu/workspaces/`）の読み取り専用表示でレイアウトを確認。
- P2 の最初: ホストで `claude -p "hi" --output-format stream-json --verbose` を単発実行し、`result` の `usage` / `modelUsage` / `total_cost_usd` の形を確認してから型を確定する。
- E2E（ホスト `npm run dev`）: 許可が出てから。「承認 → 実行開始時に REPLAN が 0 のまま → サブ Agent 完了でカードが即『完了』になる → レポートにモデル別トークンが出る」を通す。
