// ============================================================
// StreamJsonParser テスト
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { StreamJsonParser, type StreamEvent } from "../../src/agent/parser.js";

/** ヘルパー: パーサーにデータを流してイベントを収集する */
function collectEvents(parser: StreamJsonParser, data: string): Promise<StreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: StreamEvent[] = [];
    parser.on("event", (event: StreamEvent) => events.push(event));
    parser.on("end", () => resolve(events));
    parser.on("error", reject);

    // readable 側を flowing モードにしてバックプレッシャーを回避
    parser.resume();

    parser.write(data);
    parser.end();
  });
}

describe("StreamJsonParser", () => {
  // --------------------------------------------------
  // 正常系: 各イベントタイプのパース
  // --------------------------------------------------

  it("system init イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"system","subtype":"init","data":{"model":"claude-4-sonnet","session_id":"abc123"}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
    expect(events[0].subtype).toBe("init");
    expect(events[0].data.model).toBe("claude-4-sonnet");
    expect(events[0].data.session_id).toBe("abc123");
  });

  it("user イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"user","data":{"message":"Hello world"}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
    expect(events[0].data.message).toBe("Hello world");
  });

  it("assistant イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"assistant","data":{"message":"I will help you."}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].data.message).toBe("I will help you.");
  });

  it("tool_call started イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"started","data":{"callId":"call-1","toolName":"read","args":{"path":"src/index.ts"}}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].subtype).toBe("started");
    expect(events[0].data.callId).toBe("call-1");
    expect(events[0].data.toolName).toBe("read");
  });

  it("tool_call completed イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","data":{"callId":"call-1","toolName":"write","args":{"path":"src/foo.ts"}}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].subtype).toBe("completed");
    expect(events[0].data.toolName).toBe("write");
  });

  it("result success イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"result","subtype":"success","data":{"duration_ms":5000,"message":"Done"}}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("result");
    expect(events[0].subtype).toBe("success");
    expect(events[0].data.duration_ms).toBe(5000);
  });

  // --------------------------------------------------
  // NDJSON 複数行パース
  // --------------------------------------------------

  it("複数行の NDJSON を一度にパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = [
      '{"type":"system","subtype":"init","data":{"model":"claude-4-sonnet","session_id":"s1"}}',
      '{"type":"user","data":{"message":"Hello"}}',
      '{"type":"assistant","data":{"message":"Hi"}}',
      '{"type":"result","subtype":"success","data":{"duration_ms":1000}}',
    ].join("\n") + "\n";

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("user");
    expect(events[2].type).toBe("assistant");
    expect(events[3].type).toBe("result");
  });

  // --------------------------------------------------
  // チャンク境界（不完全な行のバッファリング）
  // --------------------------------------------------

  it("チャンク境界で分割された行を正しくバッファリングする", async () => {
    const parser = new StreamJsonParser();
    const events: StreamEvent[] = [];
    parser.on("event", (event: StreamEvent) => events.push(event));

    const fullLine = '{"type":"system","subtype":"init","data":{"model":"claude-4-sonnet","session_id":"s1"}}';

    // 行を中途半端な位置で分割して流す
    const mid = Math.floor(fullLine.length / 2);
    const chunk1 = fullLine.slice(0, mid);
    const chunk2 = fullLine.slice(mid) + "\n";

    await new Promise<void>((resolve) => {
      parser.write(chunk1, () => {
        parser.write(chunk2, () => {
          parser.end(() => resolve());
        });
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
    expect(events[0].data.model).toBe("claude-4-sonnet");
  });

  // --------------------------------------------------
  // flush: 最後の改行なしデータ
  // --------------------------------------------------

  it("最後の改行なしデータも flush 時にパースする", async () => {
    const parser = new StreamJsonParser();
    // 改行なしで終わるデータ
    const data = '{"type":"result","subtype":"success","data":{"duration_ms":999}}';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("result");
    expect(events[0].data.duration_ms).toBe(999);
  });

  // --------------------------------------------------
  // 不正な JSON
  // --------------------------------------------------

  it("不正な JSON 行をスキップし、他の行は正常にパースする", async () => {
    const parser = new StreamJsonParser();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const data = [
      '{"type":"system","subtype":"init","data":{"model":"m1","session_id":"s1"}}',
      "this is not json",
      '{"type":"result","subtype":"success","data":{"duration_ms":100}}',
    ].join("\n") + "\n";

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("result");
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("空行をスキップする", async () => {
    const parser = new StreamJsonParser();
    const data = '\n\n{"type":"user","data":{"message":"hello"}}\n\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
  });

  // --------------------------------------------------
  // writeToolCall 検出
  // --------------------------------------------------

  it("write ツール呼び出しから createdFiles を抽出できる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","data":{"callId":"c1","toolName":"write","args":{"path":"src/new-file.ts"}}}\n';

    const events = await collectEvents(parser, data);

    const fileChanges = parser.extractFileChanges(events[0]);
    expect(fileChanges.createdFiles).toContain("src/new-file.ts");
    expect(fileChanges.editedFiles).toHaveLength(0);
  });

  it("edit ツール呼び出しから editedFiles を抽出できる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","data":{"callId":"c2","toolName":"edit","args":{"path":"src/existing.ts"}}}\n';

    const events = await collectEvents(parser, data);

    const fileChanges = parser.extractFileChanges(events[0]);
    expect(fileChanges.editedFiles).toContain("src/existing.ts");
    expect(fileChanges.createdFiles).toHaveLength(0);
  });

  it("非ファイル操作ツールでは空配列を返す", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","data":{"callId":"c3","toolName":"read","args":{"path":"src/foo.ts"}}}\n';

    const events = await collectEvents(parser, data);

    const fileChanges = parser.extractFileChanges(events[0]);
    expect(fileChanges.editedFiles).toHaveLength(0);
    expect(fileChanges.createdFiles).toHaveLength(0);
  });

  // --------------------------------------------------
  // push（readable ストリームとして）
  // --------------------------------------------------

  it("readable ストリームとしてオブジェクトを push する", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"user","data":{"message":"test"}}\n';

    const objects: StreamEvent[] = [];
    parser.on("data", (obj: StreamEvent) => objects.push(obj));

    await new Promise<void>((resolve) => {
      parser.write(data, () => {
        parser.end(() => resolve());
      });
    });

    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("user");
  });
});
