// ============================================================
// Agent 実行: stream-json パーサー
// ============================================================
//
// 責務:
// - NDJSON 形式の stream-json をパースする Transform ストリーム
// - イベントタイプ（system, user, assistant, thinking, tool_call, result）に応じた処理
// - Agent 状態の更新をコールバック ("event" イベント) で通知
// - editedFiles / createdFiles の自動収集（writeToolCall の解析）
// - StringDecoder でマルチバイト文字の chunk 境界分断に対応

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// --------------------------------------------------
// 型定義
// --------------------------------------------------

/** stream-json のイベント型 */
export interface StreamEvent {
  type: "system" | "user" | "assistant" | "thinking" | "tool_call" | "result";
  subtype?: "init" | "delta" | "started" | "completed" | "success";
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
 *
 * StringDecoder を使用して、マルチバイト文字が chunk 境界で
 * 分断された場合でも正しくデコードする。
 */
export class StreamJsonParser extends Transform {
  /** 行バッファ（不完全な行を保持） */
  private lineBuffer: string;

  /** UTF-8 デコーダー（マルチバイト文字の分断に対応） */
  private decoder: StringDecoder;

  constructor() {
    super({ readableObjectMode: true });
    this.lineBuffer = "";
    this.decoder = new StringDecoder("utf8");
  }

  // --------------------------------------------------
  // Transform 実装
  // --------------------------------------------------

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback,
  ): void {
    // StringDecoder で安全にデコード（マルチバイト文字の分断を処理）
    this.lineBuffer += this.decoder.write(chunk);

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
    // StringDecoder の残りバイトをフラッシュ
    this.lineBuffer += this.decoder.end();

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
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;

      // NDJSON の各行を StreamEvent 形式に正規化
      const event: StreamEvent = {
        type: parsed.type as StreamEvent["type"],
        subtype: parsed.subtype as StreamEvent["subtype"],
        data: parsed,
      };

      this.emit("event", event);
      this.push(event);
    } catch {
      // パース失敗行はスキップ（デバッグ用にログ出力）
      console.error(
        `[parser] JSON パース失敗 (${trimmed.length} chars): ${trimmed.slice(0, 200)}`,
      );
    }
  }

  // --------------------------------------------------
  // ファイル変更抽出
  // --------------------------------------------------

  /**
   * tool_call completed イベントから editedFiles / createdFiles を抽出する。
   *
   * Cursor CLI の tool_call 形式:
   *   {"tool_call": {"editToolCall": {"args": {"path": "..."}, "result": {...}}}}
   *
   * - `editToolCall` → editedFiles（ファイル新規作成も含む）
   * - それ以外 → 空配列
   */
  extractFileChanges(event: StreamEvent): FileChanges {
    const editedFiles: string[] = [];
    const createdFiles: string[] = [];

    const { data } = event;
    const toolCallObj = data.tool_call as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (!toolCallObj) return { editedFiles, createdFiles };

    const toolEntry = Object.entries(toolCallObj)[0];
    if (!toolEntry) return { editedFiles, createdFiles };

    const [toolName, toolDetails] = toolEntry;
    const args = (toolDetails as { args?: Record<string, unknown> })?.args;
    const filePath = args?.path as string | undefined;

    if (filePath && toolName === "editToolCall") {
      editedFiles.push(filePath);
    }

    return { editedFiles, createdFiles };
  }
}
