// ============================================================
// AgentExecutor テスト
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentExecutor } from "../../src/agent/executor.js";
import type { StreamEvent } from "../../src/agent/parser.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// --------------------------------------------------
// child_process.spawn のモック
// --------------------------------------------------

/** モック ChildProcess を作成する */
function createMockChildProcess(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

// spawn モック — テスト内で mockChild を差し替えて使用
let mockChild: ReturnType<typeof createMockChildProcess>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => mockChild),
}));

describe("AgentExecutor", () => {
  let executor: AgentExecutor;

  beforeEach(() => {
    mockChild = createMockChildProcess();
    executor = new AgentExecutor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------
  // 起動テスト
  // --------------------------------------------------

  it("正しいコマンド引数で spawn を呼ぶ", async () => {
    const { spawn } = await import("node:child_process");

    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-001", {
      model: "claude-4-sonnet",
      prompt: "Hello world",
    }, callbacks);

    expect(spawn).toHaveBeenCalledWith(
      "agent",
      expect.arrayContaining([
        "-p", "--force",
        "-m", "claude-4-sonnet",
        "--output-format", "stream-json",
        "--stream-partial-output",
        "Hello world",
      ]),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("PID を返す", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    const pid = executor.execute("agent-002", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    expect(pid).toBe(12345);
  });

  it("workingDirectory を cwd に渡す", async () => {
    const { spawn } = await import("node:child_process");

    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-003", {
      model: "claude-4-sonnet",
      prompt: "test",
      workingDirectory: "/some/path",
    }, callbacks);

    expect(spawn).toHaveBeenCalledWith(
      "agent",
      expect.any(Array),
      expect.objectContaining({
        cwd: "/some/path",
      }),
    );
  });

  // --------------------------------------------------
  // stdout → StreamJsonParser パイプ
  // --------------------------------------------------

  it("stdout のデータを StreamJsonParser 経由で onStreamEvent に渡す", async () => {
    // ストリームパイプはリアルタイマーが必要
    vi.useRealTimers();

    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-004", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    // stdout に NDJSON データを流す
    mockChild.stdout.write(
      '{"type":"system","subtype":"init","data":{"model":"claude-4-sonnet","session_id":"s1"}}\n',
    );

    // パースは非同期なので少し待つ
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callbacks.onStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        subtype: "init",
      }),
    );

    // fake timers を戻す（afterEach で useRealTimers するため安全）
    vi.useFakeTimers();
  });

  // --------------------------------------------------
  // プロセス終了
  // --------------------------------------------------

  it("exit code 0 で正常終了時に onExit コールバックを呼ぶ", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-005", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    mockChild.emit("exit", 0, null);

    expect(callbacks.onExit).toHaveBeenCalledWith(0, null);
  });

  it("非0 exit code で終了時に onExit コールバックを呼ぶ", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-006", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    mockChild.emit("exit", 1, null);

    expect(callbacks.onExit).toHaveBeenCalledWith(1, null);
  });

  it("error イベント時に onError コールバックを呼ぶ", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-007", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    const error = new Error("spawn failed");
    mockChild.emit("error", error);

    expect(callbacks.onError).toHaveBeenCalledWith(error);
  });

  it("プロセス終了後に内部 Map からエントリが削除される", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-008", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    mockChild.emit("exit", 0, null);

    // kill を呼んでも何もしない（既に削除済み）
    executor.kill("agent-008");
    expect(mockChild.kill).not.toHaveBeenCalled();
  });

  // --------------------------------------------------
  // タイムアウト
  // --------------------------------------------------

  it("timeout_ms 経過後に SIGTERM を送信する", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-009", {
      model: "claude-4-sonnet",
      prompt: "test",
      timeout_ms: 10000,
    }, callbacks);

    // タイムアウト前は kill されない
    vi.advanceTimersByTime(9999);
    expect(mockChild.kill).not.toHaveBeenCalled();

    // タイムアウト到達で SIGTERM
    vi.advanceTimersByTime(1);
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("SIGTERM 後 5 秒でまだ生きていたら SIGKILL を送信する", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-010", {
      model: "claude-4-sonnet",
      prompt: "test",
      timeout_ms: 10000,
    }, callbacks);

    // タイムアウト到達 → SIGTERM
    vi.advanceTimersByTime(10000);
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");

    // 5秒後 → SIGKILL（プロセスがまだ生きている場合）
    vi.advanceTimersByTime(5000);
    expect(mockChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("正常終了時にタイムアウトタイマーがクリアされる", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-011", {
      model: "claude-4-sonnet",
      prompt: "test",
      timeout_ms: 10000,
    }, callbacks);

    // タイムアウト前に正常終了
    mockChild.emit("exit", 0, null);

    // タイムアウト時間が経過しても kill されない
    vi.advanceTimersByTime(15000);
    expect(mockChild.kill).not.toHaveBeenCalled();
  });

  // --------------------------------------------------
  // kill / killAll
  // --------------------------------------------------

  it("kill で指定 Agent のプロセスを SIGTERM で終了する", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-012", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    executor.kill("agent-012");

    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("存在しない Agent ID の kill は無視する", () => {
    // エラーなく実行できる
    executor.kill("nonexistent");
  });

  it("killAll で全プロセスを終了する", () => {
    const child1 = createMockChildProcess(111);
    const child2 = createMockChildProcess(222);

    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    // 1つ目のプロセス
    mockChild = child1;
    executor.execute("agent-013", {
      model: "claude-4-sonnet",
      prompt: "test1",
    }, callbacks);

    // 2つ目のプロセス
    mockChild = child2;
    executor.execute("agent-014", {
      model: "claude-4-sonnet",
      prompt: "test2",
    }, callbacks);

    executor.killAll();

    expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child2.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // --------------------------------------------------
  // stderr バッファリング
  // --------------------------------------------------

  it("stderr の出力をバッファリングする", () => {
    const callbacks = {
      onStreamEvent: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };

    executor.execute("agent-015", {
      model: "claude-4-sonnet",
      prompt: "test",
    }, callbacks);

    mockChild.stderr.write("warning: something\n");

    // stderr は直接コールバックに渡さないが、エラーにならない
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
