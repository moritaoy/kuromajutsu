// ============================================================
// Agent 実行: Provider CLI 実行・プロセス管理
// ============================================================
//
// 責務:
// - Provider（Cursor CLI / Claude Code CLI）のヘッドレスコマンドを子プロセスとして起動
// - 子プロセスの stdout を StreamJsonParser に渡してリアルタイム解析
// - Provider ごとのノーマライザで共通イベント形式に変換してから通知
// - タイムアウト処理（SIGTERM → 5秒後に SIGKILL）
// - プロセスの exit code 管理

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentProviderId } from "../types/index.js";
import { StreamJsonParser, type StreamEvent } from "./parser.js";
import { DEFAULT_PROVIDER_ID, getProvider } from "./providers/index.js";

// --------------------------------------------------
// 型定義
// --------------------------------------------------

export interface ExecutorOptions {
  /** 実行基盤（Provider）。省略時は cursor */
  provider?: AgentProviderId;
  /** 使用する LLM モデル名 */
  model: string;
  /** プロンプト（systemPrompt + "\n\n" + userPrompt） */
  prompt: string;
  /** 作業ディレクトリ */
  workingDirectory?: string;
  /** タイムアウト（ミリ秒） */
  timeout_ms?: number;
  /** kuromajutsu の HTTP MCP エンドポイント（Claude Provider がサブ Agent に渡す） */
  mcpUrl?: string;
  /** Claude Code の --permission-mode */
  permissionMode?: string;
}

export interface ExecutorCallbacks {
  /** stream-json イベント受信時のコールバック */
  onStreamEvent: (event: StreamEvent) => void;
  /** プロセス終了時のコールバック */
  onExit: (exitCode: number | null, signal: string | null) => void;
  /** エラー発生時のコールバック */
  onError: (error: Error) => void;
}

// --------------------------------------------------
// AgentExecutor
// --------------------------------------------------

/**
 * Provider の CLI をヘッドレスモードで子プロセスとして起動・管理するコンポーネント。
 */
export class AgentExecutor {
  /** 実行中プロセスの管理: agentId → ChildProcess */
  private processes: Map<string, ChildProcess>;
  /** タイムアウトタイマーの管理: agentId → NodeJS.Timeout */
  private timeouts: Map<string, NodeJS.Timeout>;

  constructor() {
    this.processes = new Map();
    this.timeouts = new Map();
  }

  // --------------------------------------------------
  // プロセス起動
  // --------------------------------------------------

  /**
   * Provider の CLI を起動する。
   * @returns 子プロセスの PID
   */
  execute(
    agentId: string,
    options: ExecutorOptions,
    callbacks: ExecutorCallbacks,
  ): number {
    // 1. Provider からコマンドを構築
    const provider = getProvider(options.provider ?? DEFAULT_PROVIDER_ID);
    const { command, args } = provider.buildExecCommand({
      model: options.model,
      prompt: options.prompt,
      mcpUrl: options.mcpUrl,
      permissionMode: options.permissionMode,
    });

    // 2. child_process.spawn で起動
    const child = spawn(command, args, {
      cwd: options.workingDirectory ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 3. stdout を StreamJsonParser にパイプし、Provider のノーマライザで共通イベントに変換
    const parser = new StreamJsonParser();
    const normalizer = provider.createNormalizer();
    parser.on("event", (raw: StreamEvent) => {
      for (const event of normalizer.normalize(raw)) {
        callbacks.onStreamEvent(event);
      }
    });
    // readable 側を flowing モードにしてバックプレッシャーを回避
    parser.resume();
    child.stdout?.pipe(parser);

    // 4. stderr をバッファに蓄積しつつログ出力
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      console.error(`[executor:${agentId}] stderr: ${text.trimEnd()}`);
    });

    // 5. プロセス終了ハンドリング
    child.on("exit", (code, signal) => {
      this.clearTimeout(agentId);
      this.processes.delete(agentId);
      callbacks.onExit(code, signal);
    });

    child.on("error", (err) => {
      this.clearTimeout(agentId);
      this.processes.delete(agentId);
      callbacks.onError(err);
    });

    // 6. プロセスを Map に登録
    this.processes.set(agentId, child);

    // 7. タイムアウト設定
    if (options.timeout_ms) {
      const timer = setTimeout(() => {
        this.kill(agentId);
      }, options.timeout_ms);
      this.timeouts.set(agentId, timer);
    }

    return child.pid!;
  }

  // --------------------------------------------------
  // プロセス終了
  // --------------------------------------------------

  /**
   * 実行中のプロセスを終了する。
   * SIGTERM → 5秒後にまだ生きていたら SIGKILL。
   */
  kill(agentId: string): void {
    const child = this.processes.get(agentId);
    if (!child) return;

    // SIGTERM を送信（graceful shutdown）
    child.kill("SIGTERM");

    // 5秒後にまだ生きていたら SIGKILL で強制終了
    setTimeout(() => {
      if (this.processes.has(agentId)) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }

  /**
   * 全プロセスを終了する（シャットダウン用）。
   */
  killAll(): void {
    for (const [agentId] of this.processes) {
      this.kill(agentId);
    }
  }

  // --------------------------------------------------
  // 内部ヘルパー
  // --------------------------------------------------

  /** タイムアウトタイマーをクリアする */
  private clearTimeout(agentId: string): void {
    const timer = this.timeouts.get(agentId);
    if (timer) {
      globalThis.clearTimeout(timer);
      this.timeouts.delete(agentId);
    }
  }
}
