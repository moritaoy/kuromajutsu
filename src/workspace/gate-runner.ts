// ============================================================
// ゲートの command チェックの実行（docs/spec.md §13.5.3）
//
// - `sh -c` で作業ディレクトリをカレントにして実行する。標準入力は閉じる
// - stdout / stderr はそれぞれ末尾 `maxOutput_bytes` だけ保持し、結果には末尾 4000 文字を返す
//   （切り捨てがあれば先頭に `…(truncated)` を付ける）
// - タイムアウトで SIGTERM、猶予（既定 5 秒）後にまだ生きていれば SIGKILL（プロセスグループごと）
// - `signal`（AbortSignal）で中断できる。`killAll()` と process の exit フックで残りを止める
// - 禁止パターンの検証は呼び出し側（gate-commands.ts）が行う。ここでは実行のみ
// ============================================================

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

export interface GateCommandRunOptions {
  cwd: string;
  timeout_ms: number;
  maxOutput_bytes: number;
  env?: NodeJS.ProcessEnv;
  /** abort すると SIGTERM → 猶予後に SIGKILL。結果は `timedOut: false`、stderrTail に「中断」 */
  signal?: AbortSignal;
}

export interface GateCommandRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  duration_ms: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface GateCommandRunner {
  run(command: string, opts: GateCommandRunOptions): Promise<GateCommandRunResult>;
}

/** 結果に入れる出力の最大文字数（末尾） */
export const GATE_OUTPUT_TAIL_CHARS = 4000;

/** 出力を切り捨てたときに先頭へ付ける印 */
export const GATE_OUTPUT_TRUNCATED_MARKER = "…(truncated)\n";

/** SIGTERM から SIGKILL までの猶予（executor.ts と同じ 5 秒） */
const DEFAULT_KILL_GRACE_MS = 5000;

/** SIGKILL 後 / プロセス終了後に、ストリームの close を待つ最大時間（孫プロセスがパイプを握り続けた場合の保険） */
const CLOSE_WAIT_MS = 1000;

// --------------------------------------------------
// 起動中のプロセスグループ（process の exit 時に同期で SIGKILL する）
// --------------------------------------------------

const activeGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of activeGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 既に無い
      }
    }
  });
}

/** プロセスグループにシグナルを送る（グループが無ければ無視）。送れたら true */
function killGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------
// 末尾バッファ
// --------------------------------------------------

/** 末尾 `limit` バイトだけを保持するバッファ */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.limit <= 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - this.chunks[0].length >= this.limit) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  /** 末尾 `chars` 文字（切り捨てがあれば先頭に印を付け、全体で `chars` 文字以内） */
  tail(chars: number): string {
    const truncated = this.total > this.limit;
    const all = Buffer.concat(this.chunks);
    const kept = all.length > this.limit ? all.subarray(all.length - this.limit) : all;
    const text = kept.toString("utf8");
    if (!truncated) return text.length > chars ? text.slice(text.length - chars) : text;
    const room = Math.max(0, chars - GATE_OUTPUT_TRUNCATED_MARKER.length);
    const body = text.length > room ? text.slice(text.length - room) : text;
    return GATE_OUTPUT_TRUNCATED_MARKER + body;
  }
}

// --------------------------------------------------
// 実行
// --------------------------------------------------

export class ShellGateCommandRunner implements GateCommandRunner {
  private readonly killGrace_ms: number;
  /** 実行中のプロセスグループ → 中断関数 */
  private readonly active = new Map<number, () => void>();

  constructor(options: { killGrace_ms?: number } = {}) {
    this.killGrace_ms = options.killGrace_ms ?? DEFAULT_KILL_GRACE_MS;
  }

  /** 実行中のコマンドをすべて中断する（SIGTERM → 猶予後に SIGKILL） */
  killAll(): void {
    for (const abort of [...this.active.values()]) abort();
  }

