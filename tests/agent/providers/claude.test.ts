// ============================================================
// Claude Provider テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { getProvider } from "../../../src/agent/providers/index.js";
import type { StreamEvent } from "../../../src/agent/parser.js";

const claude = getProvider("claude");

function ev(data: Record<string, unknown>): StreamEvent {
  return {
    type: data.type as StreamEvent["type"],
    subtype: data.subtype as StreamEvent["subtype"],
    data,
  };
}

describe("ClaudeProvider: コマンド構築", () => {
  it("プロンプトを -p の直後に置き、--mcp-config を最後に置く", () => {
    const cmd = claude.buildExecCommand({
      model: "sonnet",
      prompt: "do it",
      mcpUrl: "http://localhost:9696/mcp",
    });
    expect(cmd.command).toBe("claude");
    expect(cmd.args.slice(0, 2)).toEqual(["-p", "do it"]);
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        "--model", "sonnet",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
      ]),
    );
    // --mcp-config は可変長引数なので最後尾
    const idx = cmd.args.indexOf("--mcp-config");
    expect(idx).toBe(cmd.args.length - 2);
    expect(JSON.parse(cmd.args[idx + 1])).toEqual({
      mcpServers: { kuromajutsu: { type: "http", url: "http://localhost:9696/mcp" } },
    });
  });

  it("permissionMode を指定できる", () => {
    const cmd = claude.buildExecCommand({
      model: "opus",
      prompt: "p",
      permissionMode: "acceptEdits",
    });
    expect(cmd.args[cmd.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("mcpUrl 未指定なら --mcp-config を付けない", () => {
    const cmd = claude.buildExecCommand({ model: "opus", prompt: "p" });
    expect(cmd.args).not.toContain("--mcp-config");
  });

  it("ヘルスチェックコマンドは claude -p {prompt} --model", () => {
    expect(claude.buildHealthCheckCommand("haiku", "hello")).toEqual({
      command: "claude",
      args: ["-p", "hello", "--model", "haiku"],
    });
  });
});

describe("ClaudeProvider: モデル検証", () => {
  it("モデル一覧コマンドを持たず、静的エイリアスを返す", () => {
    expect(claude.buildListModelsCommand()).toBeNull();
    expect(claude.staticModels).toEqual(
      expect.arrayContaining(["sonnet", "opus", "haiku"]),
    );
  });

  it("エイリアスと claude-* の完全 ID を許可する", () => {
    expect(claude.isModelAvailable("sonnet", claude.staticModels)).toBe(true);
    expect(claude.isModelAvailable("claude-sonnet-4-5-20250929", claude.staticModels)).toBe(true);
    expect(claude.isModelAvailable("gpt-5.5-high", claude.staticModels)).toBe(false);
    expect(claude.isModelAvailable("composer-2.5-fast", claude.staticModels)).toBe(false);
  });
});

describe("ClaudeProvider: ノーマライザ", () => {
  it("system init はそのまま通す", () => {
    const n = claude.createNormalizer();
    const out = n.normalize(ev({ type: "system", subtype: "init", model: "claude-haiku-4-5" }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("system");
    expect(out[0].subtype).toBe("init");
  });

  it("assistant の text ブロックを message.content[0].text に集約する", () => {
    const n = claude.createNormalizer();
    const out = n.normalize(
      ev({
        type: "assistant",
        message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("assistant");
    const msg = out[0].data.message as { content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("A\nB");
  });

  it("thinking ブロックは thinking イベントになる", () => {
    const n = claude.createNormalizer();
    const out = n.normalize(
      ev({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    );
    expect(out.map((e) => e.type)).toEqual(["thinking"]);
  });

  it("tool_use → tool_call started、tool_result → tool_call completed（Edit は editToolCall）", () => {
    const n = claude.createNormalizer();
    const started = n.normalize(
      ev({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "/a/b.ts", old_string: "x", new_string: "y" } },
          ],
        },
      }),
    );
    expect(started).toHaveLength(1);
    expect(started[0].type).toBe("tool_call");
    expect(started[0].subtype).toBe("started");
    expect(started[0].data.call_id).toBe("tu_1");
    const startedCall = started[0].data.tool_call as Record<string, { args: Record<string, unknown> }>;
    expect(Object.keys(startedCall)).toEqual(["editToolCall"]);
    expect(startedCall.editToolCall.args.path).toBe("/a/b.ts");

    const completed = n.normalize(
      ev({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
      }),
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].subtype).toBe("completed");
    expect(completed[0].data.call_id).toBe("tu_1");
    const doneCall = completed[0].data.tool_call as Record<
      string,
      { args: Record<string, unknown>; result: { success?: unknown } }
    >;
    expect(doneCall.editToolCall.args.path).toBe("/a/b.ts");
    expect(doneCall.editToolCall.result.success).toBeTruthy();
  });

  it("Write / NotebookEdit も editToolCall として path を引き継ぐ", () => {
    const n = claude.createNormalizer();
    const [w] = n.normalize(
      ev({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/n.ts", content: "" } }] },
      }),
    );
    expect(Object.keys(w.data.tool_call as object)).toEqual(["editToolCall"]);
    const [nb] = n.normalize(
      ev({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "nb", name: "NotebookEdit", input: { notebook_path: "/n.ipynb" } }] },
      }),
    );
    const call = nb.data.tool_call as Record<string, { args: { path: string } }>;
    expect(call.editToolCall.args.path).toBe("/n.ipynb");
  });

  it("Read / Bash / その他のツール名を対応付ける", () => {
    const n = claude.createNormalizer();
    const names = ["Read", "Bash", "Grep", "Glob", "mcp__kuromajutsu__report_result"].map((name, i) => {
      const [e] = n.normalize(
        ev({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: `t${i}`, name, input: {} }] },
        }),
      );
      return Object.keys(e.data.tool_call as object)[0];
    });
    expect(names).toEqual([
      "readToolCall",
      "shellToolCall",
      "grepToolCall",
      "globToolCall",
      "mcp__kuromajutsu__report_resultToolCall",
    ]);
  });

  it("is_error の tool_result は result.error になり success を持たない", () => {
    const n = claude.createNormalizer();
    n.normalize(
      ev({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x" } }] },
      }),
    );
    const [done] = n.normalize(
      ev({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "boom", is_error: true }] },
      }),
    );
    const call = done.data.tool_call as Record<string, { result: { success?: unknown; error?: unknown } }>;
    expect(call.editToolCall.result.success).toBeUndefined();
    expect(call.editToolCall.result.error).toBeTruthy();
  });

  it("1 つの assistant メッセージ内の text と複数 tool_use を順に展開する", () => {
    const n = claude.createNormalizer();
    const out = n.normalize(
      ev({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "go" },
            { type: "tool_use", id: "a", name: "Read", input: { file_path: "/1" } },
            { type: "tool_use", id: "b", name: "Read", input: { file_path: "/2" } },
          ],
        },
      }),
    );
    expect(out.map((e) => `${e.type}:${e.subtype ?? ""}`)).toEqual([
      "assistant:",
      "tool_call:started",
      "tool_call:started",
    ]);
  });

  it("result success は duration_ms を引き継ぎ、is_error は subtype error になる", () => {
    const n = claude.createNormalizer();
    const [ok] = n.normalize(ev({ type: "result", subtype: "success", is_error: false, duration_ms: 1234, result: "OK" }));
    expect(ok.type).toBe("result");
    expect(ok.subtype).toBe("success");
    expect(ok.data.duration_ms).toBe(1234);

    const [err] = n.normalize(ev({ type: "result", subtype: "success", is_error: true, duration_ms: 5 }));
    expect(err.subtype).toBe("error");
    const [err2] = n.normalize(ev({ type: "result", subtype: "error_during_execution", is_error: true }));
    expect(err2.subtype).toBe("error");
  });

  it("未知のイベント（stream_event 等）は無視する", () => {
    const n = claude.createNormalizer();
    expect(n.normalize(ev({ type: "stream_event", event: {} }))).toEqual([]);
    expect(n.normalize(ev({ type: "rate_limit_event" }))).toEqual([]);
  });

  it("対応する tool_use が無い tool_result でも落ちない", () => {
    const n = claude.createNormalizer();
    const out = n.normalize(
      ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zzz", content: "x" }] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].subtype).toBe("completed");
  });
});
