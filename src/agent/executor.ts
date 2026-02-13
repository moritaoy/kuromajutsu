// ============================================================
// Agent 実行: Cursor CLI 実行・プロセス管理
// ============================================================
//
// 責務:
// - Cursor CLI をヘッドレスモード（agent -p --force）で子プロセスとして起動
// - --output-format stream-json --stream-partial-output オプション付与
// - 子プロセスの stdout を StreamJsonParser に渡してリアルタイム解析
// - タイムアウト処理（SIGTERM → 5秒後に SIGKILL）
// - プロセスの exit code 管理

import { spawn, type ChildProcess } from "node:child_process";
import { StreamJsonParser, type StreamEvent } from "./parser.js";

// --------------------------------------------------
// 型定義
// --------------------------------------------------

export interface ExecutorOptions {
  /** 使用する LLM モデル名 */
  model: string;
  /** プロンプト（systemPrompt + "\n\n" + userPrompt） */
  prompt: string;
  /** 作業ディレクトリ */
  workingDirectory?: string;
  /** タイムアウト（ミリ秒） */
  timeout_ms?: number;
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
 * Cursor CLI をヘッドレスモードで子プロセスとして起動・管理するコンポーネント。
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
   * Cursor CLI を起動する。
   * @returns 子プロセスの PID
   */
  execute(
    agentId: string,
    options: ExecutorOptions,
    callbacks: ExecutorCallbacks,
  ): number {
    // 1. コマンド引数を構築
    const args = [
      "-p",
      "--force",
      "-m",
      options.model,
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      options.prompt,
    ];

    // 2. child_process.spawn で起動
    const child = spawn("agent", args, {
      cwd: options.workingDirectory ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 3. stdout を StreamJsonParser にパイプ
    const parser = new StreamJsonParser();
    parser.on("event", callbacks.onStreamEvent);
    // readable 側を flowing モードにしてバックプレッシャーを回避
    parser.resume();
    child.stdout?.pipe(parser);

    // 4. stderr をバッファに蓄積（ログ用）
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
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
