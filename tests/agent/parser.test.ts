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
  // 正常系: 各イベントタイプのパース（実際の Cursor CLI 出力形式）
  // --------------------------------------------------

  it("system init イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/home/user/project","session_id":"abc123","model":"Composer 1.5","permissionMode":"default"}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
    expect(events[0].subtype).toBe("init");
    expect(events[0].data.model).toBe("Composer 1.5");
    expect(events[0].data.session_id).toBe("abc123");
  });

  it("user イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello world"}]},"session_id":"abc123"}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
    const message = events[0].data.message as { content: Array<{ text: string }> };
    expect(message.content[0].text).toBe("Hello world");
  });

  it("assistant イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will help you."}]},"session_id":"abc123"}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    const message = events[0].data.message as { content: Array<{ text: string }> };
    expect(message.content[0].text).toBe("I will help you.");
  });

  it("thinking イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = [
      '{"type":"thinking","subtype":"delta","text":"考え中...","session_id":"abc123","timestamp_ms":1700000000000}',
      '{"type":"thinking","subtype":"completed","session_id":"abc123","timestamp_ms":1700000000100}',
    ].join("\n") + "\n";

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("thinking");
    expect(events[0].subtype).toBe("delta");
    expect(events[0].data.text).toBe("考え中...");
    expect(events[1].subtype).toBe("completed");
  });

  it("tool_call started イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"started","call_id":"tool_abc123","tool_call":{"editToolCall":{"args":{"path":"src/index.ts","streamContent":"console.log()"}}},"session_id":"s1"}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].subtype).toBe("started");
    expect(events[0].data.call_id).toBe("tool_abc123");
    const toolCall = events[0].data.tool_call as Record<string, Record<string, unknown>>;
    expect(toolCall.editToolCall).toBeDefined();
  });

  it("tool_call completed イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","call_id":"tool_abc123","tool_call":{"editToolCall":{"args":{"path":"src/foo.ts","streamContent":"test"},"result":{"success":{"path":"src/foo.ts","linesAdded":1,"linesRemoved":0}}}},"session_id":"s1"}\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].subtype).toBe("completed");
    const toolCall = events[0].data.tool_call as Record<string, Record<string, unknown>>;
    const editToolCall = toolCall.editToolCall as { result: { success: { path: string } } };
    expect(editToolCall.result.success.path).toBe("src/foo.ts");
  });

  it("result success イベントをパースできる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"result","subtype":"success","duration_ms":5000,"duration_api_ms":5000,"is_error":false,"result":"Done","session_id":"s1"}\n';

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
      '{"type":"system","subtype":"init","model":"Composer 1.5","session_id":"s1"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"session_id":"s1"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]},"session_id":"s1"}',
      '{"type":"result","subtype":"success","duration_ms":1000,"session_id":"s1"}',
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

    const fullLine = '{"type":"system","subtype":"init","model":"Composer 1.5","session_id":"s1"}';

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
    expect(events[0].data.model).toBe("Composer 1.5");
  });

  it("マルチバイト文字がチャンク境界で分割されても正しく処理する", async () => {
    const parser = new StreamJsonParser();
    const events: StreamEvent[] = [];
    parser.on("event", (event: StreamEvent) => events.push(event));

    const fullLine = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"日本語テスト"}]}}\n';
    const buf = Buffer.from(fullLine, "utf8");

    // マルチバイト文字の途中で分割（日本語は3バイト/文字）
    // "日" は E6 97 A5 の3バイト。途中で切る
    const splitPoint = buf.indexOf(Buffer.from("日", "utf8")) + 1; // 1バイト目の後で切る

    const chunk1 = buf.subarray(0, splitPoint);
    const chunk2 = buf.subarray(splitPoint);

    await new Promise<void>((resolve) => {
      parser.write(chunk1, () => {
        parser.write(chunk2, () => {
          parser.end(() => resolve());
        });
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    const message = events[0].data.message as { content: Array<{ text: string }> };
    expect(message.content[0].text).toBe("日本語テスト");
  });

  // --------------------------------------------------
  // flush: 最後の改行なしデータ
  // --------------------------------------------------

  it("最後の改行なしデータも flush 時にパースする", async () => {
    const parser = new StreamJsonParser();
    // 改行なしで終わるデータ
    const data = '{"type":"result","subtype":"success","duration_ms":999,"session_id":"s1"}';

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
      '{"type":"system","subtype":"init","model":"m1","session_id":"s1"}',
      "this is not json",
      '{"type":"result","subtype":"success","duration_ms":100,"session_id":"s1"}',
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
    const data = '\n\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"session_id":"s1"}\n\n';

    const events = await collectEvents(parser, data);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
  });

  // --------------------------------------------------
  // editToolCall によるファイル変更検出
  // --------------------------------------------------

  it("editToolCall completed から editedFiles を抽出できる", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"editToolCall":{"args":{"path":"src/new-file.ts","streamContent":"test"},"result":{"success":{"path":"src/new-file.ts","linesAdded":5,"linesRemoved":0}}}},"session_id":"s1"}\n';

    const events = await collectEvents(parser, data);

    const fileChanges = parser.extractFileChanges(events[0]);
    expect(fileChanges.editedFiles).toContain("src/new-file.ts");
    expect(fileChanges.createdFiles).toHaveLength(0);
  });

  it("readToolCall など非編集ツールでは空配列を返す", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"tool_call","subtype":"completed","call_id":"c3","tool_call":{"readToolCall":{"args":{"path":"src/foo.ts"},"result":{"success":{"content":"file content"}}}},"session_id":"s1"}\n';

    const events = await collectEvents(parser, data);

    const fileChanges = parser.extractFileChanges(events[0]);
    expect(fileChanges.editedFiles).toHaveLength(0);
    expect(fileChanges.createdFiles).toHaveLength(0);
  });

  it("tool_call のない イベントでは空配列を返す", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"session_id":"s1"}\n';

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
    const data = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"test"}]},"session_id":"s1"}\n';

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

  // --------------------------------------------------
  // イベント正規化
  // --------------------------------------------------

  it("data フィールドにパース済み JSON 全体が格納される", async () => {
    const parser = new StreamJsonParser();
    const data = '{"type":"result","subtype":"success","duration_ms":5000,"is_error":false,"result":"Done","session_id":"s1"}\n';

    const events = await collectEvents(parser, data);

    expect(events[0].data.type).toBe("result");
    expect(events[0].data.duration_ms).toBe(5000);
    expect(events[0].data.is_error).toBe(false);
    expect(events[0].data.result).toBe("Done");
  });
});
