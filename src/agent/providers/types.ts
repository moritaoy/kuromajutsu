// ============================================================
// Agent Provider 抽象
// ============================================================
//
// 責務:
// - Agent 実行基盤（Cursor CLI / Claude Code CLI）の差異を吸収する
// - CLI コマンドの組み立て（実行・ヘルスチェック・モデル一覧）
// - モデル検証ルール
// - Provider 固有の stream-json を共通イベント形式（Cursor 形式）へ正規化

import type { AgentProviderId } from "../../types/index.js";
import type { StreamEvent } from "../parser.js";

/** 起動する CLI コマンド */
export interface ProviderCommand {
  command: string;
  args: string[];
}

/** Agent 実行コマンドの組み立てオプション */
export interface ExecCommandOptions {
  model: string;
  prompt: string;
  /** kuromajutsu の HTTP MCP エンドポイント（Claude がサブ Agent から report_result を呼ぶために使用） */
  mcpUrl?: string;
  /** Claude Code の --permission-mode */
  permissionMode?: string;
}

/** Provider 固有イベントを共通イベント形式に変換するステートフルなノーマライザ（Agent ごとに 1 インスタンス） */
export interface StreamNormalizer {
  normalize(event: StreamEvent): StreamEvent[];
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  /** 静的に既知のモデル一覧（モデル一覧コマンドを持たない Provider 用） */
  readonly staticModels: string[];

  /** Agent 実行コマンド */
  buildExecCommand(options: ExecCommandOptions): ProviderCommand;
  /** ヘルスチェック用コマンド */
  buildHealthCheckCommand(model: string, prompt: string): ProviderCommand;
  /** モデル一覧取得コマンド（無ければ null） */
  buildListModelsCommand(): ProviderCommand | null;
  /** モデル一覧コマンドの stdout をモデル ID 配列にパースする */
  parseModelList(stdout: string): string[];
  /** model が利用可能か（available は取得済みの一覧） */
  isModelAvailable(model: string, available: string[]): boolean;
  /** Provider 固有イベント → 共通イベント */
  createNormalizer(): StreamNormalizer;
}
