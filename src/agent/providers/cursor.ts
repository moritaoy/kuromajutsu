// ============================================================
// Cursor Provider（Cursor CLI `agent`）
// ============================================================

import type { StreamEvent } from "../parser.js";
import type {
  AgentProvider,
  ExecCommandOptions,
  ProviderCommand,
  StreamNormalizer,
} from "./types.js";

/** Cursor CLI の stream-json は共通イベント形式そのものなので恒等変換 */
class IdentityNormalizer implements StreamNormalizer {
  normalize(event: StreamEvent): StreamEvent[] {
    return [event];
  }
}

export class CursorProvider implements AgentProvider {
  readonly id = "cursor" as const;
  readonly staticModels: string[] = [];

  buildExecCommand(options: ExecCommandOptions): ProviderCommand {
    // 注意: Cursor CLI は -m ショートフラグ未対応のため --model を使用
    return {
      command: "agent",
      args: [
        "-p",
        "--force",
        "--model",
        options.model,
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        options.prompt,
      ],
    };
  }

  buildHealthCheckCommand(model: string, prompt: string): ProviderCommand {
    return { command: "agent", args: ["-p", "--trust", "--model", model, prompt] };
  }

  buildListModelsCommand(): ProviderCommand {
    return { command: "agent", args: ["models"] };
  }

  /**
   * `agent models` の出力形式: "id - Display Name"（1行1モデル）。
   * ヘッダー行 ("Available models") やフッター行 ("Tip: ...") は除外する。
   */
  parseModelList(stdout: string): string[] {
    // 実行環境によっては ANSI カラーコードが付与されるため除去する
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
    return plain
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.includes(" - "))
      .map((line) => line.split(" - ")[0].trim());
  }

  isModelAvailable(model: string, available: string[]): boolean {
    return available.includes(model);
  }

  createNormalizer(): StreamNormalizer {
    return new IdentityNormalizer();
  }
}
