import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE_OUTPUT_TRUNCATED_MARKER,
  ShellGateCommandRunner,
  type GateCommandRunOptions,
} from "../../src/workspace/gate-runner.js";

/** プロセスが生きているか（ゾンビは死んだとみなす） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z";
  } catch {
    return true;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe("ShellGateCommandRunner", () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-runner-")));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = (o: Partial<GateCommandRunOptions> = {}): GateCommandRunOptions => ({
    cwd: dir,
    timeout_ms: 10_000,
    maxOutput_bytes: 1024 * 1024,
    ...o,
  });

  it("stdout / stderr と exit code 0 を返す", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("echo hello; echo oops 1>&2", opts());
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTail).toBe("hello\n");
    expect(r.stderrTail).toBe("oops\n");
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("0 以外の exit code をそのまま返す", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("exit 3", opts());
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("連結子を含むコマンドを sh -c で実行できる", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("echo a && echo b | tr b c", opts());
    expect(r.stdoutTail).toBe("a\nc\n");
  });

  it("cwd がカレントディレクトリになる", async () => {
    writeFileSync(join(dir, "marker.txt"), "x");
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("pwd && ls", opts());
    expect(r.stdoutTail).toContain(dir);
    expect(r.stdoutTail).toContain("marker.txt");
  });

  it("標準入力は閉じられている", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("cat; echo done", opts({ timeout_ms: 5000 }));
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTail).toBe("done\n");
  });

  it("env を渡せる", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("echo $GATE_TEST_VAR", opts({ env: { ...process.env, GATE_TEST_VAR: "v1" } }));
    expect(r.stdoutTail).toBe("v1\n");
  });

  it("タイムアウトで SIGTERM を送り timedOut: true にする", async () => {
    const runner = new ShellGateCommandRunner();
    const started = Date.now();
    const r = await runner.run("echo start; sleep 30", opts({ timeout_ms: 300 }));
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGTERM");
    expect(r.stdoutTail).toBe("start\n");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("SIGTERM を無視するコマンドは猶予後に SIGKILL する", async () => {
    const runner = new ShellGateCommandRunner({ killGrace_ms: 300 });
    const started = Date.now();
    const r = await runner.run("trap '' TERM; while true; do sleep 1; done", opts({ timeout_ms: 300 }));
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);

  it("大量出力は maxOutput_bytes に切り詰め、返却は末尾 4000 文字", async () => {
    const runner = new ShellGateCommandRunner();
    // 約 200 KB（"line N" を 30000 行）
    const r = await runner.run("i=0; while [ $i -lt 30000 ]; do echo line$i; i=$((i+1)); done; echo END", opts({ maxOutput_bytes: 10_000 }));
    expect(r.exitCode).toBe(0);
    expect(r.stdoutTail.length).toBeLessThanOrEqual(4000);
    expect(r.stdoutTail.endsWith("END\n")).toBe(true);
    expect(r.stdoutTail.startsWith(GATE_OUTPUT_TRUNCATED_MARKER)).toBe(true);
  }, 30_000);

  it("maxOutput_bytes が 4000 文字より小さければそこまで", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("head -c 5000 /dev/zero | tr '\\0' 'a'", opts({ maxOutput_bytes: 100 }));
    expect(r.stdoutTail.startsWith(GATE_OUTPUT_TRUNCATED_MARKER)).toBe(true);
    expect(r.stdoutTail.slice(GATE_OUTPUT_TRUNCATED_MARKER.length)).toBe("a".repeat(100));
  });

  it("切り捨てが無ければ印は付かない", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("echo hi", opts({ maxOutput_bytes: 100 }));
    expect(r.stdoutTail).toBe("hi\n");
  });

  it("4000 文字を超える出力は末尾 4000 文字", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("head -c 6000 /dev/zero | tr '\\0' 'a'; echo Z", opts());
    expect(r.stdoutTail.length).toBe(4000);
    expect(r.stdoutTail.endsWith("aZ\n")).toBe(true);
  });

  it("存在しない cwd は reject せず exitCode: null で返す", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("echo hi", opts({ cwd: join(dir, "no-such-dir") }));
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.stderrTail).toBe(`作業ディレクトリが存在しません: ${join(dir, "no-such-dir")}`);
  });

  it("存在しないコマンドは 127 で終わる", async () => {
    const runner = new ShellGateCommandRunner();
    const r = await runner.run("definitely-not-a-command-xyz", opts());
    expect(r.exitCode).toBe(127);
    expect(r.stderrTail.length).toBeGreaterThan(0);
  });
  it("バックグラウンドプロセスがパイプを握っていても、シェル終了後すぐ確定する", async () => {
    const runner = new ShellGateCommandRunner();
    const started = Date.now();
    const r = await runner.run("(sleep 20 &); echo done", opts({ timeout_ms: 3000 }));
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTail).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("シェル終了後に残った孫プロセスは片付ける", async () => {
    const runner = new ShellGateCommandRunner();
    const pidFile = join(dir, "bg.pid");
    await runner.run(`(sleep 25 & echo $! > ${pidFile}); echo ok`, opts());
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await waitDead(pid)).toBe(true);
  });

  it("タイムアウトで孫プロセスごと止める", async () => {
    const runner = new ShellGateCommandRunner();
    const pidFile = join(dir, "child.pid");
    const r = await runner.run(`sleep 30 & echo $! > ${pidFile}; wait`, opts({ timeout_ms: 300 }));
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(await waitDead(pid)).toBe(true);
  });

  describe("AbortSignal", () => {
    it("abort で SIGTERM を送り、timedOut: false・stderrTail に「中断」", async () => {
      const runner = new ShellGateCommandRunner();
      const ac = new AbortController();
      const p = runner.run("sleep 30", opts({ signal: ac.signal, timeout_ms: 20_000 }));
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      const r = await p;
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBe("SIGTERM");
      expect(r.stderrTail).toContain("中断");
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("SIGTERM を無視するコマンドは猶予後に SIGKILL する", async () => {
      const runner = new ShellGateCommandRunner({ killGrace_ms: 300 });
      const ac = new AbortController();
      const p = runner.run("trap '' TERM; while true; do sleep 1; done", opts({ signal: ac.signal }));
      setTimeout(() => ac.abort(), 200);
      const r = await p;
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBe("SIGKILL");
      expect(r.stderrTail).toContain("中断");
    }, 15_000);

    it("開始前に abort 済みなら実行しない", async () => {
      const runner = new ShellGateCommandRunner();
      const ac = new AbortController();
      ac.abort();
      const marker = join(dir, "should-not-exist.txt");
      const r = await runner.run(`touch ${marker}`, opts({ signal: ac.signal }));
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBe("SIGTERM");
      expect(r.stderrTail).toContain("中断");
      expect(() => readFileSync(marker)).toThrow();
    });

    it("正常終了したあとの abort は無害", async () => {
      const runner = new ShellGateCommandRunner();
      const ac = new AbortController();
      const r = await runner.run("echo ok", opts({ signal: ac.signal }));
      ac.abort();
      expect(r.exitCode).toBe(0);
    });
  });

  describe("killAll", () => {
    it("実行中のコマンドをすべて中断する", async () => {
      const runner = new ShellGateCommandRunner();
      const p1 = runner.run("sleep 30", opts({ timeout_ms: 20_000 }));
      const p2 = runner.run("sleep 30", opts({ timeout_ms: 20_000 }));
      setTimeout(() => runner.killAll(), 200);
      const [r1, r2] = await Promise.all([p1, p2]);
      for (const r of [r1, r2]) {
        expect(r.signal).toBe("SIGTERM");
        expect(r.timedOut).toBe(false);
        expect(r.stderrTail).toContain("中断");
      }
    });

    it("何も実行していなければ何もしない", () => {
      expect(() => new ShellGateCommandRunner().killAll()).not.toThrow();
    });
  });
});
