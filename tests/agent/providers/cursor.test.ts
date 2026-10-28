// ============================================================
// Cursor Provider テスト
// ============================================================

import { describe, it, expect } from "vitest";
import { getProvider } from "../../../src/agent/providers/index.js";
import type { StreamEvent } from "../../../src/agent/parser.js";

const cursor = getProvider("cursor");

describe("CursorProvider", () => {
  it("agent -p --force ... でコマンドを組み立てる", () => {
    const cmd = cursor.buildExecCommand({ model: "composer-2.5-fast", prompt: "do it" });
    expect(cmd.command).toBe("agent");
    expect(cmd.args).toEqual([
      "-p",
      "--force",
      "--model",
      "composer-2.5-fast",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "do it",
    ]);
  });

  it("ヘルスチェックコマンドは agent -p --trust --model", () => {
    expect(cursor.buildHealthCheckCommand("m1", "hello")).toEqual({
      command: "agent",
      args: ["-p", "--trust", "--model", "m1", "hello"],
    });
  });

  it("モデル一覧は agent models から取得し 'id - Name' 形式をパースする", () => {
    expect(cursor.buildListModelsCommand()).toEqual({ command: "agent", args: ["models"] });
    const models = cursor.parseModelList(
      "Available models\n\nauto - Auto\ncomposer-2.5-fast - Composer 2.5 Fast\n\nTip: use --model\n",
    );
    expect(models).toEqual(["auto", "composer-2.5-fast"]);
  });

  it("ANSI カラーコードが含まれる出力でもモデル ID をパースできる", () => {
    const stdout =
      "\u001b[2mAvailable models\u001b[22m\n\n" +
      "\u001b[36mauto\u001b[39m \u001b[2m- Auto\u001b[22m\u001b[2m (default)\u001b[22m\n" +
      "\u001b[36mcomposer-2.5-fast\u001b[39m \u001b[2m- Composer 2.5 Fast\u001b[22m\n";
    expect(cursor.parseModelList(stdout)).toEqual(["auto", "composer-2.5-fast"]);
  });

  it("モデルは一覧との完全一致で検証する", () => {
    expect(cursor.isModelAvailable("auto", ["auto", "x"])).toBe(true);
    expect(cursor.isModelAvailable("sonnet", ["auto", "x"])).toBe(false);
  });

  it("ノーマライザはイベントをそのまま返す（恒等）", () => {
    const ev: StreamEvent = { type: "assistant", data: { message: { content: [{ text: "hi" }] } } };
    expect(cursor.createNormalizer().normalize(ev)).toEqual([ev]);
  });
});
