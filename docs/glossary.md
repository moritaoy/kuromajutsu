# Kuromajutsu 用語集

> 本ドキュメントはプロジェクト全体で使用する用語を定義する。
> 各開発ステップで新しい概念が登場したら追記すること。

---

## 基本概念

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| エージェント | Agent | Provider の CLI（Cursor CLI / Claude Code CLI）のヘッドレスモードで起動される独立した AI 実行単位。子プロセスとして動作する |
| メインエージェント | Main Agent | Cursor IDE や Claude Code 上でユーザーと直接対話する Agent。kuromajutsu の MCP ツールを呼び出して複数のサブ Agent を管理する |
| サブエージェント | Sub Agent | メインエージェントから `run_agents` で起動される Agent。1台以上の Agent を一括起動し、特定の職種に基づいて動作する |
| 職種 / ロール | Role | Agent に割り当てる役割の定義。システムプロンプト、Provider、モデル、ツールセット等で構成される。1 職種は 1 Provider・1 モデルを持つ |
| Provider | Provider | Agent を実際に実行する基盤。`cursor`（Cursor CLI `agent`）と `claude`（Claude Code CLI `claude`）に対応する。職種ごとに指定し、複数 Provider のモデルを混在させて並列実行できる。省略時は `cursor` |
| グループ | Group | 関連する Agent の実行をまとめる論理的な単位。`create_group` で作成し、Agent 実行時に `groupId` を指定して紐付ける |
| Magentic パターン | Magentic Pattern | Microsoft Research が提唱するマルチエージェントオーケストレーションパターン。Orchestrator Agent が計画→委任→評価→リプランのループでタスクを自律的に遂行する |
| オーケストレーター | Orchestrator | Magentic パターンの中核 Agent。タスクの分析・計画立案・サブ Agent への委任・結果評価・リプランニングを自律的に行う。`orchestrator` ロール（`claude-fable-5-1`、provider: `claude`）で実行される |

## プロトコル・通信

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| MCPサーバー | MCP Server | Model Context Protocol に準拠したサーバー。Cursor と stdio で通信し、ツールを提供する |
| MCPツール | MCP Tool | MCPサーバーが公開する操作。`create_group`, `delete_group`, `run_agents`, `run_sequential`, `run_magentic`, `list_agents`, `get_agent_status`, `wait_agent`, `report_result`, `list_roles`, `update_ledger`, `run_gate_check`, `report_gate_result`, `request_human_review` の14個 |
| stdio | Standard I/O | 標準入出力。MCPサーバーと Cursor 間の通信トランスポート |
| WebSocket | WebSocket | 双方向リアルタイム通信プロトコル。ダッシュボード UI とサーバー間で使用 |

## Agent 実行

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| ヘッドレスモード | Headless Mode | CLI の非対話モード（Cursor: `agent -p --force` / Claude: `claude -p`）。GUI なしで Agent を実行する |
| stream-json | Stream JSON | 各 Provider CLI の `--output-format stream-json` で出力される NDJSON 形式のイベントストリーム。Provider ごとに形式が異なる |
| ノーマライザ | Normalizer | Provider 固有の stream-json イベントを共通イベント形式（Cursor 形式）に変換する処理。Claude Provider ではツール呼び出し（`tool_use` / `tool_result`）を `tool_call` イベントに変換する |
| パーミッションモード | Permission Mode | Claude Code CLI の `--permission-mode`。無人実行のためデフォルトは `bypassPermissions`。`providers.claude.permissionMode` で変更できる |
| NDJSON | Newline Delimited JSON | 改行区切りの JSON 形式。各行が1つの JSON オブジェクトを表す |
| Agent ID | Agent ID | Agent の一意識別子。`{role}-{timestamp}-{random4hex}` 形式 |
| Group ID | Group ID | グループの一意識別子。`grp-{unixTimestamp}-{random4hex}` 形式 |
| AgentResult | Agent Result | Agent 実行完了後の結果データ。サマリ、編集ファイル一覧、所要時間等を含む |
| AgentState | Agent State | Agent の現在の状態を表すデータ構造。ステータス、経過時間、ツール呼び出し数等を含む |
| 親グループ | Parent Group | Magentic モードで `run_magentic` により作成されるトップレベルのグループ。Orchestrator Agent を内包し、子グループの管理単位となる |
| 子グループ | Child Group | Orchestrator が `create_group` で作成するサブタスク用グループ。`parentGroupId` により親グループに紐付く |
| Ledger | Ledger | Orchestrator が各反復の冒頭で整理する進捗台帳。【現状】【残課題】【次のアクション】の構造で管理する |
| 完了条件 | Completion Criteria | Magentic パターンで Orchestrator がタスク完了を判定するための基準。`run_magentic` の必須パラメータとして指定する |
| 操作範囲 | Scope | Magentic パターンで Orchestrator とサブ Agent が変更してよいファイル・ディレクトリの範囲。`run_magentic` の必須パラメータとして指定する |

