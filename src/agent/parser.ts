// ============================================================
// Agent 実行: stream-json パーサー
// ============================================================
//
// 責務:
// - NDJSON 形式の stream-json をパースする Transform ストリーム
// - イベントタイプ（system, user, assistant, tool_call, result）に応じた処理
// - Agent 状態の更新をコールバック ("event" イベント) で通知
// - editedFiles / createdFiles の自動収集（writeToolCall の解析）

import { Transform, type TransformCallback } from "node:stream";

// --------------------------------------------------
// 型定義
// --------------------------------------------------

/** stream-json のイベント型 */
export interface StreamEvent {
  type: "system" | "user" | "assistant" | "tool_call" | "result";
  subtype?: "init" | "started" | "completed" | "success";
  /** イベント固有のデータ */
  data: Record<string, unknown>;
}

/** ファイル変更情報 */
export interface FileChanges {
  editedFiles: string[];
  createdFiles: string[];
}

// --------------------------------------------------
// StreamJsonParser
// --------------------------------------------------

/**
 * NDJSON（改行区切り JSON）の各行をパースし、
 * イベントタイプに応じた "event" イベントを emit する Transform ストリーム。
 *
 * readable 側はオブジェクトモードで StreamEvent を push する。
 */
export class StreamJsonParser extends Transform {
  /** 行バッファ（不完全な行を保持） */
  private lineBuffer: string;

  constructor() {
    super({ readableObjectMode: true });
    this.lineBuffer = "";
  }

  // --------------------------------------------------
  // Transform 実装
  // --------------------------------------------------

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    this.lineBuffer += chunk.toString();

    // 改行で分割し、完全な行をパース
    const lines = this.lineBuffer.split("\n");
    // 最後の要素は不完全な可能性があるのでバッファに戻す
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      this.parseLine(line);
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    // 残りのバッファを処理
    if (this.lineBuffer.trim()) {
      this.parseLine(this.lineBuffer);
    }
    this.lineBuffer = "";
    callback();
  }

  // --------------------------------------------------
  // 行パース
  // --------------------------------------------------

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const event = JSON.parse(trimmed) as StreamEvent;
      this.emit("event", event);
      this.push(event);
    } catch {
      // パース失敗行はスキップ（ログ出力）
      console.error(`[parser] JSON パース失敗: ${trimmed.slice(0, 100)}`);
    }
  }

  // --------------------------------------------------
  // ファイル変更抽出
  // --------------------------------------------------

  /**
   * tool_call completed イベントから editedFiles / createdFiles を抽出する。
   *
   * - `toolName === "write"` → createdFiles
   * - `toolName === "edit"` → editedFiles
   * - それ以外 → 空配列
   */
  extractFileChanges(event: StreamEvent): FileChanges {
    const editedFiles: string[] = [];
    const createdFiles: string[] = [];

    const { data } = event;
    const toolName = data.toolName as string | undefined;
    const args = data.args as Record<string, unknown> | undefined;
    const filePath = args?.path as string | undefined;

    if (filePath && (toolName === "write" || toolName === "edit")) {
      if (toolName === "write") {
        createdFiles.push(filePath);
      } else {
        editedFiles.push(filePath);
      }
    }

    return { editedFiles, createdFiles };
  }
}
