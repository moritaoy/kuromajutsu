// ============================================================
// Kuromajutsu 共通型定義
// ============================================================

// --------------------------------------------------
// グループ (Group)
// --------------------------------------------------

/** グループのステータス */
export type GroupStatus = "active" | "deleted";

/** グループ定義 */
export interface GroupDefinition {
  /** 一意識別子（`grp-{unixTimestamp}-{random4hex}` 形式） */
  id: string;
  /** グループの目的の簡潔な説明 */
  description: string;
  /** グループのステータス */
  status: GroupStatus;
  /** 作成日時（ISO 8601） */
  createdAt: string;
  /** 所属する Agent ID の一覧 */
  agentIds: string[];
}

// --------------------------------------------------
// 職種 (Role)
// --------------------------------------------------

/** 職種定義 */
export interface RoleDefinition {
  /** 一意識別子 */
  id: string;
  /** 表示名 */
  name: string;
  /** Agent に渡すシステムプロンプト */
  systemPrompt: string;
  /** 使用する LLM モデル名（Cursor CLI の -m オプションに渡す値） */
  model: string;
  /** 使用可能なツール ID の一覧（ツールレジストリで定義されたツールを参照） */
  tools?: string[];
  /** ヘルスチェック時に使用する簡易テストプロンプト */
  healthCheckPrompt: string;
}

// --------------------------------------------------
// ロールツール定義（Agent に提供する外部ツール）
// --------------------------------------------------

/**
 * Agent が利用可能な外部ツールの定義。
 * ツールは Agent のプロンプトに使用方法として注入され、
 * Agent が Shell 経由で実行する。
 */
export interface RoleToolDefinition {
  /** ツール ID（roles[].tools で参照する値） */
  id: string;
  /** 表示名 */
  name: string;
  /** ツールの概要説明 */
  description: string;
  /** Agent のプロンプトに注入する使用方法の説明（Markdown 形式） */
  promptInstructions: string;
  /** ヘルスチェック用コマンド（ツールが利用可能か検証する） */
  healthCheckCommand?: { command: string; args: string[] };
}

// --------------------------------------------------
// Agent 状態
// --------------------------------------------------

/** Agent のステータス */
export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timedOut"
  | "resultReported";

/** Agent の内部管理状態 */
export interface AgentState {
  /** Agent ID（`{role}-{timestamp}-{random4hex}` 形式） */
  agentId: string;
  /** 所属グループ ID */
  groupId: string;
  /** 職種 ID */
  role: string;
  /** 使用モデル */
  model: string;
  /** 現在のステータス */
  status: AgentStatus;
  /** 開始日時（ISO 8601） */
  startedAt: string;
  /** 経過時間（ミリ秒） */
  elapsed_ms: number;
  /** ツール呼び出し回数 */
  toolCallCount: number;
  /** 最新のアシスタントメッセージ */
  lastAssistantMessage?: string;
  /** 直近のツール呼び出し履歴 */
  recentToolCalls: ToolCallRecord[];
  /** 実行結果（完了後に設定） */
  result: AgentResult | null;
  /** 呼び出し時のユーザープロンプト */
  prompt?: string;
  /** 子プロセス PID */
  pid?: number;
  /** 編集したファイル一覧（stream-json から自動収集） */
  editedFiles: string[];
  /** 新規作成したファイル一覧（stream-json から自動収集） */
  createdFiles: string[];
}

/** ツール呼び出し記録 */
export interface ToolCallRecord {
  callId: string;
  type: string;
  subtype: string;
  args?: Record<string, unknown>;
}

// --------------------------------------------------
// Agent 実行結果
// --------------------------------------------------

/** 結果ステータス */
export type ResultStatus = "success" | "failure" | "timeout" | "cancelled";

/** Agent 実行結果 */
export interface AgentResult {
  /** Agent ID */
  agentId: string;
  /** 所属グループ ID */
  groupId: string;
  /** 実行ステータス */
  status: ResultStatus;
  /** 端的なテキストサマリ */
  summary: string;
  /** 編集したファイルパス一覧 */
  editedFiles: string[];
  /** 新規作成したファイルパス一覧 */
  createdFiles: string[];
  /** 実行所要時間（ミリ秒） */
  duration_ms: number;
  /** 使用モデル */
  model: string;
  /** 職種 ID */
  role: string;
  /** ツール呼び出し回数 */
  toolCallCount: number;
  /** 失敗時のエラーメッセージ */
  errorMessage?: string;
  /** 生の Agent 出力テキスト（オプション） */
  rawOutput?: string;
  /** 完了時刻（ISO 8601） */
  timestamp: string;
}

// --------------------------------------------------
// ヘルスチェック
// --------------------------------------------------

/** モデル検証ステータス */
export type ModelValidationStatus = "valid" | "invalid";

/** ヘルスチェックステータス */
export type HealthCheckStatus = "passed" | "failed" | "skipped";

/** ツールチェック結果 */
export interface ToolCheckResult {
  /** ツール ID */
  toolId: string;
  /** チェック結果 */
  status: "passed" | "failed";
  /** 失敗理由 */
  reason?: string;
}

/** ヘルスチェック結果 */
export interface HealthCheckResult {
  /** チェック対象の職種 ID */
  roleId: string;
  /** モデル検証結果 */
  modelValidation: {
    status: ModelValidationStatus;
    message?: string;
    checkedAt: string;
    availableModels?: string[];
  };
  /** ヘルスチェック結果 */
  healthCheck: {
    status: HealthCheckStatus;
    reason?: string;
    responseTime_ms?: number;
    checkedAt?: string;
  };
  /** ツールチェック結果（職種にツールが設定されている場合のみ） */
  toolChecks?: ToolCheckResult[];
  /** この職種が利用可能かどうか */
  available: boolean;
}

// --------------------------------------------------
// 設定ファイル
// --------------------------------------------------

/** ダッシュボード設定 */
export interface DashboardConfig {
  port: number;
}

/** Agent 実行設定 */
export interface AgentConfig {
  defaultTimeout_ms?: number;
  maxConcurrent: number;
}

/** ログ設定 */
export interface LogConfig {
  level: "debug" | "info" | "warn" | "error";
}

/** アプリケーション設定全体 */
export interface AppConfig {
  dashboard: DashboardConfig;
  agent: AgentConfig;
  log: LogConfig;
  roles: RoleDefinition[];
}

// --------------------------------------------------
// WebSocket イベント
// --------------------------------------------------

/** サーバー → クライアント イベント */
export type ServerEvent =
  | { type: "server:startup"; data: { startedAt: string; availableModels: string[] } }
  | { type: "healthcheck:model_validation"; data: { results: HealthCheckResult[] } }
  | { type: "healthcheck:role_start"; data: { roleId: string } }
  | { type: "healthcheck:role_complete"; data: HealthCheckResult }
  | { type: "healthcheck:complete"; data: { results: HealthCheckResult[] } }
  | { type: "group:created"; data: GroupDefinition }
  | { type: "group:deleted"; data: { groupId: string } }
  | { type: "agent:created"; data: AgentState }
  | { type: "agent:status_update"; data: Partial<AgentState> & { agentId: string } }
  | { type: "agent:completed"; data: AgentState }
  | { type: "agent:result_reported"; data: AgentResult }
  | { type: "config:updated"; data: AppConfig };

/** クライアント → サーバー イベント */
export type ClientEvent =
  | { type: "config:update_role"; data: Partial<RoleDefinition> & { id: string } }
  | { type: "config:revalidate_model"; data: { roleId: string } };