## UI・システム

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| ダッシュボード | Dashboard | ブラウザで表示する管理 UI。Agent の状態をリアルタイムで監視する。ポート 9696 で配信 |
| ヘルスチェック | Health Check | MCPサーバー起動時に各職種が正しく動作するか検証する自動チェック処理 |
| モデル検証 | Model Validation | 各職種に設定されたモデルが、その職種の Provider で利用可能かを確認する処理（Cursor: `agent models` と照合 / Claude: エイリアスまたは `claude-*` ID のパターン照合） |

## 開発・運用

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| SSOT | Single Source of Truth | 唯一の信頼できる情報源。本プロジェクトでは `docs/spec.md` がこれに該当する |
| TDD | Test-Driven Development | テスト駆動開発。テストを先に書き、テストを通す実装を行う開発手法 |
| Docker | Docker | コンテナ技術。開発・テスト・ビルドの実行環境として使用する |
| Docker Compose | Docker Compose | 複数コンテナのオーケストレーションツール。`docker compose up` で開発環境を起動する |

## 設計コンポーネント

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| AgentManager | Agent Manager | Agent と Group のライフサイクルを一元管理する中核コンポーネント。インメモリ Map で状態を保持し、EventEmitter パターンで状態変更を通知する。`src/agent/manager.ts` に実装 |
| AgentExecutor | Agent Executor | Cursor CLI をヘッドレスモードで子プロセス（`child_process.spawn`）として起動・管理するコンポーネント。タイムアウト処理も担う。`src/agent/executor.ts` に実装 |
| StreamJsonParser | Stream JSON Parser | Cursor CLI が出力する NDJSON をリアルタイムにパースする Transform ストリーム（`readableObjectMode: true`）。`"event"` カスタムイベントを emit し、readable 側に StreamEvent オブジェクトを push する。`extractFileChanges()` で write/edit ツール呼び出しからファイル変更を抽出する。`src/agent/parser.ts` に実装 |
| StreamEvent | Stream Event | StreamJsonParser がパースする NDJSON 1行分のイベント型。`type`（system/user/assistant/tool_call/result）、`subtype`（init/started/completed/success）、`data` フィールドで構成される。`src/agent/parser.ts` で定義 |
| FileChanges | File Changes | `StreamJsonParser.extractFileChanges()` が返すオブジェクト型。`editedFiles` と `createdFiles` の文字列配列を持つ |
| ExecutorOptions | Executor Options | `AgentExecutor.execute()` に渡すオプション型。`model`, `prompt`, `workingDirectory?`, `timeout_ms?` で構成。`src/agent/executor.ts` で定義 |
| ExecutorCallbacks | Executor Callbacks | `AgentExecutor.execute()` に渡すコールバック群の型。`onStreamEvent`, `onExit`, `onError` の3つ。`src/agent/executor.ts` で定義 |
| availableModels | Available Models | ヘルスチェック時に `agent models` コマンドで取得した、Cursor で利用可能なモデル名の一覧。AgentManager に保持され、`list_roles` レスポンスのトップレベルフィールドとして返却される |
| registerTools | Register Tools | 全 14 個の MCP ツールを McpServer に一括登録する関数。各ツールハンドラに AgentManager を注入する。`src/mcp/tools/index.ts` に実装 |
| handle* 関数 | Handle Functions | 各 MCP ツールのビジネスロジックをエクスポートした関数群（`handleCreateGroup`, `handleDeleteGroup` 等）。テストから直接呼び出し可能にするため、`server.tool()` コールバックとは分離して定義。`src/mcp/tools/*.ts` に実装 |
| errorResponse | Error Response | MCP ツールがエラーを返す際の共通ヘルパー関数。`{ content: [{ type: "text", text: JSON.stringify({ error, code, message }) }], isError: true }` 形式のレスポンスを構築する |
| HealthChecker | Health Checker | MCPサーバー起動時にモデル検証とヘルスチェックプロンプトを実行するコンポーネント。`agent models` でモデル一覧を取得し、各職種のモデルを照合後、`healthCheckPrompt` を Cursor CLI で実行する。`src/health/checker.ts` に実装 |
| CliRunner | CLI Runner | CLI コマンドを実行するインターフェース。`execCommand(command, args)` メソッドを持ち、テスト時にモックに差し替えることで HealthChecker の単体テストを可能にする。`src/health/checker.ts` で定義 |
| DefaultCliRunner | Default CLI Runner | `CliRunner` インターフェースの実プロセス実装。`child_process.execFile` で CLI コマンドを実行する。60秒タイムアウト付き |
| HealthCheckCallbacks | Health Check Callbacks | HealthChecker の進行状況を外部に通知するコールバック型。`onModelValidation`, `onRoleCheckStart`, `onRoleCheckComplete`, `onComplete` の4つのオプショナルコールバックで構成。`index.ts` でダッシュボード WebSocket イベントへの中継に使用 |
| MagenticConfig | Magentic Config | Magentic 実行設定を保持する型。task, completionCriteria, scope, constraints, context, availableRoles, maxIterations 等のフィールドで構成される |
| WorkspaceStore | Workspace Store | Workspace を `.kuromajutsu/workspaces/<id>/workspace.json` に保存し、メモリにもキャッシュするコンポーネント（EventEmitter）。一時ファイル + `renameSync` で原子的に書き込み、`workspace:created` / `workspace:updated` を emit する。`loadAll()` は再起動時の状態補正（`running` / `waiting_human` → `failed`、`planning` → `review` or `failed`）を行う。`src/workspace/store.ts` に実装 |
| workPlanInputSchema | WorkPlan Input Schema | Planner の出力（`revision` / `maxIterations` を含まない WorkPlan JSON）を検証する zod スキーマ。ID の一意性と参照整合性（`dependsOn` は同じフェーズ内のみ）も検証する。`parseWorkPlanInput()` で結果を `{ ok, value / errors }` として返す。`src/workspace/schema.ts` に実装 |
| reviewDocSchema | ReviewDoc Schema | text-writer が返す ReviewDoc JSON を検証する zod スキーマ。`kind` ごとの必須項目、節 ID の一意性、`version >= 2` での `previousFeedback` を検証する。`src/workspace/schema.ts` に実装 |
| extractJson | Extract JSON | Planner / text-writer の出力から JSON を取り出す関数。素の JSON、コードフェンス内、前後に文章が付いた場合に対応する。`src/workspace/schema.ts` に実装 |
| 計画ユーティリティ | Plan Utilities | WorkPlan を扱う純粋関数群。実効依存（`effectiveDeps`）、階層と循環検出（`computeLevels`）、Task Ledger への写像（`toScheduledSteps` / `toTaskLedgerInput`）、`computeMaxIterations`、revision 間の差分（`diffPlans`）、`generateWorkspaceId` などを提供する。`src/workspace/plan.ts` に実装 |
| validateWorkPlan / autoFixWorkPlan | Validate / Auto-fix WorkPlan | 検証器 V1〜V9 の実装。`validateWorkPlan` が `ValidationIssue[]` を返し、`autoFixWorkPlan` が V1（最終ゲート生成）・V2（出口ゲート挿入）・V4（手順のない確定フェーズを `deferred` に変更）を自動修正した新しい計画を返す。`src/workspace/validator.ts` に実装 |
| CommandPolicy / checkCommand | Command Policy / Check Command | ゲートの `command` の安全性判定。`buildCommandPolicy` が既定の禁止パターン（`DEFAULT_DENY_PATTERNS`）と設定の `deny` / `allow` からポリシーを組み立て、`checkCommand` が連結子で分割した各セグメントと全体に対して判定する。判定のみで実行はしない。`src/workspace/gate-commands.ts` に実装 |
| buildPlannerPrompt / extractPlannerOutput | Build Planner Prompt / Extract Planner Output | Planner の user プロンプトを組み立てる純粋関数（指示・作業ディレクトリ・職種一覧（Provider は出さない）・WorkPlan JSON の形。再計画時は前の計画・追加指示・指示の対象、リトライ時は直前の不備を含む）と、`report_result` の `response` から WorkPlan JSON を取り出して検証する関数。`renderTargets` は指示の対象を「@P2 実装を行う（フェーズ）」の形に解決する。`src/workspace/planner.ts` に実装 |
| WorkspaceService | Workspace Service | Workspace の計画生成・再計画・承認・実行・中断を担うサービス（EventEmitter）。計画生成は `planner` 職種の Agent を Concurrent グループ `Workspace <id> 計画生成` で起動し、出力が不正なら 1 回だけエラーを添えてリトライする。承認以降（`approve` / `runGateCheck` / `reportGateResult` / `requestHumanReview` / `resolveHumanReview` / `retry` / `ackIrregular` / `applyLedgerUpdate` / 実行中の `abort`）は `WorkspaceRunner` に委譲する。`findByGroupId` で Magentic 親グループから Workspace を引く。`resolveHumanReview` / `retry` は判断を記録して `running` にしたらすぐ返し、新しい Orchestrator の再開は非同期（`workspace:resumed`、失敗は `failed`）。`shutdown()` で実行中のゲートの command を中断する。合格済みのゲートへの記録は `GATE_ALREADY_PASSED`（修正は修正フェーズ + 再レビュー）。store のイベントと `workspace:*` を emit する。エラーは `WorkspaceError`（`src/workspace/errors.ts`。`VALIDATION_FAILED` は `issues` を持つ）。`src/workspace/service.ts` に実装 |
| handleWorkspaceApi | Handle Workspace API | `/api/workspaces` 配下の HTTP API（一覧・取得・作成・再計画・承認・人間レビュー・再試行・イレギュラー確認・中断・レビュー資料の配信）を処理するハンドラー。`approve` / `retry` は body を省略できる（Content-Type の検査は body があるときだけ）。レビュー資料は `reviews/` 配下の実パスに限り、CSP と `nosniff` を付けて配信する。対象外のパスには `false` を返す。`src/dashboard/api/workspaces.ts` に実装 |
| ShellGateCommandRunner | Shell Gate Command Runner | ゲートの `command` チェックを `sh -c` で実行するクラス（`GateCommandRunner` の実装）。作業ディレクトリをカレントにし、標準入力を閉じ、stdout / stderr を末尾 `maxOutput_bytes` だけ保持して結果に末尾 4000 文字を返す。タイムアウトで SIGTERM、5 秒後に SIGKILL（プロセスグループごと）。spawn 失敗は reject せず `exitCode: null` で返す。`src/workspace/gate-runner.ts` に実装 |
| renderReviewDoc / prepareReviewFiles | Render Review Doc / Prepare Review Files | ReviewDoc を自己完結の HTML にする関数と、`kind: "file"` の節のファイルを検証・複製する関数。`renderReviewDoc` は `marked`（生 HTML はエスケープ）で Markdown を変換し、`table` をエスケープし、`mermaid` はランタイムがあるときだけインライン実行（失敗時はコードブロック）、`html` / `file` は `sandbox="allow-scripts"` の iframe で描画し、節ごとに「コメント」ボタン（`postMessage` で `review:comment`）を付ける。`prepareReviewFiles` は作業ディレクトリ内の実パス・5 MiB 以下に限って `reviews/<gateId>-v<n>.files/` へ複製する。`loadMermaidRuntime` は同梱の mermaid を読む。`src/workspace/review-doc.ts` に実装 |
| buildWorkspaceInjectionBlock / buildResumePrompt | Build Workspace Injection Block / Build Resume Prompt | Orchestrator プロンプトに追加する Workspace 用ブロック（この計画を正とする、ゲートの実行手順、不合格時の原則、ゲートの変更ルール、ReviewDoc の依頼方法、計画の全文）と、人間レビュー / 差し戻し上限超過のあとで再開する Orchestrator への再開プロンプト（状態のスナップショットと理由ごとの「次にやること」）を組み立てる純粋関数。`src/workspace/orchestrator-prompt.ts` に実装 |
| buildWorkspaceReport | Build Workspace Report | 完了レポート（`WorkspaceReport`）を組み立てる純粋関数。文章（何が実装されたか / 試し方 / 確認しておくと良いこと）は Orchestrator の最終 `report_result` の `response` から見出しで抜き出し、変更ファイル・人が判断したこと・完了条件の達成・イレギュラー・経過（フェーズ別の手順、時系列、ゲート結果、数値）は Workspace のデータから機械的に作る。`src/workspace/report.ts` に実装 |
| gates（ゲートの attempt 管理） | Gates | ゲートの結果を扱う純粋関数群。`recordCheckResult`（attempt の開閉・同じ `checkIndex` の上書き）、`deriveGateStatus`（§13.3.4 の `pending` / `failed` / `auto_passed` / `passed` の導出）、`failedAttemptsSinceRetry` / `isRetryLimitExceeded`（差し戻し上限の判定。再試行後は 0 から数え直す）、`autoChecksOf` / `hasHumanCheck` / `newGateResult`。`src/workspace/gates.ts` に実装 |
| guardLedgerUpdate | Guard Ledger Update | Workspace グループの `update_ledger` の検証と正規化を行う純粋関数。ゲートの `status` 保護（`GATE_PROTECTED`）、ゲートの変更・削除の `irregular` + `reason` 要求（`GATE_CHANGE_NOT_ALLOWED`）、最終ゲート・human チェックの削除禁止、追加・変更ゲートの `command` 検査（`GATE_COMMAND_DENIED`）、`stepId` の重複拒否（`DUPLICATE_STEP_ID`）、`phases` の整合性（`INVALID_PHASES`。承認済みフェーズの `fix` / `parentPhaseId` / `planning` / `final` は変更不可、追加フェーズには出口ゲートが要る、final フェーズは最後）、`dependsOn` の実効依存への正規化、直前計画（`phasePlanned`）とリプラン（`replanned`）の分類を行う。`src/workspace/ledger-guard.ts` に実装 |
| WorkspaceRunner | Workspace Runner | Workspace の実行系（`WorkspaceService` が委譲）。承認時の Magentic グループ・Task Ledger・Orchestrator の起動、ゲートの記録（`command` はサーバーが実行）、人間レビューの ReviewDoc 取り込みと HTML 保存、人間レビュー / 差し戻し上限超過での停止と新しい Orchestrator による再開（再開プロンプト）、Orchestrator 完了時の `done` / `failed` 判定、`update_ledger` のゲート保護との連携を担う。`src/workspace/run.ts` に実装 |
| `run_gate_check` / `report_gate_result` / `request_human_review` | — | Workspace の Orchestrator 専用 MCP ツール（spec §2.2.12〜2.2.14）。`run_gate_check` はサーバーがゲートの `command` を実行して結果を返し、`report_gate_result` は `agent-review` チェックの合否を記録し、`request_human_review` は ReviewDoc を HTML にして人間レビュー待ちにする。Workspace に紐付かないグループでは `NOT_WORKSPACE_GROUP`。`src/mcp/tools/` に実装 |

