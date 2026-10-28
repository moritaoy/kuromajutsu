// ============================================================
// Claude Provider（Claude Code CLI `claude`）
// ============================================================
//
// Claude Code の stream-json（--output-format stream-json --verbose）:
//   system:    {"type":"system","subtype":"init","model":"...",...}
//   assistant: {"type":"assistant","message":{"content":[{"type":"text"|"thinking"|"tool_use",...}]}}
//   user:      {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","is_error"?:true}]}}
//   result:    {"type":"result","subtype":"success"|"error_*","is_error":bool,"duration_ms":N,...}
// これを共通イベント形式（Cursor 形式）に正規化する。

import type { StreamEvent } from "../parser.js";
import type {
  AgentProvider,
  ExecCommandOptions,
  ProviderCommand,
  StreamNormalizer,
} from "./types.js";

const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/** Claude Code が受け付けるモデルエイリアス */
const MODEL_ALIASES = ["default", "sonnet", "opus", "haiku", "opusplan"];

/** Claude のツール名 → 共通イベントのツール種別 */
const TOOL_NAME_MAP: Record<string, string> = {
  Edit: "editToolCall",
  MultiEdit: "editToolCall",
  Write: "editToolCall",
  NotebookEdit: "editToolCall",
  Read: "readToolCall",
  Bash: "shellToolCall",
  Grep: "grepToolCall",
  Glob: "globToolCall",
};

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function getBlocks(event: StreamEvent): ContentBlock[] {
  const message = event.data.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

function toToolName(claudeName: string): string {
  return TOOL_NAME_MAP[claudeName] ?? `${claudeName}ToolCall`;
}

/** Claude のツール入力を共通形式の args（path 付き）へ変換する */
function toArgs(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(input ?? {}) };
  const path = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (typeof path === "string") {
    args.path = path;
  }
  return args;
}

class ClaudeNormalizer implements StreamNormalizer {
  /** tool_use.id → ツール種別と引数（tool_result 側で参照する） */
  private pending = new Map<string, { toolName: string; args: Record<string, unknown> }>();

  normalize(event: StreamEvent): StreamEvent[] {
    switch (event.type) {
      case "system":
        return [event];
      case "assistant":
        return this.normalizeAssistant(event);
      case "user":
        return this.normalizeUser(event);
      case "result":
        return [this.normalizeResult(event)];
      default:
        return [];
    }
  }

  private normalizeAssistant(event: StreamEvent): StreamEvent[] {
    const out: StreamEvent[] = [];
    const blocks = getBlocks(event);

    const texts = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) {
      out.push({
        type: "assistant",
        data: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: texts.join("\n") }] },
        },
      });
    }

    for (const block of blocks) {
      if (block.type === "thinking") {
        out.push({
          type: "thinking",
          subtype: "completed",
          data: { type: "thinking", subtype: "completed", text: block.thinking ?? "" },
        });
      } else if (block.type === "tool_use" && block.id && block.name) {
        const toolName = toToolName(block.name);
        const args = toArgs(block.input);
        this.pending.set(block.id, { toolName, args });
        out.push({
          type: "tool_call",
          subtype: "started",
          data: {
            type: "tool_call",
            subtype: "started",
            call_id: block.id,
            tool_call: { [toolName]: { args } },
          },
        });
      }
    }
    return out;
  }

  private normalizeUser(event: StreamEvent): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const block of getBlocks(event)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const started = this.pending.get(block.tool_use_id);
      this.pending.delete(block.tool_use_id);
      const toolName = started?.toolName ?? "unknownToolCall";
      const result = block.is_error
        ? { error: { message: typeof block.content === "string" ? block.content : "tool error" } }
        : { success: {} };
      out.push({
        type: "tool_call",
        subtype: "completed",
        data: {
          type: "tool_call",
          subtype: "completed",
          call_id: block.tool_use_id,
          tool_call: { [toolName]: { args: started?.args ?? {}, result } },
        },
      });
    }
    return out;
  }

  private normalizeResult(event: StreamEvent): StreamEvent {
    const failed = event.data.is_error === true || event.subtype !== "success";
    const subtype = failed ? "error" : "success";
    return {
      type: "result",
      subtype,
      data: { ...event.data, subtype },
    };
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly staticModels: string[] = [...MODEL_ALIASES];

  buildExecCommand(options: ExecCommandOptions): ProviderCommand {
    // --mcp-config は可変長引数のため、プロンプトを先頭（-p 直後）に置き、--mcp-config を最後尾に置く
    const args = [
      "-p",
      options.prompt,
      "--model",
      options.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      options.permissionMode ?? DEFAULT_PERMISSION_MODE,
    ];
    if (options.mcpUrl) {
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: { kuromajutsu: { type: "http", url: options.mcpUrl } },
        }),
      );
    }
    return { command: "claude", args };
  }

  buildHealthCheckCommand(model: string, prompt: string): ProviderCommand {
    return { command: "claude", args: ["-p", prompt, "--model", model] };
  }

  /** Claude Code にはモデル一覧コマンドが無いため静的一覧を使う */
  buildListModelsCommand(): null {
    return null;
  }

  parseModelList(): string[] {
    return [...this.staticModels];
  }

  isModelAvailable(model: string, available: string[]): boolean {
    return available.includes(model) || /^claude-/.test(model);
  }

  createNormalizer(): StreamNormalizer {
    return new ClaudeNormalizer();
  }
}
