// ============================================================
// config:update_role の設定ファイル書き戻しテスト
// （workspace 設定・providers・コメントを落とさないこと）
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { parse as parseYaml } from "yaml";
import { AgentManager } from "../../src/agent/manager.js";
import { startDashboardServer } from "../../src/dashboard/server.js";
import type { AppConfig } from "../../src/types/index.js";

const PORT = 29698;

const YAML_TEXT = `# ダッシュボード設定（このコメントは残ること）
dashboard:
  port: ${PORT}
providers:
  claude:
    permissionMode: acceptEdits
agent:
  maxConcurrent: 10
log:
  level: info
# Workspace 設定
workspace:
  gateCommands:
    allow:
      - npm test   # 許可リスト
    timeout_ms: 1000
roles:
  # 実装者
  - id: impl-code
    name: コード実装者
    description: 実装する
    provider: cursor
    model: composer-2.5-fast
    systemPrompt: |
      あなたは実装者です。
      2 行目。
    healthCheckPrompt: "OK"
    tools: []
  - id: planner
    name: 計画立案者
    description: 計画を作る
    provider: claude
    model: opus
    systemPrompt: plan
    healthCheckPrompt: "OK"
    tools: []
`;

function createConfig(): AppConfig {
  return {
    dashboard: { port: PORT },
    agent: { maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        description: "実装する",
        provider: "cursor",
        model: "composer-2.5-fast",
        systemPrompt: "あなたは実装者です。\n2 行目。\n",
        healthCheckPrompt: "OK",
        tools: [],
      },
      {
        id: "planner",
        name: "計画立案者",
        description: "計画を作る",
        provider: "claude",
        model: "opus",
        systemPrompt: "plan",
        healthCheckPrompt: "OK",
        tools: [],
      },
    ],
  };
}

async function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("config:update_role の書き戻し", () => {
  let server: Server;
  let dir: string;
  let file: string;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kuromajutsu-cfg-"));
    file = join(dir, "kuromajutsu.config.yaml");
    writeFileSync(file, YAML_TEXT, "utf-8");
    prevEnv = process.env["KUROMAJUTSU_CONFIG"];
    process.env["KUROMAJUTSU_CONFIG"] = file;

    const config = createConfig();
    const manager = new AgentManager(config);
    server = startDashboardServer(config, manager);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    if (prevEnv === undefined) delete process.env["KUROMAJUTSU_CONFIG"];
    else process.env["KUROMAJUTSU_CONFIG"] = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("職種を更新しても workspace / providers / コメントが残り、他の職種も変わらない", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    try {
      ws.send(
        JSON.stringify({
          type: "config:update_role",
          data: { id: "impl-code", model: "grok-4.7", systemPrompt: "新しい\nプロンプト\n" },
        }),
      );
      await waitFor(() => readFileSync(file, "utf-8").includes("grok-4.7"));
    } finally {
      ws.close();
    }

    const text = readFileSync(file, "utf-8");
    // コメントが残る
    expect(text).toContain("# ダッシュボード設定（このコメントは残ること）");
    expect(text).toContain("# Workspace 設定");
    expect(text).toContain("# 許可リスト");
    expect(text).toContain("# 実装者");

    const parsed = parseYaml(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(parsed["workspace"]).toEqual({
      gateCommands: { allow: ["npm test"], timeout_ms: 1000 },
    });
    expect(parsed["providers"]).toEqual({ claude: { permissionMode: "acceptEdits" } });
    expect(parsed["agent"]).toEqual({ maxConcurrent: 10 });

    const roles = parsed["roles"] as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(roles.map((r) => r["id"])).toEqual(["impl-code", "planner"]);
    expect(roles[0]?.["model"]).toBe("grok-4.7");
    expect(roles[0]?.["systemPrompt"]).toBe("新しい\nプロンプト\n");
    expect(roles[0]?.["provider"]).toBe("cursor");
    expect(roles[0]?.["name"]).toBe("コード実装者");
    expect(roles[1]).toMatchObject({ id: "planner", model: "opus", provider: "claude" });
  });
});