## UI コンポーネント

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| AgentCard | Agent Card | 1つの Agent のステータス・経過時間・ツール呼び出し数等をカード形式で表示する React コンポーネント。ステータスに応じた色分けとアニメーションを持つ |
| GroupSection | Group Section | グループ単位で Agent カードをまとめるアコーディオン型の React コンポーネント。グループの進捗状況をヘッダーに表示する |
| RoleEditor | Role Editor | 職種の設定（モデル、システムプロンプト等）をインライン編集する React コンポーネント。変更を YAML ファイルに反映する |
| HistoryTable | History Table | 完了した Agent の実行結果を一覧表示するテーブル型 React コンポーネント。グループ・ステータス・職種でフィルタリング可能 |
| HealthStatus | Health Status | 起動時ヘルスチェックの進行状況をステップ形式でリアルタイム表示する React コンポーネント |
| ModelList | Model List | 利用可能モデル一覧を表示する React コンポーネント。Info 画面で使用し、職種登録時のモデル名確認に利用する |
| InfoPage | Info Page | システム情報画面。利用可能モデル一覧など、サーバー環境の情報を表示する |
| Layout | Layout | ヘッダー・ナビゲーション・コンテンツエリアを持つ共通レイアウト React コンポーネント |
| WorkspacePage | Workspace Page | `#/workspace`（`#/workspace/<id>`）の画面。Workspace の `status` に応じて指示・計画生成中・計画レビュー・実行・完了レポートを切り替え、上部の切替から過去の Workspace を開き直せる。`components/workspace/WorkspacePage.js`（§13.10） |
| InstructView | Instruct View | ① 指示画面。指示欄 1 つと任意の作業ディレクトリだけを持つ（ラベル・説明文なし） |
| PlanBoard | Plan Board | フェーズ帯を上から積み、帯の中は依存段ごとに手順を横に並べて直交ルーティングの線で結ぶボード。計画レビュー・実行・読み取り専用で共用し、職種名とモデル名（Provider は出さない）を小さく表示する |
| ReviewView | Review View | ② 計画レビュー画面。ボード + サイド（解釈・検証 V1〜V9・改訂履歴）。人は計画を編集せず、対象チップと定型指示で AI に指示する |
| ActionBar | Action Bar | 計画レビュー画面の下部バー。対象チップ・定型指示・指示欄・「AI に指示」「承認して実行」（検証エラー 0 件で有効）・「中断」 |
| RunView | Run View | ③ 実行画面。ボードに Task Ledger の状態を重ね、サイドに Orchestrator の現在・活動ログ・進捗台帳・ゲート結果を出す |
| HumanReviewPanel | Human Review Panel | `human_review` で停止中に出すパネル。レビュー資料を sandbox 付き iframe で表示し、`review:comment` を受けて節コメントを積み、承認 / 差し戻しを送る |
| RetryPanel | Retry Panel | `gate_retry_exceeded` で停止中に出すパネル。不合格のゲートと各 attempt の結果を見せ、「指示を付けて再試行」「中断」を選ばせる |
| IrregularBanner | Irregular Banner | ゲート変更（イレギュラー）のうち未確認のものを警告表示し、「確認した」で確認済みにする。確認済みは折りたたみで残す |
| ReportView | Report View | ④ 完了レポート。結果のサマリを最上部に置き、途中の経過は折りたたみにする（§13.11） |
| useWorkspaceApi | Use Workspace API | Workspace HTTP API（§13.9.1）の fetch ラッパー。エラーは `{ error, message, issues? }` を throw する。`hooks/useWorkspaceApi.js` に実装 |