  run(command: string, opts: GateCommandRunOptions): Promise<GateCommandRunResult> {
    return new Promise<GateCommandRunResult>((resolve) => {
      const startedAt = Date.now();
      const stdout = new TailBuffer(opts.maxOutput_bytes);
      const stderr = new TailBuffer(opts.maxOutput_bytes);
      let extraStderr = "";
      let timedOut = false;
      let settled = false;
      let terminating = false;
      let lastSignal: string | null = null;
      let child: ChildProcess | undefined;
      let groupPid: number | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let exitTimer: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        extraStderr = extraStderr || "中断されました";
        terminate();
      };

      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        for (const t of [timeoutTimer, killTimer, forceTimer, exitTimer]) if (t) clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
        if (groupPid !== undefined) {
          this.active.delete(groupPid);
          activeGroups.delete(groupPid);
        }
        // 孫プロセスがパイプを握っていても、これ以上は待たない
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        let stderrTail = stderr.tail(GATE_OUTPUT_TAIL_CHARS);
        if (extraStderr) {
          stderrTail = (stderrTail ? stderrTail + "\n" : "") + extraStderr;
          if (stderrTail.length > GATE_OUTPUT_TAIL_CHARS) {
            stderrTail = stderrTail.slice(stderrTail.length - GATE_OUTPUT_TAIL_CHARS);
          }
        }
        resolve({
          exitCode,
          signal,
          timedOut,
          duration_ms: Date.now() - startedAt,
          stdoutTail: stdout.tail(GATE_OUTPUT_TAIL_CHARS),
          stderrTail,
        });
      };

      const signalGroup = (sig: NodeJS.Signals): void => {
        lastSignal = sig;
        if (groupPid !== undefined && killGroup(groupPid, sig)) return;
        try {
          child?.kill(sig);
        } catch {
          // 既に終了している
        }
      };

      /** SIGTERM → 猶予後に SIGKILL（タイムアウト・中断で共通） */
      const terminate = (): void => {
        if (terminating || settled) return;
        terminating = true;
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          forceTimer = setTimeout(() => finish(null, "SIGKILL"), CLOSE_WAIT_MS);
        }, this.killGrace_ms);
      };

      // 開始前に中断されている
      if (opts.signal?.aborted) {
        extraStderr = "中断されました（開始前）";
        lastSignal = "SIGTERM";
        finish(null, "SIGTERM");
        return;
      }

      // 作業ディレクトリの確認（spawn の ENOENT は sh 不在と区別できないため先に見る）
      let cwdIsDir = false;
      try {
        cwdIsDir = statSync(opts.cwd).isDirectory();
      } catch {
        cwdIsDir = false;
      }
      if (!cwdIsDir) {
        extraStderr = `作業ディレクトリが存在しません: ${opts.cwd}`;
        finish(null, null);
        return;
      }

      try {
        child = spawn("sh", ["-c", command], {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          // プロセスグループを分け、タイムアウト時に孫プロセスごと止める
          detached: true,
        });
      } catch (err) {
        extraStderr = `spawn に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
        finish(null, null);
        return;
      }

      if (child.pid !== undefined) {
        groupPid = child.pid;
        this.active.set(groupPid, onAbort);
        activeGroups.add(groupPid);
        installExitHook();
      }

      child.stdout?.on("data", (c: Buffer) => stdout.push(c));
      child.stderr?.on("data", (c: Buffer) => stderr.push(c));

      child.on("error", (err) => {
        extraStderr = `spawn に失敗しました: ${err.message}`;
        finish(null, null);
      });

      child.on("exit", (code, signal) => {
        // シェルが終わったあとに残ったバックグラウンドプロセスを片付ける
        if (groupPid !== undefined) killGroup(groupPid, "SIGTERM");
        // close（パイプの終端）が来なくても、短い猶予で確定する
        exitTimer = setTimeout(
          () => finish(code, signal ?? (code === null ? lastSignal : null)),
          CLOSE_WAIT_MS,
        );
      });

      child.on("close", (code, signal) => {
        finish(code, signal ?? (code === null ? lastSignal : null));
      });

      opts.signal?.addEventListener("abort", onAbort, { once: true });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeout_ms);
    });
  }
}
