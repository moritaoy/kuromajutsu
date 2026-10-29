// ============================================================
// Workspace HTTP API / WebSocket テスト（docs/spec.md §13.9）
// ============================================================

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { request } from "node:http";
import { connect } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentManager } from "../../src/agent/manager.js";
import { startDashboardServer } from "../../src/dashboard/server.js";
import { WorkspaceStore } from "../../src/workspace/store.js";
import { WorkspaceService } from "../../src/workspace/service.js";
import type { AppConfig, ServerEvent } from "../../src/types/index.js";
import { makeAuthPlan } from "../workspace/fixtures.js";
import { createRunHarness, reviewDoc, type RunHarness } from "../workspace/harness.js";

vi.mock("../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

const PORT = 29697;
const BASE = `http://localhost:${PORT}`;
/** 実行系のテスト（別サーバー）の間だけ差し替える */
let activeBase = BASE;

function createTestConfig(): AppConfig {
  return {
    dashboard: { port: PORT },
    // モックの Agent は完了しないため、同時実行数の上限に達しないよう大きくする
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 1000 },
    log: { level: "info" },
    roles: [
      {
        id: "planner",
        name: "計画立案者",
        description: "計画を作る",
        provider: "claude",
        model: "opus",
        systemPrompt: "x",
        healthCheckPrompt: "OK",
      },
      {
        id: "impl-code",
        name: "コード実装者",
        description: "実装する",
        model: "composer-2.5-fast",
        systemPrompt: "x",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

function planJson(): string {
  const { revision: _r, maxIterations: _m, ...input } = makeAuthPlan();
  return JSON.stringify(input);
}

interface HttpResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  body: string;
}

function http(
  method: string,
  path: string,
  body?: unknown,
  raw?: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = request(
      `${activeBase}${path}`,
      {
        method,
        headers: {
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, body: text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** レスポンスヘッダーを 1 つ取得する */
function headerOf(
  path: string,
  headers: Record<string, string>,
  name: string,
): Promise<string | string[] | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(`${activeBase}${path}`, { method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers[name]));
    });
    req.on("error", reject);
    req.end();
  });
}

/** 生のソケットで GET し、ステータスコードを返す（パスを正規化させないため） */
function rawGetStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(activeBase);
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (c) => (data += c.toString()));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

function connectWs(): Promise<{ ws: WebSocket; messages: ServerEvent[] }> {
  return new Promise((resolve, reject) => {
    const messages: ServerEvent[] = [];
    const ws = new WebSocket(activeBase.replace(/^http/, "ws"));
    ws.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()) as ServerEvent);
      } catch {
        /* ignore */
      }
    });
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