## ダッシュボードサーバー

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| startDashboardServer | Start Dashboard Server | HTTP サーバーと WebSocket サーバーを同一ポートで起動する関数。`config` と `manager` を引数に取り、静的ファイル配信・SPA フォールバック・WebSocket ブロードキャストを提供する。`src/dashboard/server.ts` に実装 |
| WebSocketServer | WebSocket Server | `ws` パッケージの WebSocketServer クラス。HTTP サーバーと同ポートで動作し、ダッシュボード UI とリアルタイム双方向通信を行う |
| sendInitialState | Send Initial State | 新しい WebSocket クライアントが接続した際に、現在のサーバー状態（起動通知・ヘルスチェック結果・グループ・Agent 一覧）をスナップショットとして送信する関数 |
| handleClientEvent | Handle Client Event | クライアントから受信した WebSocket イベント（`config:update_role`, `config:revalidate_model`）を処理し、設定変更を YAML ファイルに反映する関数 |
| setupBroadcast | Setup Broadcast | AgentManager の全イベントをリッスンし、接続中の全 WebSocket クライアントに ServerEvent として中継するセットアップ関数 |
| ServerEvent | Server Event | サーバーからクライアントへ送信される WebSocket イベントの型定義。`server:startup`, `healthcheck:*`, `group:*`, `agent:*`, `config:updated` の12種類。`src/types/index.ts` で定義 |
| ClientEvent | Client Event | クライアントからサーバーへ送信される WebSocket イベントの型定義。`config:update_role`, `config:revalidate_model` の2種類。`src/types/index.ts` で定義 |
| listGroups | List Groups | AgentManager が管理する全グループ一覧を配列で返すメソッド。WebSocket 接続時の初期状態送信に使用 |

## React SPA フック

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| useWebSocket | Use WebSocket Hook | WebSocket 接続の確立・自動再接続・メッセージ送受信を管理する React フック。指数バックオフ（1s→2s→4s→max 30s）による自動再接続機能を持つ。`src/dashboard/public/hooks/useWebSocket.js` に実装 |
| useAgentStore | Use Agent Store Hook | `useReducer` で全アプリケーション状態（Group, Agent, HealthCheck, Config）を管理する React フック。ServerEvent を受けて状態を更新する Reducer を内包する。`src/dashboard/public/hooks/useAgentStore.js` に実装 |
| importmap | Import Map | `<script type="importmap">` で React / ReactDOM の CDN URL をモジュール名にマッピングする仕組み。ビルドステップなしで ES Module ベースの React SPA を実現する |
| ハッシュベースルーティング | Hash-Based Routing | URL のハッシュ部分（`#/`, `#/roles`, `#/history`, `#/health`, `#/workspace`）でページ遷移を行う SPA ルーティング方式。サーバー側の設定不要でクライアントのみで完結する |

## 設計パターン・概念

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| EventEmitter パターン | EventEmitter Pattern | Node.js の EventEmitter を継承し、状態変更を `emit` でブロードキャストするパターン。AgentManager が採用し、WebSocket を介してダッシュボードに中継する |
| イベント駆動アーキテクチャ | Event-Driven Architecture | AgentManager → WebSocket → ダッシュボード UI の通知フローに使用するアーキテクチャ。各コンポーネントはイベントの発行と購読で疎結合に連携する |
| ブロードキャスト | Broadcast | WebSocket サーバーが接続中の全クライアントにイベントを一斉送信する処理。AgentManager のイベントをリッスンし中継する |
| 依存性注入 | Dependency Injection | MCP ツールハンドラに AgentManager インスタンスを引数として渡すパターン。テスト時のモック化を容易にする |
| SPA フォールバック | SPA Fallback | 存在しないパスへのリクエストに対して index.html を返す HTTP サーバーの動作。React のクライアントサイドルーティングを実現する |
| 指数バックオフ | Exponential Backoff | WebSocket 再接続時の待機時間を 1s → 2s → 4s → 8s ... と指数的に増加させる戦略。サーバー復旧時の接続集中を防ぐ |
| 状態遷移 | State Transition | Agent のステータスが Queued → Running → Completed/Failed/TimedOut → ResultReported と一方向に遷移するルール。不正な遷移は無視する |