async function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Workspace API", () => {
  let server: Server;
  let dir: string;
  let service: WorkspaceService;
  let wsPath: string;
  let manager: AgentManager;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kuromajutsu-api-"));
    wsPath = join(dir, "project");
    mkdirSync(wsPath);
    const config = createTestConfig();
    manager = new AgentManager(config);
    const store = new WorkspaceStore(dir);
    service = new WorkspaceService(config, manager, store);
    server = startDashboardServer(config, manager, undefined, service);
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
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/workspaces: 最初は空配列", async () => {
    const r = await http("GET", "/api/workspaces");
    expect(r.status).toBe(200);
    expect(r.json).toEqual([]);
  });

  it("POST /api/workspaces: 201 と planning の Workspace", async () => {
    const r = await http("POST", "/api/workspaces", {
      instruction: "認証を追加して",
      workspacePath: wsPath,
    });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^ws-/);
    expect(r.json.status).toBe("planning");
    expect(r.json.instruction).toBe("認証を追加して");
    expect(r.json.workspacePath).toBe(wsPath);
  });

  it("GET /api/workspaces: 一覧は §13.9.1 の項目のみ", async () => {
    const r = await http("GET", "/api/workspaces");
    expect(r.status).toBe(200);
    expect(r.json.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(r.json[0]).sort()).toEqual(
      ["createdAt", "id", "instruction", "status", "updatedAt"].sort(),
    );
  });

  it("GET /api/workspaces/:id: 全体 + validation（存在しなければ 404）", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "もう 1 つ" });
    const id = created.json.id as string;

    const ok = await http("GET", `/api/workspaces/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.json.id).toBe(id);
    expect(ok.json.revisions).toEqual([]);
    expect(ok.json.validation).toEqual([]);
    expect(ok.json.gateResults).toEqual([]);

    const nf = await http("GET", "/api/workspaces/ws-nope");
    expect(nf.status).toBe(404);
    expect(nf.json.error).toBe("NOT_FOUND");
    expect(typeof nf.json.message).toBe("string");
  });

  it("POST /api/workspaces/:id/replan: planning 中は 409", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "再計画テスト" });
    const r = await http("POST", `/api/workspaces/${created.json.id}/replan`, {
      instruction: "追加",
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("INVALID_STATE");
  });

  it("POST /api/workspaces/:id/replan: review なら 202 と planning の Workspace", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "再計画 OK" });
    const id = created.json.id as string;
    // Planner が計画を報告して review にする
    const planner = manager.listAgents().find((a) => a.prompt.includes("再計画 OK"));
    expect(planner).toBeDefined();
    manager.updateAgentState(planner!.agentId, { status: "running" });
    manager.reportResult(planner!.agentId, {
      status: "success",
      summary: "計画",
      response: planJson(),
    });
    expect(service.get(id)?.status).toBe("review");

    const r = await http("POST", `/api/workspaces/${id}/replan`, {
      instruction: "ゲートを増やして",
      targets: [{ kind: "phase", id: "P1" }],
    });
    expect(r.status).toBe(202);
    expect(r.json.status).toBe("planning");
  });

  it("POST /api/workspaces/:id/replan: 不正な targets は 400", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "x" });
    const r = await http("POST", `/api/workspaces/${created.json.id}/replan`, {
      instruction: "y",
      targets: [{ kind: "bogus", id: "P1" }],
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/workspaces/:id/replan: 不明な ID は 404", async () => {
    const r = await http("POST", "/api/workspaces/ws-nope/replan", { instruction: "y" });
    expect(r.status).toBe(404);
  });

  it("POST /api/workspaces/:id/abort: planning → aborted（再度は 409、不明は 404）", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "中断する" });
    const id = created.json.id as string;

    const r = await http("POST", `/api/workspaces/${id}/abort`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("aborted");
    expect(r.json.statusReason.code).toBe("user_abort");

    expect((await http("POST", `/api/workspaces/${id}/abort`)).status).toBe(409);
    expect((await http("POST", "/api/workspaces/ws-nope/abort")).status).toBe(404);
  });

  it("存在しない / ディレクトリでない workspacePath は 400 INVALID_WORKSPACE_PATH", async () => {
    const missing = await http("POST", "/api/workspaces", {
      instruction: "x",
      workspacePath: join(dir, "no-such-dir"),
    });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe("INVALID_WORKSPACE_PATH");

    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    const notDir = await http("POST", "/api/workspaces", { instruction: "x", workspacePath: file });
    expect(notDir.status).toBe(400);
    expect(notDir.json.error).toBe("INVALID_WORKSPACE_PATH");
  });

  it("instruction が 100,000 文字を超えると 400 INVALID_INSTRUCTION", async () => {
    const r = await http("POST", "/api/workspaces", { instruction: "a".repeat(100_001) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("INVALID_INSTRUCTION");
  });

  describe("cross-origin 対策", () => {
    it("Content-Type が application/json でない POST は 415（Workspace は作られない）", async () => {
      const before = service.list().length;
      const r = await http(
        "POST",
        "/api/workspaces",
        undefined,
        JSON.stringify({ instruction: "text/plain で送る" }),
        { "Content-Type": "text/plain" },
      );
      expect(r.status).toBe(415);
      expect(r.json.error).toBe("UNSUPPORTED_MEDIA_TYPE");
      expect(service.list()).toHaveLength(before);
    });

    it("Content-Type なしの POST も 415、application/json; charset=utf-8 は通る", async () => {
      const none = await http("POST", "/api/workspaces", undefined, JSON.stringify({ instruction: "x" }), {
        "Content-Type": "",
      });
      expect(none.status).toBe(415);

      const ok = await http(
        "POST",
        "/api/workspaces",
        undefined,
        JSON.stringify({ instruction: "charset 付き" }),
        { "Content-Type": "application/json; charset=utf-8" },
      );
      expect(ok.status).toBe(201);
    });

    it("replan も Content-Type を検査する", async () => {
      const created = await http("POST", "/api/workspaces", { instruction: "415 replan" });
      const r = await http(
        "POST",
        `/api/workspaces/${created.json.id}/replan`,
        undefined,
        JSON.stringify({ instruction: "y" }),
        { "Content-Type": "text/plain" },
      );
      expect(r.status).toBe(415);
    });

    it("Origin が Host と一致しなければ、GET / POST / abort を含めて 403", async () => {
      const created = await http("POST", "/api/workspaces", { instruction: "403 の対象" });
      const id = created.json.id as string;
      const evil = { Origin: "http://evil.example" };

      const list = await http("GET", "/api/workspaces", undefined, undefined, evil);
      expect(list.status).toBe(403);
      expect(list.json.error).toBe("FORBIDDEN_ORIGIN");
      // CORS ヘッダーは返さない
      expect(await headerOf("/api/workspaces", evil, "access-control-allow-origin")).toBeUndefined();

      expect((await http("GET", `/api/workspaces/${id}`, undefined, undefined, evil)).status).toBe(403);
      expect(
        (await http("POST", "/api/workspaces", { instruction: "x" }, undefined, evil)).status,
      ).toBe(403);
      expect((await http("POST", `/api/workspaces/${id}/abort`, undefined, undefined, evil)).status).toBe(
        403,
      );
      // 中断されていない
      expect(service.get(id)?.status).toBe("planning");

      // 不正な Origin（"null" など）も 403
      expect(
        (await http("GET", "/api/workspaces", undefined, undefined, { Origin: "null" })).status,
      ).toBe(403);
    });

    it("同一 Origin / loopback の同ポート / Origin なしは通る", async () => {
      const same = await http("GET", "/api/workspaces", undefined, undefined, {
        Origin: `http://localhost:${PORT}`,
      });
      expect(same.status).toBe(200);

      const loopback = await http("GET", "/api/workspaces", undefined, undefined, {
        Origin: `http://127.0.0.1:${PORT}`,
      });
      expect(loopback.status).toBe(200);

      const v6 = await http("GET", "/api/workspaces", undefined, undefined, {
        Origin: `http://[::1]:${PORT}`,
      });
      expect(v6.status).toBe(200);

      const none = await http("GET", "/api/workspaces");
      expect(none.status).toBe(200);

      // 別ポートの loopback は拒否
      const otherPort = await http("GET", "/api/workspaces", undefined, undefined, {
        Origin: "http://localhost:1",
      });
      expect(otherPort.status).toBe(403);
    });

    it("Host と一致する Origin は通る（LAN IP などでの利用）", async () => {
      const r = await http("GET", "/api/workspaces", undefined, undefined, {
        Host: "192.168.0.10:9696",
        Origin: "http://192.168.0.10:9696",
      });
      expect(r.status).toBe(200);
    });

    it("/api/workspaces 以外の /api/ には Origin 検査を適用しない", async () => {
      const r = await http("GET", "/api/health", undefined, undefined, { Origin: "http://evil.example" });
      expect(r.status).toBe(200);
    });
  });

  it("不正な body / 必須欠落は 400", async () => {
    const bad = await http("POST", "/api/workspaces", undefined, "{not json");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("INVALID_JSON");

    const missing = await http("POST", "/api/workspaces", {});
    expect(missing.status).toBe(400);

    const blank = await http("POST", "/api/workspaces", { instruction: "   " });
    expect(blank.status).toBe(400);

    const notObject = await http("POST", "/api/workspaces", undefined, "[1]");
    expect(notObject.status).toBe(400);

    const wrongType = await http("POST", "/api/workspaces", { instruction: "x", workspacePath: 1 });
    expect(wrongType.status).toBe(400);
  });

  it("body が 1 MiB を超えると 413", async () => {
    const r = await http("POST", "/api/workspaces", { instruction: "a".repeat(1024 * 1024 + 10) });
    expect(r.status).toBe(413);
  });

  it("未対応のメソッド / パスは 405 / 404", async () => {
    expect((await http("DELETE", "/api/workspaces")).status).toBe(405);
    expect((await http("GET", "/api/workspaces/ws-x/unknown")).status).toBe(404);
  });

  it("/api/workspaces 以外の /api/ は従来どおり 200", async () => {
    const r = await http("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
  });

  it("WebSocket: workspace:created / plan_generating が配信される", async () => {
    const { ws, messages } = await connectWs();
    try {
      const created = await http("POST", "/api/workspaces", { instruction: "WS で受け取る" });
      const id = created.json.id as string;

      await waitFor(() =>
        messages.some((m) => m.type === "workspace:plan_generating" && m.data.workspaceId === id),
      );
      expect(
        messages.some((m) => m.type === "workspace:created" && m.data.id === id),
      ).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("WebSocket: 接続時に既存の Workspace が workspace:created で送られる", async () => {
    // 先行テストに依存しないよう、接続前に自前で作成する
    const mine = service.create({ instruction: "接続前に作成", workspacePath: wsPath });
    const existing = service.list().map((w) => w.id);
    expect(existing).toContain(mine.id);
    const { ws, messages } = await connectWs();
    try {
      await waitFor(() =>
        existing.every((id) =>
          messages.some((m) => m.type === "workspace:created" && m.data.id === id),
        ),
      );
    } finally {
      ws.close();
    }
  });

  it("WebSocket: service の 13 イベントがすべて ServerEvent としてそのまま配信される", async () => {
    const types = [
      "workspace:created",
      "workspace:updated",
      "workspace:plan_generating",
      "workspace:plan_ready",
      "workspace:plan_failed",
      "workspace:phase_planned",
      "workspace:replanned",
      "workspace:gate_result",
      "workspace:gate_retry_exceeded",
      "workspace:human_review_requested",
      "workspace:human_review_resolved",
      "workspace:resumed",
      "workspace:irregular",
    ] as const;
    expect(types).toHaveLength(13);

    const { ws, messages } = await connectWs();
    try {
      // 接続時の初期状態（既存 Workspace の workspace:created）が落ち着くのを待つ
      await new Promise((r) => setTimeout(r, 100));
      const start = messages.length;
      types.forEach((type, i) => service.emit(type, { workspaceId: "ws-emit", marker: i }));

      await waitFor(() => messages.length - start >= types.length);
      const received = messages.slice(start);
      expect(received.map((m) => m.type)).toEqual([...types]);
      received.forEach((m, i) => {
        expect(m.data).toEqual({ workspaceId: "ws-emit", marker: i });
      });
    } finally {
      ws.close();
    }
  });

  it("WebSocket: 中断すると workspace:updated が配信される", async () => {
    const created = await http("POST", "/api/workspaces", { instruction: "中断を通知" });
    const id = created.json.id as string;
    const { ws, messages } = await connectWs();
    try {
      await http("POST", `/api/workspaces/${id}/abort`);
      await waitFor(() =>
        messages.some(
          (m) => m.type === "workspace:updated" && m.data.id === id && m.data.status === "aborted",
        ),
      );
    } finally {
      ws.close();
    }
  });
});

// ==================================================
// 実行系 API（承認・人間レビュー・再試行・イレギュラー確認・レビュー資料の配信）
// ==================================================

const RUN_PORT = 29699;

const REVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; form-action 'none'";

describe("Workspace API（実行系）", () => {
  let h: RunHarness;
  let server: Server;

  beforeAll(async () => {
    h = createRunHarness(RUN_PORT);
    server = startDashboardServer(h.config, h.manager, undefined, h.service);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", () => resolve());
    });
    activeBase = `http://localhost:${RUN_PORT}`;
  });

  afterAll(async () => {
    activeBase = BASE;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    h.cleanup();
  });

  /** gate-P1 を人間レビュー待ちにして Orchestrator を終了させる */
  function waitingHumanReview() {
    const r = h.running();
    h.service.reportGateResult(r.groupId, "gate-P1", 0, true);
    const writer = h.writerReports(r.groupId, reviewDoc());
    h.service.requestHumanReview(r.groupId, "gate-P1", `agent:${writer}`);
    h.finish(r.orchestratorId);
    return r;
  }

  describe("POST /api/workspaces/:id/approve", () => {
    it("200 と running の Workspace（groupId 付き）。body は省略できる", async () => {
      const ws = h.review();
      const r = await http("POST", `/api/workspaces/${ws.id}/approve`);
      expect(r.status).toBe(200);
      expect(r.json.id).toBe(ws.id);
      expect(r.json.status).toBe("running");
      expect(r.json.approvedRevision).toBe(1);
      expect(r.json.groupId).toMatch(/^grp-/);
    });

    it("maxIterations を指定できる", async () => {
      const ws = h.review();
      const r = await http("POST", `/api/workspaces/${ws.id}/approve`, { maxIterations: 33 });
      expect(r.status).toBe(200);
      expect(r.json.revisions[0].maxIterations).toBe(33);
    });

    it("maxIterations が不正なら 400", async () => {
      const ws = h.review();
      expect((await http("POST", `/api/workspaces/${ws.id}/approve`, { maxIterations: "x" })).status).toBe(400);
      expect((await http("POST", `/api/workspaces/${ws.id}/approve`, { maxIterations: 0 })).status).toBe(400);
      expect(h.store.get(ws.id)?.status).toBe("review");
    });

    it("検証エラーがあれば 422 と issues", async () => {
      const ws = h.review((p) => {
        p.steps.find((s) => s.id === "s1")!.role = "no-such-role";
      });
      const r = await http("POST", `/api/workspaces/${ws.id}/approve`, {});
      expect(r.status).toBe(422);
      expect(r.json.error).toBe("VALIDATION_FAILED");
      expect(typeof r.json.message).toBe("string");
      expect(r.json.issues.some((i: { rule: string; level: string }) => i.rule === "V6" && i.level === "error")).toBe(true);
      expect(h.store.get(ws.id)?.status).toBe("review");
    });

    it("review 以外は 409、不明な ID は 404", async () => {
      const { id } = h.running();
      const r = await http("POST", `/api/workspaces/${id}/approve`, {});
      expect(r.status).toBe(409);
      expect(r.json.error).toBe("INVALID_STATE");
      expect((await http("POST", "/api/workspaces/ws-nope/approve", {})).status).toBe(404);
    });

    it("orchestrator が使えなければ 503", async () => {
      const ws = h.review();
      const saved = h.config.roles;
      h.config.roles = saved.filter((r) => r.id !== "orchestrator");
      try {
        const r = await http("POST", `/api/workspaces/${ws.id}/approve`, {});
        expect(r.status).toBe(503);
        expect(r.json.error).toBe("ORCHESTRATOR_UNAVAILABLE");
      } finally {
        h.config.roles = saved;
      }
    });

    it("Content-Type のない body 付きリクエストは 415、foreign Origin は 403", async () => {
      const ws = h.review();
      const r = await http("POST", `/api/workspaces/${ws.id}/approve`, undefined, '{"maxIterations":5}', {
        "Content-Type": "text/plain",
      });
      expect(r.status).toBe(415);
      const o = await http("POST", `/api/workspaces/${ws.id}/approve`, {}, undefined, { Origin: "http://evil.example" });
      expect(o.status).toBe(403);
      expect(h.store.get(ws.id)?.status).toBe("review");
    });
  });

  describe("POST /api/workspaces/:id/gates/:gateId/review", () => {
    it("差し戻し: 200 と running。コメントを記録して再開する", async () => {
      const { id, groupId, orchestratorId } = waitingHumanReview();
      const r = await http("POST", `/api/workspaces/${id}/gates/gate-P1/review`, {
        decision: "request_changes",
        comment: "全体の根拠が足りない",
        comments: [{ sectionId: "conclusion", text: "結論をもう少し具体的に" }],
      });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("running");
      expect(r.json.humanReviews[0]).toMatchObject({
        status: "changes_requested",
        comments: [{ sectionId: "conclusion", text: "結論をもう少し具体的に" }, { text: "全体の根拠が足りない" }],
      });
      // 再開（新しい Orchestrator の起動）は非同期。応答は待たない
      await waitFor(() => h.manager.getGroup(groupId)?.orchestratorAgentId !== orchestratorId);
    });

    it("承認: 200 と running、ゲートは passed", async () => {
      const { id } = waitingHumanReview();
      const r = await http("POST", `/api/workspaces/${id}/gates/gate-P1/review`, { decision: "approve" });
      expect(r.status).toBe(200);
      expect(r.json.humanReviews[0].status).toBe("approved");
      expect(r.json.gateResults.find((g: { gateId: string }) => g.gateId === "gate-P1").status).toBe("passed");
    });

    it("人間レビュー待ちでなければ 409、不明な ID は 404", async () => {
      const { id } = h.running();
      const r = await http("POST", `/api/workspaces/${id}/gates/gate-P1/review`, { decision: "approve" });
      expect(r.status).toBe(409);
      expect((await http("POST", "/api/workspaces/ws-nope/gates/gate-P1/review", { decision: "approve" })).status).toBe(404);
    });

    it("decision / comment / comments が不正なら 400", async () => {
      const { id } = waitingHumanReview();
      const url = `/api/workspaces/${id}/gates/gate-P1/review`;
      expect((await http("POST", url, {})).status).toBe(400);
      expect((await http("POST", url, { decision: "maybe" })).status).toBe(400);
      expect((await http("POST", url, { decision: "request_changes", comment: 1 })).status).toBe(400);
      expect((await http("POST", url, { decision: "request_changes", comments: "x" })).status).toBe(400);
      expect((await http("POST", url, { decision: "request_changes", comments: [{ sectionId: 1, text: "x" }] })).status).toBe(400);
      expect((await http("POST", url, { decision: "request_changes", comments: [{ text: 1 }] })).status).toBe(400);
      expect(h.store.get(id)?.status).toBe("waiting_human");
    });

    it("Content-Type が application/json でなければ 415", async () => {
      const { id } = waitingHumanReview();
      const r = await http("POST", `/api/workspaces/${id}/gates/gate-P1/review`, undefined, '{"decision":"approve"}', {
        "Content-Type": "text/plain",
      });
      expect(r.status).toBe(415);
      expect(h.store.get(id)?.status).toBe("waiting_human");
    });
  });

  describe("POST /api/workspaces/:id/retry", () => {
    async function exceeded() {
      const r = h.running();
      h.runner.results.set("npm run build", { exitCode: 1 });
      for (let i = 0; i < 3; i++) await h.service.runGateCheck(r.groupId, "gate-P2");
      h.finish(r.orchestratorId);
      return r;
    }

    it("指示付きで 200 と running", async () => {
      const { id } = await exceeded();
      const r = await http("POST", `/api/workspaces/${id}/retry`, { instruction: "build 設定を見直して" });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("running");
      expect(r.json.gateResults.find((g: { gateId: string }) => g.gateId === "gate-P2").retryInstructions[0].text).toBe(
        "build 設定を見直して",
      );
    });

    it("body 省略（空 body・Content-Type なし）でも 200", async () => {
      const { id } = await exceeded();
      const r = await http("POST", `/api/workspaces/${id}/retry`);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("running");
    });

    it("instruction が文字列でなければ 400、gate_retry_exceeded でなければ 409、不明は 404", async () => {
      const { id } = await exceeded();
      expect((await http("POST", `/api/workspaces/${id}/retry`, { instruction: 1 })).status).toBe(400);
      const running = h.running();
      expect((await http("POST", `/api/workspaces/${running.id}/retry`, {})).status).toBe(409);
      expect((await http("POST", "/api/workspaces/ws-nope/retry", {})).status).toBe(404);
    });
  });

  describe("POST /api/workspaces/:id/irregulars/:gateChangeId/ack", () => {
    it("acknowledgedAt を付けて 200。不明な ID は 404", async () => {
      const { id, groupId } = h.running();
      const steps = structuredClone(h.steps(groupId));
      steps.find((s) => s.stepId === "gate-P3")!.role = "text-review";
      h.service.applyLedgerUpdate(groupId, { scheduledSteps: steps, irregular: true, reason: "x" });

      const r = await http("POST", `/api/workspaces/${id}/irregulars/gc-1/ack`);
      expect(r.status).toBe(200);
      expect(r.json.gateChanges[0].acknowledgedAt).toBeDefined();
      expect((await http("POST", `/api/workspaces/${id}/irregulars/gc-99/ack`)).status).toBe(404);
      expect((await http("POST", "/api/workspaces/ws-nope/irregulars/gc-1/ack")).status).toBe(404);
    });
  });

  describe("GET /api/workspaces/:id/reviews/:file", () => {
    let id: string;
    let reviewsDir: string;

    beforeAll(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const r = h.running();
      id = r.id;
      h.service.reportGateResult(r.groupId, "gate-P1", 0, true);
      mkdirSync(join(h.projDir, "mock"), { recursive: true });
      writeFileSync(join(h.projDir, "mock", "ui.html"), "<h1>モック</h1>");
      const doc = reviewDoc();
      (doc["sections"] as unknown[]).push({ id: "mock", heading: "モック", kind: "file", path: "mock/ui.html" });
      h.service.requestHumanReview(r.groupId, "gate-P1", `agent:${h.writerReports(r.groupId, doc)}`);
      reviewsDir = join(h.dir, "workspaces", id, "reviews");
      writeFileSync(join(h.dir, "secret.txt"), "TOP SECRET");
      symlinkSync(join(h.dir, "secret.txt"), join(reviewsDir, "link.txt"));
      writeFileSync(join(reviewsDir, "data.json"), '{"a":1}');
      writeFileSync(join(reviewsDir, "blob.bin"), "xx");
    });

    it("レビュー資料の HTML を text/html で配信し、CSP と nosniff を付ける", async () => {
      const r = await http("GET", `/api/workspaces/${id}/reviews/gate-P1-v1.html`);
      expect(r.status).toBe(200);
      expect(r.body).toContain("設計レビュー");
      const ct = await headerOf(`/api/workspaces/${id}/reviews/gate-P1-v1.html`, {}, "content-type");
      expect(ct).toBe("text/html; charset=utf-8");
      const csp = await headerOf(`/api/workspaces/${id}/reviews/gate-P1-v1.html`, {}, "content-security-policy");
      expect(csp).toBe(REVIEW_CSP);
      const nosniff = await headerOf(`/api/workspaces/${id}/reviews/gate-P1-v1.html`, {}, "x-content-type-options");
      expect(nosniff).toBe("nosniff");
    });

    it("file 節の複製ファイル（a/b のようなサブパス）も配信する", async () => {
      const r = await http("GET", `/api/workspaces/${id}/reviews/gate-P1-v1.files/ui.html`);
      expect(r.status).toBe(200);
      expect(r.body).toBe("<h1>モック</h1>");
      const encoded = await http("GET", `/api/workspaces/${id}/reviews/gate-P1-v1.files%2Fui.html`);
      expect(encoded.status).toBe(200);
    });

    it("拡張子から Content-Type を決める", async () => {
      expect(await headerOf(`/api/workspaces/${id}/reviews/data.json`, {}, "content-type")).toContain("application/json");
      expect(await headerOf(`/api/workspaces/${id}/reviews/blob.bin`, {}, "content-type")).toBe("application/octet-stream");
      expect(await headerOf(`/api/workspaces/${id}/reviews/data.json`, {}, "content-security-policy")).toBe(REVIEW_CSP);
    });

    it(".. を含むパス・絶対パスは 400（デコード後に判定する）", async () => {
      const bad = [
        "..%2Fworkspace.json",
        "%2e%2e%2fworkspace.json",
        "gate-P1-v1.files%2F..%2F..%2Fworkspace.json",
        "%2Fetc%2Fpasswd",
        "..%5Cworkspace.json",
        "%00",
      ];
      for (const file of bad) {
        const r = await http("GET", `/api/workspaces/${id}/reviews/${file}`);
        expect(r.status, file).toBe(400);
        expect(r.body).not.toContain("TOP SECRET");
      }
    });

    it("リテラルの .. セグメント（HTTP クライアントは正規化するので生のソケットで送る）は 400", async () => {
      for (const file of ["../workspace.json", "gate-P1-v1.files/../../workspace.json", "%2e%2e/workspace.json"]) {
        const status = await rawGetStatus(`/api/workspaces/${id}/reviews/${file}`);
        expect(status, file).toBe(400);
      }
    });

    it("存在しないファイル・ディレクトリ・reviews/ の外を指すシンボリックリンクは 404", async () => {
      expect((await http("GET", `/api/workspaces/${id}/reviews/nope.html`)).status).toBe(404);
      expect((await http("GET", `/api/workspaces/${id}/reviews/gate-P1-v1.files`)).status).toBe(404);
      const link = await http("GET", `/api/workspaces/${id}/reviews/link.txt`);
      expect(link.status).toBe(404);
      expect(link.body).not.toContain("TOP SECRET");
    });

    it("不明な Workspace は 404、reviews/ の指定が空なら 404、POST は 405", async () => {
      expect((await http("GET", "/api/workspaces/ws-nope/reviews/gate-P1-v1.html")).status).toBe(404);
      expect((await http("GET", `/api/workspaces/${id}/reviews/`)).status).toBe(404);
      expect((await http("POST", `/api/workspaces/${id}/reviews/gate-P1-v1.html`, {})).status).toBe(405);
    });

    it("foreign Origin は 403", async () => {
      const r = await http("GET", `/api/workspaces/${id}/reviews/gate-P1-v1.html`, undefined, undefined, {
        Origin: "http://evil.example",
      });
      expect(r.status).toBe(403);
    });
  });

  it("WebSocket: 承認で workspace:updated、ゲート記録で workspace:gate_result が配信される", async () => {
    const { ws: client, messages } = await connectWs();
    try {
      const review = h.review();
      const approved = await http("POST", `/api/workspaces/${review.id}/approve`, {});
      expect(approved.status).toBe(200);
      h.service.reportGateResult(approved.json.groupId, "gate-final", 0, true);
      await waitFor(() => messages.some((m) => m.type === "workspace:gate_result"));
      expect(
        messages.some((m) => m.type === "workspace:updated" && m.data.id === review.id && m.data.status === "running"),
      ).toBe(true);
    } finally {
      client.close();
    }
  });
});