## エラーコード

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| GROUP_NOT_FOUND | Group Not Found | 指定された groupId に対応するグループが管理テーブルに存在しない場合のエラーコード |
| GROUP_NOT_ACTIVE | Group Not Active | 指定されたグループのステータスが "active" でない場合のエラーコード |
| GROUP_HAS_RUNNING_AGENTS | Group Has Running Agents | グループ削除時に実行中（queued/running）の Agent が残っている場合のエラーコード |
| ROLE_NOT_FOUND | Role Not Found | 指定された職種 ID が設定に存在しない場合のエラーコード |
| ROLE_UNAVAILABLE | Role Unavailable | 指定された職種がヘルスチェック未通過で利用不可の場合のエラーコード |
| MAX_CONCURRENT_REACHED | Max Concurrent Reached | Agent の同時実行数が設定上限（maxConcurrent）に達した場合のエラーコード |
| AGENT_NOT_FOUND | Agent Not Found | 指定された agentId に対応する Agent が管理テーブルに存在しない場合のエラーコード |

## Workspace

| 用語 | 英語表記 | 定義 |
|------|---------|------|
| Workspace（作業スペース） | Workspace | 1 回の指示から計画・承認・実行・完了までの作業単位。指示・計画の改訂履歴・ゲート結果・人間レビュー・完了レポートを持つ。ID は `ws-{unixTimestamp}-{random4hex}` 形式。`.kuromajutsu/workspaces/<id>/workspace.json` に保存する（spec §13） |
| 作業ディレクトリ | Workspace Path | Workspace が変更対象とするディレクトリ（`workspacePath`）。ゲートの `command` のカレントディレクトリになる。Workspace 自体（作業単位）とは区別する |
| WorkPlan | Work Plan | Planner が作る構造化された作業計画。解釈（`PlanSpec`）・フェーズ・手順・ファクトを持ち、改訂（revision）で管理する。承認された revision が実行に使われる |
| フェーズ | Phase | 計画の大まかな段階（例: アーキテクチャを決める / 実装を行う / テストを実装する）。上から順に進み、並列はフェーズの中だけ。どのフェーズも出口ゲートで終わる |
| 手順 | Step | フェーズ内の 1 作業（`PlanStep`）。職種・説明・完了定義を持つ。フェーズ内では依存がなければ並列に動く。ゲートも `kind: "gate"` の Step として表す |
| 完了定義 | DoD（Definition of Done） | Step が「終わった」と言える観測可能な条件（`doneCriteria`、複数可） |
| ゲート | Gate | フェーズの出口のチェックポイント。自動チェック（`agent-review` / `command`）と人間レビュー（`human`）を持てる。通常は Orchestrator が変更できない |
| 出口ゲート | Exit Gate | 各フェーズの最後に置くゲート。合格するまで次のフェーズへ進まない |
| 最終ゲート | Final Gate | 全フェーズの後に必ず置くゲート（`final` フェーズ）。完了条件（`spec.completion`）を確認する。削除できない |
| 人間レビュー | Human Review | `human` チェックを持つゲートで、人がレビュー資料を読んで承認 / 差し戻しする仕組み。Orchestrator は `request_human_review` を呼んで終了し、判断後に新しい Orchestrator が再開する |
| レビュー資料 | Review Document（ReviewDoc） | 人間レビューで人に見せる、構造化された資料。AI は ReviewDoc JSON を返し、サーバーが自己完結の HTML に変換して `reviews/<gateId>-v<n>.html` に保存する。節の `kind` は markdown / html / file / table / mermaid |
| 計画立案者 | Planner | 指示から WorkPlan を作る `planner` 職種（claude / opus）。ファイル編集禁止、出力は WorkPlan JSON のみ |
| 確定 | fixed | フェーズの `planning` の値。手順・DoD まで計画時に確定する |
| 直前計画 | Deferred Planning（`deferred`） | フェーズの `planning` の値。目的・出口ゲート・メモだけ決め、手順はそのフェーズの開始直前に Orchestrator が前フェーズの成果を見て決める |
| リプラン | Replan | 実行中に Orchestrator が手順を追加・分割・スキップ・順序変更すること（ゲートは変えない）。承認前に Planner が追加指示で計画を練り直す「再計画」とは別 |
| 修正フェーズ | Fix Phase | ゲート不合格の原因が前のフェーズにあるとき、不合格になったフェーズの中に入れ子で追加するフェーズ（`Phase.fix` / `parentPhaseId`）。原因のフェーズは巻き戻さず追加する |
| 原因の切り分け | Triage | ゲート不合格時に、レビュー職種へ依頼して原因の箇所と直すべき職種を調べる手順。Orchestrator は自分では調査しない |
| イレギュラー | Irregular（GateChange） | Orchestrator が進行上やむを得ずゲートを変更・削除・緩和したこと。`irregular: true` と理由が必須で、人に必ず通知し、人が確認済みにするまで残す |
| 再開プロンプト | Resume Prompt | 人間判断の後に新しい Orchestrator を起動するときのプロンプト。Task Ledger の全状態、Progress Ledger の履歴、ゲート結果、レビュー結果（差し戻しコメント）、人の指示を含む |
| 差し戻し上限超過 | Gate Retry Exceeded | 同じゲートが初回 + `maxRetries`（既定 2）回の再チェックを経ても不合格だった状態。Workspace は `waiting_human`（`gate_retry_exceeded`）になり、人が「指示を付けて再試行」か「中断」を選ぶ |
| 検証器 | Validator（V1〜V9） | 承認時に WorkPlan を検査するルール群。V1 最終ゲートの存在、V2 出口ゲート、V3 DoD、V4 手順・目的、V5 チェックの存在、V6 職種の可用性、V7 依存の循環、V8 scope 衝突（warning）、V9 ゲートの `command` が禁止パターンに当たらない。V8 以外は error で、エラーがあると承認できない |
| 禁止パターン | Deny Pattern | ゲートの `command` として実行できないコマンドのパターン。既定はルート削除・`sudo`・`git push`・`git reset --hard`・`curl/wget ... \| sh`・`shutdown` / `reboot`。`workspace.gateCommands.deny` で追加し、`allow` を指定すると前方一致の許可リストに切り替わる |
| `run_gate_check` | Run Gate Check | MCP ツール。Orchestrator が `(groupId, gateId)` を指定して呼び、サーバーがゲートの `command` チェックを `sh -c` で実行して合否・exit code・出力の末尾を返す |
| `report_gate_result` | Report Gate Result | MCP ツール。Orchestrator が `agent-review` チェックの結果を `(groupId, gateId, checkIndex, passed, note)` で記録する |
| `request_human_review` | Request Human Review | MCP ツール。自動チェック合格後に `(groupId, gateId, reviewDocPath)` で人間レビューを依頼する。呼んだ後、Orchestrator は自身の実行を終了する |
| Workspace の状態 | Workspace Status | `planning`（計画生成中）/ `review`（計画レビュー）/ `running`（実行中）/ `waiting_human`（人の判断待ち。理由は `human_review` と `gate_retry_exceeded`）/ `done`（完了）/ `failed`（失敗。サーバー再起動を含む）/ `aborted`（中断） |

## 初期職種

| 職種 ID | 表示名 | 説明 |
|---------|--------|------|
| `impl-code` | コード実装者 | 仕様に基づいた高品質なコード実装を担当 |
| `code-review` | コードレビュワー | コードの品質・可読性・セキュリティ・パフォーマンスをレビュー |
| `text-review` | 文章レビュワー | テキストの文法・表現・構成・一貫性を確認 |
| `impl-test` | テスト実装者 | ユニットテスト・エッジケース・異常系テストを作成 |
| `design` | 設計者 | 設計・アーキテクチャ検討（claude / opus）。ファイル編集は行わない |
| `text-writer` | テキストライター | 文章の作成・執筆（claude / sonnet）。Workspace では ReviewDoc JSON を返す |
| `planner` | 計画立案者 | Workspace の WorkPlan を作る専用職種（claude / opus）。ファイル編集禁止、出力は WorkPlan JSON のみ |
