// ============================================================
// WorkspaceService テスト（計画生成・再計画・中断。docs/spec.md §13.2 / §13.7）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../src/agent/manager.js";
import { WorkspaceStore } from "../../src/workspace/store.js";
import { WorkspaceService } from "../../src/workspace/service.js";
import { resolve } from "node:path";
import type {
  AgentState,
  AppConfig,
  HealthCheckResult,
  ValidationIssue,
  WorkPlan,
} from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

vi.mock("../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

const ROLE_IDS = [
  "research",
  "design",
  "impl-code",
  "impl-test",
  "code-review",
  "text-review",
  "text-writer",
];

function createTestConfig(opts: { planner?: boolean } = {}): AppConfig {
  const roles: AppConfig["roles"] = [
    {
      id: "orchestrator",
      name: "オーケストレーター",
      description: "統括",
      provider: "claude",
      model: "claude-fable-5-1",
      systemPrompt: "x",
      healthCheckPrompt: "OK",
    },
    ...ROLE_IDS.map((id) => ({
      id,
      name: `職種 ${id}`,
      description: `${id} の説明`,
      provider: "cursor" as const,
      model: "composer-2.5-fast",
      systemPrompt: "x",
      healthCheckPrompt: "OK",
    })),
  ];
  if (opts.planner !== false) {
    roles.splice(1, 0, {
      id: "planner",
      name: "計画立案者",
      description: "計画を作る",
      provider: "claude",
      model: "opus",
      systemPrompt: "あなたは Planner です。",
      healthCheckPrompt: "OK",
    });
  }
  return {
    dashboard: { port: 9696 },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles,
  };
}

function planJson(mutate?: (p: Record<string, unknown>) => void): string {
  const { revision: _r, maxIterations: _m, ...input } = makeAuthPlan();
  const obj = input as unknown as Record<string, unknown>;
  mutate?.(obj);
  return JSON.stringify(obj);
}

function healthResult(roleId: string, available: boolean): HealthCheckResult {
  return {
    roleId,
    provider: "cursor",
    modelValidation: { status: available ? "available" : "unavailable", checkedAt: "" },
    healthCheck: { status: available ? "passed" : "failed", checkedAt: "" },
    available,
  } as HealthCheckResult;
}

describe("WorkspaceService", () => {
  let dir: string;
  let projDir: string;
  let config: AppConfig;
  let manager: AgentManager;
  let store: WorkspaceStore;
  let service: WorkspaceService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockKill: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExecute: ReturnType<typeof vi.fn>;
  let events: { name: string; data: unknown }[];

  const NAMES = [
    "workspace:created",
    "workspace:updated",
    "workspace:plan_generating",
    "workspace:plan_ready",
    "workspace:plan_failed",
  ];

  function setup(c: AppConfig = createTestConfig()): void {
    config = c;
    manager = new AgentManager(config);
    store = new WorkspaceStore(dir);
    service = new WorkspaceService(config, manager, store);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockKill = (manager as any).executor.kill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecute = (manager as any).executor.execute;
    events = [];
    for (const name of NAMES) service.on(name, (data) => events.push({ name, data }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kuromajutsu-service-"));
    projDir = join(dir, "proj");
    mkdirSync(projDir);
    setup();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const planners = (): AgentState[] => manager.listAgents().filter((a) => a.role === "planner");
  const latestPlanner = (): AgentState => {
    const list = planners();
    return list[list.length - 1] as AgentState;
  };
  const eventsOf = (name: string) => events.filter((e) => e.name === name).map((e) => e.data);

  /** Planner Agent が計画 JSON を報告する */
  function report(agent: AgentState, response: string, status: "success" | "failure" = "success"): void {
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.reportResult(agent.agentId, { status, summary: "計画を作成", response });
  }

  function createReadyWorkspace() {
    const ws = service.create({ instruction: "認証を追加して", workspacePath: projDir });
    report(latestPlanner(), planJson());
    return ws;
  }

  // ----------------------------------------------------
  // create
  // ----------------------------------------------------

  describe("create", () => {
    it("planning の Workspace を作り、Planner Agent を 1 つ起動する", () => {
      const ws = service.create({ instruction: "認証を追加して", workspacePath: projDir });

      expect(ws.status).toBe("planning");
      expect(ws.workspacePath).toBe(projDir);
      expect(service.get(ws.id)).toBe(ws);
      expect(service.list()).toHaveLength(1);

      expect(planners()).toHaveLength(1);
      const options = mockExecute.mock.calls[0][1];
      expect(options.workingDirectory).toBe(projDir);
      expect(options.prompt).toContain("認証を追加して");
    });

    it("グループ「Workspace <id> 計画生成」を Concurrent で作り workspaceId を設定する", () => {
      const ws = service.create({ instruction: "x" });
      const group = manager.getGroup(latestPlanner().groupId);
      expect(group?.description).toBe(`Workspace ${ws.id} 計画生成`);
      expect(group?.mode).toBe("concurrent");
      expect(group?.workspaceId).toBe(ws.id);
    });

    it("workspacePath 省略時は process.cwd()", () => {
      const ws = service.create({ instruction: "x" });
      expect(ws.workspacePath).toBe(process.cwd());
    });

    it("プロンプトには利用可能な職種のみを含み、orchestrator / planner / Provider は含まない", () => {
      service.create({ instruction: "x" });
      const prompt = mockExecute.mock.calls[0][1].prompt as string;
      expect(prompt).toContain("impl-code");
      expect(prompt).not.toContain("orchestrator");
      expect(prompt).not.toContain("計画立案者");
      expect(prompt).not.toContain("composer-2.5-fast");
    });

    it("ヘルスチェック未通過の職種はプロンプトの職種一覧から除く", () => {
      manager.setHealthCheckResults([healthResult("research", false)]);
      service.create({ instruction: "x" });
      const prompt = mockExecute.mock.calls[0][1].prompt as string;
      expect(prompt).not.toContain("- research（");
      expect(prompt).toContain("- design（");
    });

    it("workspace:plan_generating を emit する", () => {
      const ws = service.create({ instruction: "x" });
      expect(eventsOf("workspace:created")).toHaveLength(1);
      expect(eventsOf("workspace:plan_generating")).toEqual([
        expect.objectContaining({ workspaceId: ws.id, revision: 1 }),
      ]);
    });

    it("指示が空白のみなら INVALID_INSTRUCTION", () => {
      expect(() => service.create({ instruction: "  \n " })).toThrowError(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
      expect(service.list()).toHaveLength(0);
    });

    it("planner 職種が無ければ PLANNER_UNAVAILABLE（Workspace は作らない）", () => {
      setup(createTestConfig({ planner: false }));
      expect(() => service.create({ instruction: "x" })).toThrowError(
        expect.objectContaining({ code: "PLANNER_UNAVAILABLE" }),
      );
      expect(service.list()).toHaveLength(0);
    });

    it("planner のヘルスチェックが未通過なら PLANNER_UNAVAILABLE", () => {
      manager.setHealthCheckResults([healthResult("planner", false)]);
      expect(() => service.create({ instruction: "x" })).toThrowError(
        expect.objectContaining({ code: "PLANNER_UNAVAILABLE" }),
      );
      expect(service.list()).toHaveLength(0);
    });
  });

  // ----------------------------------------------------
  // 計画生成の完了
  // ----------------------------------------------------

  describe("計画生成の完了", () => {
    it("成功すると revision 1 を保存して review になり plan_ready を emit する", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), planJson());

      const got = service.get(ws.id);
      expect(got?.status).toBe("review");
      expect(got?.revisions).toHaveLength(1);
      const rev = got?.revisions[0] as WorkPlan;
      expect(rev.revision).toBe(1);
      expect(rev.maxIterations).toBeGreaterThanOrEqual(10);
      expect(rev.title).toBe("認証機能（JWT）の追加");

      const ready = eventsOf("workspace:plan_ready") as {
        workspaceId: string;
        revision: number;
        validation: ValidationIssue[];
      }[];
      expect(ready).toHaveLength(1);
      expect(ready[0]).toMatchObject({ workspaceId: ws.id, revision: 1 });
      expect(ready[0]?.validation.filter((i) => i.level === "error" && !i.autoFixed)).toEqual([]);
      expect(service.getValidation(ws.id)).toEqual(ready[0]?.validation);
    });

    it("revision に、この計画を作らせた指示（request）を保存する。初回は最初の指示", () => {
      const ws = service.create({ instruction: "認証を追加して", workspacePath: projDir });
      report(latestPlanner(), planJson());
      const rev = service.get(ws.id)?.revisions[0] as WorkPlan;
      expect(rev.request).toEqual({ instruction: "認証を追加して", at: expect.any(String) });
      expect(Number.isNaN(Date.parse(rev.request?.at ?? ""))).toBe(false);
      expect(rev.request?.targets).toBeUndefined();
    });

    it("再計画の revision には追加指示と対象を保存する。前の計画の request は Planner に渡さない", () => {
      const ws = createReadyWorkspace();
      service.replan(ws.id, {
        instruction: "P2 の手順を今決めて",
        targets: [{ kind: "phase", id: "P2" }],
      });
      const prompt = mockExecute.mock.calls[mockExecute.mock.calls.length - 1][1].prompt as string;
      expect(prompt).not.toContain('"request"');
      report(latestPlanner(), planJson());
      const rev2 = service.get(ws.id)?.revisions[1] as WorkPlan;
      expect(rev2.request).toEqual({
        instruction: "P2 の手順を今決めて",
        targets: [{ kind: "phase", id: "P2" }],
        at: expect.any(String),
      });
      // 1 つ目の revision は初回の指示のまま
      expect((service.get(ws.id)?.revisions[0] as WorkPlan).request?.instruction).toBe("認証を追加して");
    });

    it("Planner の出力に request があっても無視する（サーバーが付与する）", () => {
      const ws = service.create({ instruction: "本物の指示", workspacePath: projDir });
      report(
        latestPlanner(),
        planJson((p) => {
          p["request"] = { instruction: "偽", at: "2000-01-01T00:00:00.000Z" };
        }),
      );
      expect((service.get(ws.id)?.revisions[0] as WorkPlan).request?.instruction).toBe("本物の指示");
    });

    it("コードフェンス付きの出力も受理する", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), `計画です\n\`\`\`json\n${planJson()}\n\`\`\``);
      expect(service.get(ws.id)?.status).toBe("review");
    });

    it("自動修正（出口ゲートの挿入）を適用して保存する", () => {
      const ws = service.create({ instruction: "x" });
      report(
        latestPlanner(),
        planJson((p) => {
          p["steps"] = (p["steps"] as { id: string }[]).filter((s) => s.id !== "gate-P3");
        }),
      );
      const rev = service.get(ws.id)?.revisions[0] as WorkPlan;
      expect(rev.steps.some((s) => s.kind === "gate" && s.phaseId === "P3")).toBe(true);
    });

    it("V6: ヘルスチェック未通過の職種を使った計画は validation に V6 error", () => {
      manager.setHealthCheckResults([healthResult("impl-test", false)]);
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), planJson());

      // 検証エラーがあっても revision として保存し review にする
      expect(service.get(ws.id)?.status).toBe("review");
      expect(service.get(ws.id)?.revisions).toHaveLength(1);
      const v6 = service.getValidation(ws.id).filter((i) => i.rule === "V6");
      expect(v6).toHaveLength(1);
      expect(v6[0]?.level).toBe("error");
    });

    it("orchestrator / planner を手順の職種に使うと V6 error", () => {
      const ws = service.create({ instruction: "x" });
      report(
        latestPlanner(),
        planJson((p) => {
          const steps = p["steps"] as { id: string; role: string }[];
          (steps.find((s) => s.id === "s1") as { role: string }).role = "orchestrator";
        }),
      );
      expect(service.getValidation(ws.id).some((i) => i.rule === "V6" && i.level === "error")).toBe(
        true,
      );
    });

    it("リスナーを解除する（完了後の別 Agent の完了で状態が変わらない）", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), planJson());
      const before = service.get(ws.id)?.updatedAt;
      expect(manager.listenerCount("agent:completed")).toBe(0);
      expect(service.get(ws.id)?.updatedAt).toBe(before);
    });

    it("revision が無い Workspace の getValidation は []", () => {
      const ws = service.create({ instruction: "x" });
      expect(service.getValidation(ws.id)).toEqual([]);
    });

    it("getValidation: 不明な ID は NOT_FOUND", () => {
      expect(() => service.getValidation("ws-nope")).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });
  });

  // ----------------------------------------------------
  // リトライ・失敗
  // ----------------------------------------------------

  describe("不正な出力のリトライ", () => {
    it("不正 JSON → 同じグループで 2 つ目の Agent を起動し、プロンプトにエラーを含める", () => {
      const ws = service.create({ instruction: "x" });
      const first = latestPlanner();
      report(first, "計画を作りました（JSON なし）");

      expect(planners()).toHaveLength(2);
      const second = latestPlanner();
      expect(second.agentId).not.toBe(first.agentId);
      expect(second.groupId).toBe(first.groupId);
      const prompt = mockExecute.mock.calls[1][1].prompt as string;
      expect(prompt).toContain("不備");
      expect(prompt).toContain("JSON が見つかりません");
      expect(service.get(ws.id)?.status).toBe("planning");
    });

    it("スキーマ違反のエラー内容をリトライのプロンプトに含める", () => {
      service.create({ instruction: "x" });
      report(latestPlanner(), JSON.stringify({ title: "x" }));
      const prompt = mockExecute.mock.calls[1][1].prompt as string;
      expect(prompt).toContain("phases");
    });

    it("リトライで成功すれば review になる", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), "not json");
      report(latestPlanner(), planJson());
      expect(service.get(ws.id)?.status).toBe("review");
      expect(service.get(ws.id)?.revisions).toHaveLength(1);
      expect(eventsOf("workspace:plan_failed")).toHaveLength(0);
    });

    it("2 回目も不正なら failed（plan_failed）で plan_failed を emit する", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), "not json");
      report(latestPlanner(), "still not json");

      const got = service.get(ws.id);
      expect(got?.status).toBe("failed");
      expect(got?.statusReason?.code).toBe("plan_failed");
      expect(got?.statusReason?.message).toContain("JSON が見つかりません");
      expect(got?.revisions).toHaveLength(0);
      expect(planners()).toHaveLength(2); // 3 つ目は起動しない
      expect(eventsOf("workspace:plan_failed")).toEqual([
        expect.objectContaining({ workspaceId: ws.id }),
      ]);
    });

    it("Agent が failure を報告 / 結果なしで終了した場合もリトライ対象", () => {
      const ws = service.create({ instruction: "x" });
      report(latestPlanner(), "", "failure");
      expect(planners()).toHaveLength(2);

      // 報告なしでプロセスが終了（result なし）
      const second = latestPlanner();
      manager.updateAgentState(second.agentId, { status: "running" });
      manager.updateAgentState(second.agentId, { status: "failed" });
      expect(service.get(ws.id)?.status).toBe("failed");
      expect(service.get(ws.id)?.statusReason?.code).toBe("plan_failed");
    });

    it("別の Agent の完了イベントは無視する", () => {
      const ws = service.create({ instruction: "x" });
      const group = manager.createGroup("other");
      const other = manager.startAgent(group.id, config.roles.find((r) => r.id === "design")!, "p");
      manager.updateAgentState(other.agentId, { status: "running" });
      manager.reportResult(other.agentId, { status: "success", summary: "s", response: planJson() });
      expect(service.get(ws.id)?.status).toBe("planning");
      expect(planners()).toHaveLength(1);
    });
  });

  // ----------------------------------------------------
  // replan
  // ----------------------------------------------------

  describe("replan", () => {
    it("review → planning にして Planner を起動する（前の計画・追加指示・対象を渡す）", () => {
      const ws = createReadyWorkspace();
      const calls = mockExecute.mock.calls.length;

      const got = service.replan(ws.id, {
        instruction: "出口ゲートを人間レビューにして",
        targets: [{ kind: "phase", id: "P3" }],
      });

      expect(got.status).toBe("planning");
      expect(planners()).toHaveLength(2);
      const call = mockExecute.mock.calls[calls];
      expect(call[1].workingDirectory).toBe(projDir);
      const prompt = call[1].prompt as string;
      expect(prompt).toContain("前の計画");
      expect(prompt).toContain("出口ゲートを人間レビューにして");
      expect(prompt).toContain("@P3 テストを実装する（フェーズ）");
      expect(eventsOf("workspace:plan_generating")).toContainEqual(
        expect.objectContaining({ workspaceId: ws.id, revision: 2 }),
      );
    });

    it("成功すると revision 2 を追加して review に戻る", () => {
      const ws = createReadyWorkspace();
      service.replan(ws.id, { instruction: "変更して" });
      report(
        latestPlanner(),
        planJson((p) => {
          p["title"] = "改訂版";
        }),
      );

      const got = service.get(ws.id);
      expect(got?.status).toBe("review");
      expect(got?.revisions).toHaveLength(2);
      expect(got?.revisions[1]?.revision).toBe(2);
      expect(got?.revisions[1]?.title).toBe("改訂版");
      expect(got?.revisions[0]?.title).toBe("認証機能（JWT）の追加");
    });

    it("2 回失敗すると revision 1 のまま review に戻り plan_failed を emit する", () => {
      const ws = createReadyWorkspace();
      service.replan(ws.id, { instruction: "変更して" });
      report(latestPlanner(), "bad");
      report(latestPlanner(), "bad again");

      const got = service.get(ws.id);
      expect(got?.status).toBe("review");
      expect(got?.statusReason).toBeUndefined();
      expect(got?.revisions).toHaveLength(1);
      expect(eventsOf("workspace:plan_failed")).toHaveLength(1);
    });

    it("review 以外は INVALID_STATE", () => {
      const ws = service.create({ instruction: "x" }); // planning
      expect(() => service.replan(ws.id, { instruction: "y" })).toThrowError(
        expect.objectContaining({ code: "INVALID_STATE" }),
      );
    });

    it("指示が空白のみなら INVALID_INSTRUCTION、不明な ID は NOT_FOUND", () => {
      const ws = createReadyWorkspace();
      expect(() => service.replan(ws.id, { instruction: " " })).toThrowError(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
      expect(() => service.replan("ws-nope", { instruction: "y" })).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });

    it("planner が使えなくなっていたら PLANNER_UNAVAILABLE で状態は review のまま", () => {
      const ws = createReadyWorkspace();
      manager.setHealthCheckResults([healthResult("planner", false)]);
      expect(() => service.replan(ws.id, { instruction: "y" })).toThrowError(
        expect.objectContaining({ code: "PLANNER_UNAVAILABLE" }),
      );
      expect(service.get(ws.id)?.status).toBe("review");
    });
  });

  // ----------------------------------------------------
  // abort
  // ----------------------------------------------------

  describe("abort", () => {
    it("planning 中は Planner Agent を停止して aborted（user_abort）にする", () => {
      const ws = service.create({ instruction: "x" });
      const agent = latestPlanner();
      manager.updateAgentState(agent.agentId, { status: "running" });

      const got = service.abort(ws.id);

      expect(mockKill).toHaveBeenCalledWith(agent.agentId);
      expect(got.status).toBe("aborted");
      expect(got.statusReason?.code).toBe("user_abort");
    });

    it("停止した Agent の完了イベントは無視する（リトライも起動しない）", () => {
      const ws = service.create({ instruction: "x" });
      const agent = latestPlanner();
      manager.updateAgentState(agent.agentId, { status: "running" });
      service.abort(ws.id);

      manager.updateAgentState(agent.agentId, { status: "failed" });
      expect(planners()).toHaveLength(1);
      expect(service.get(ws.id)?.status).toBe("aborted");
      expect(eventsOf("workspace:plan_failed")).toHaveLength(0);
    });

    it("再計画中の abort も aborted（revisions は保持）", () => {
      const ws = createReadyWorkspace();
      service.replan(ws.id, { instruction: "y" });
      const got = service.abort(ws.id);
      expect(got.status).toBe("aborted");
      expect(got.revisions).toHaveLength(1);
    });

    it("review 中は Agent の停止なしで aborted", () => {
      const ws = createReadyWorkspace();
      mockKill.mockClear();
      const got = service.abort(ws.id);
      expect(got.status).toBe("aborted");
      expect(got.statusReason?.code).toBe("user_abort");
      expect(mockKill).not.toHaveBeenCalled();
    });

    it("running の Workspace も中断できる（実行系の中断は service-run.test.ts で検証）", () => {
      const ws = createReadyWorkspace();
      store.update(ws.id, (w) => {
        w.status = "running";
      });
      const got = service.abort(ws.id);
      expect(got.status).toBe("aborted");
      expect(got.statusReason?.code).toBe("user_abort");
    });

    it("終端状態（aborted / failed / done）は INVALID_STATE", () => {
      const ws = service.create({ instruction: "x" });
      service.abort(ws.id);
      expect(() => service.abort(ws.id)).toThrowError(
        expect.objectContaining({ code: "INVALID_STATE" }),
      );
    });

    it("不明な ID は NOT_FOUND", () => {
      expect(() => service.abort("ws-nope")).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });
  });

  // ----------------------------------------------------
  // イベント中継
  // ----------------------------------------------------

  describe("store イベントの中継", () => {
    it("workspace:created / workspace:updated を service から emit する", () => {
      const ws = service.create({ instruction: "x" });
      expect(eventsOf("workspace:created")).toEqual([expect.objectContaining({ id: ws.id })]);
      report(latestPlanner(), planJson());
      expect(eventsOf("workspace:updated").length).toBeGreaterThan(0);
    });
  });
  // ----------------------------------------------------
  // 入力検証（workspacePath / instruction の長さ）
  // ----------------------------------------------------

  describe("入力検証", () => {
    it("workspacePath は絶対パスに解決して保存する（相対パスは cwd 基準）", () => {
      const rel = "tests/workspace";
      const ws = service.create({ instruction: "x", workspacePath: rel });
      expect(ws.workspacePath).toBe(resolve(rel));
      expect(mockExecute.mock.calls[0][1].workingDirectory).toBe(resolve(rel));
    });

    it("存在しないパスは INVALID_WORKSPACE_PATH（Workspace も Agent も作らない）", () => {
      expect(() =>
        service.create({ instruction: "x", workspacePath: join(projDir, "nope") }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_WORKSPACE_PATH" }));
      expect(service.list()).toHaveLength(0);
      expect(planners()).toHaveLength(0);
    });

    it("ディレクトリでないパスは INVALID_WORKSPACE_PATH", () => {
      const file = join(projDir, "file.txt");
      writeFileSync(file, "x");
      expect(() => service.create({ instruction: "x", workspacePath: file })).toThrowError(
        expect.objectContaining({ code: "INVALID_WORKSPACE_PATH" }),
      );
    });

    it("instruction は 100,000 文字まで（超過は INVALID_INSTRUCTION）", () => {
      expect(() => service.create({ instruction: "a".repeat(100_001), workspacePath: projDir })).toThrowError(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
      expect(service.list()).toHaveLength(0);
      const ok = service.create({ instruction: "a".repeat(100_000), workspacePath: projDir });
      expect(ok.status).toBe("planning");
    });

    it("replan の instruction も 100,000 文字まで", () => {
      const ws = createReadyWorkspace();
      expect(() => service.replan(ws.id, { instruction: "a".repeat(100_001) })).toThrowError(
        expect.objectContaining({ code: "INVALID_INSTRUCTION" }),
      );
      expect(service.get(ws.id)?.status).toBe("review");
    });

    it("再計画のプロンプトの前の計画はインデントなしの JSON", () => {
      const ws = createReadyWorkspace();
      mockExecute.mockClear();
      service.replan(ws.id, { instruction: "y" });
      const prompt = mockExecute.mock.calls[0][1].prompt as string;
      expect(prompt).toContain('"id":"gate-P3"');
      expect(prompt).not.toContain('"id": "gate-P3"');
    });

    it("保存する計画の spec.workspace を作業ディレクトリに揃える", () => {
      const ws = service.create({ instruction: "x", workspacePath: projDir });
      report(latestPlanner(), planJson()); // fixtures の spec.workspace は "/tmp/project"
      expect(service.get(ws.id)?.revisions[0]?.spec.workspace).toBe(projDir);
    });
  });

  // ----------------------------------------------------
  // 例外・同時実行・リスナー・グループ
  // ----------------------------------------------------

  describe("堅牢性", () => {
    const completedListeners = () => manager.listenerCount("agent:completed");

    it("完了処理で store.update が例外を投げても failed にして plan_failed を emit する", () => {
      const ws = service.create({ instruction: "x", workspacePath: projDir });
      const spy = vi.spyOn(store, "update").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      // 例外は report_result を呼んだ側に伝播しない
      expect(() => report(latestPlanner(), planJson())).not.toThrow();
      spy.mockRestore();

      const got = service.get(ws.id);
      expect(got?.status).toBe("failed");
      expect(got?.statusReason?.code).toBe("plan_failed");
      expect(got?.statusReason?.message).toContain("disk full");
      expect(eventsOf("workspace:plan_failed")).toHaveLength(1);
      expect(completedListeners()).toBe(0);
    });

    it("失敗の確定自体も失敗したら console.error に出し、例外は伝播しない", () => {
      service.create({ instruction: "x", workspacePath: projDir });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const spy = vi.spyOn(store, "update").mockImplementation(() => {
        throw new Error("disk gone");
      });

      expect(() => report(latestPlanner(), planJson())).not.toThrow();

      spy.mockRestore();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      expect(completedListeners()).toBe(0);
    });

    it("再計画の完了処理で例外が出たら revision を維持して review に戻る", () => {
      const ws = createReadyWorkspace();
      service.replan(ws.id, { instruction: "y" });
      const spy = vi.spyOn(store, "update").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      report(latestPlanner(), planJson());
      spy.mockRestore();

      expect(service.get(ws.id)?.status).toBe("review");
      expect(service.get(ws.id)?.revisions).toHaveLength(1);
    });

    it("計画生成中の Workspace が 12 件あってもリスナーは 1 本（MaxListeners を超えない）。全部終わると 0", () => {
      setup({ ...createTestConfig(), agent: { defaultTimeout_ms: 300_000, maxConcurrent: 100 } });
      const created = Array.from({ length: 12 }, (_, i) =>
        service.create({ instruction: `指示 ${i}`, workspacePath: projDir }),
      );
      expect(completedListeners()).toBe(1);
      for (const ws of created.slice(0, 6)) service.abort(ws.id);
      expect(completedListeners()).toBe(1);
      for (const ws of created.slice(6)) service.abort(ws.id);
      expect(completedListeners()).toBe(0);
    });

    it("2 つの Workspace が同時に planning で逆順に完了しても、各自の Planner だけで遷移する", () => {
      const a = service.create({ instruction: "A", workspacePath: projDir });
      const agentA = latestPlanner();
      const b = service.create({ instruction: "B", workspacePath: projDir });
      const agentB = latestPlanner();
      expect(agentA.agentId).not.toBe(agentB.agentId);
      // 計画生成中の Workspace が複数あっても、agent:completed のリスナーは共有の 1 本
      expect(completedListeners()).toBe(1);

      report(
        agentB,
        planJson((p) => {
          p["title"] = "計画 B";
        }),
      );
      expect(service.get(b.id)?.status).toBe("review");
      expect(service.get(b.id)?.revisions[0]?.title).toBe("計画 B");
      expect(service.get(a.id)?.status).toBe("planning");
      expect(service.get(a.id)?.revisions).toHaveLength(0);
      expect(completedListeners()).toBe(1);

      report(
        agentA,
        planJson((p) => {
          p["title"] = "計画 A";
        }),
      );
      expect(service.get(a.id)?.revisions[0]?.title).toBe("計画 A");
      expect(service.get(b.id)?.revisions).toHaveLength(1);
      expect(completedListeners()).toBe(0);
    });

    it("listenerCount: リトライ中 1 / 失敗確定後 0", () => {
      service.create({ instruction: "x", workspacePath: projDir });
      expect(completedListeners()).toBe(1);
      report(latestPlanner(), "bad");
      expect(completedListeners()).toBe(1); // リトライ中
      report(latestPlanner(), "bad");
      expect(completedListeners()).toBe(0);
    });

    it("listenerCount: abort 後 0", () => {
      const ws = service.create({ instruction: "x", workspacePath: projDir });
      expect(completedListeners()).toBe(1);
      service.abort(ws.id);
      expect(completedListeners()).toBe(0);
    });

    it("listenerCount: 再計画の成功後・失敗後とも 0", () => {
      const ws = createReadyWorkspace();
      expect(completedListeners()).toBe(0);

      service.replan(ws.id, { instruction: "1" });
      expect(completedListeners()).toBe(1);
      report(latestPlanner(), planJson());
      expect(completedListeners()).toBe(0);

      service.replan(ws.id, { instruction: "2" });
      report(latestPlanner(), "bad");
      report(latestPlanner(), "bad");
      expect(service.get(ws.id)?.status).toBe("review");
      expect(completedListeners()).toBe(0);
    });

    it("startAgent が例外を投げたら（maxConcurrent 超過など）failed + plan_failed", () => {
      config.agent.maxConcurrent = 0;
      const ws = service.create({ instruction: "x", workspacePath: projDir });

      const got = service.get(ws.id);
      expect(got?.status).toBe("failed");
      expect(got?.statusReason?.code).toBe("plan_failed");
      expect(got?.statusReason?.message).toContain("maxConcurrent");
      expect(eventsOf("workspace:plan_failed")).toHaveLength(1);
      expect(planners()).toHaveLength(0);
      expect(completedListeners()).toBe(0);
    });

    it("再計画で startAgent が例外を投げたら revision を維持して review に戻る", () => {
      const ws = createReadyWorkspace();
      config.agent.maxConcurrent = 0;
      const got = service.replan(ws.id, { instruction: "y" });
      expect(got.status).toBe("review");
      expect(got.revisions).toHaveLength(1);
      expect(eventsOf("workspace:plan_failed")).toHaveLength(1);
    });

    it("spawn が同期的に失敗（status: failed かつ result: null）したらリトライし、成功すれば review", () => {
      mockExecute.mockImplementationOnce(() => {
        throw new Error("spawn ENOENT");
      });
      const ws = service.create({ instruction: "x", workspacePath: projDir });

      // 1 回目は spawn 失敗 → 2 つ目の Agent が起動している
      expect(planners()).toHaveLength(2);
      expect(planners()[0]?.status).toBe("failed");
      expect(service.get(ws.id)?.status).toBe("planning");
      expect(mockExecute.mock.calls[1][1].prompt).toContain("不備");

      report(latestPlanner(), planJson());
      expect(service.get(ws.id)?.status).toBe("review");
      expect(completedListeners()).toBe(0);
    });

    it("spawn が 2 回とも失敗したら failed（3 つ目は起動しない）", () => {
      mockExecute.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });
      const ws = service.create({ instruction: "x", workspacePath: projDir });

      expect(planners()).toHaveLength(2);
      expect(service.get(ws.id)?.status).toBe("failed");
      expect(service.get(ws.id)?.statusReason?.code).toBe("plan_failed");
      expect(completedListeners()).toBe(0);
    });

    const groupOf = (agent: AgentState) => manager.getGroup(agent.groupId);

    it("計画生成グループは成功時に削除される（履歴 Agent は残る）", () => {
      service.create({ instruction: "x", workspacePath: projDir });
      const agent = latestPlanner();
      expect(groupOf(agent)?.status).toBe("active");
      report(agent, planJson());
      expect(groupOf(agent)?.status).toBe("deleted");
      expect(manager.getAgent(agent.agentId)).toBeDefined();
    });

    it("計画生成グループは失敗確定時（リトライを含む同一グループ）に削除される", () => {
      service.create({ instruction: "x", workspacePath: projDir });
      const first = latestPlanner();
      report(first, "bad");
      expect(groupOf(first)?.status).toBe("active"); // リトライ中は同じグループを使う
      report(latestPlanner(), "bad");
      expect(groupOf(first)?.status).toBe("deleted");
    });

    it("計画生成グループは abort 時に削除される", () => {
      const ws = service.create({ instruction: "x", workspacePath: projDir });
      const agent = latestPlanner();
      manager.updateAgentState(agent.agentId, { status: "running" });
      service.abort(ws.id);
      expect(groupOf(agent)?.status).toBe("deleted");
    });

    it("startAgent が例外を投げた場合もグループを削除する（Agent がないグループは消える）", () => {
      const deleted: string[] = [];
      manager.on("group:deleted", (d: { groupId: string }) => deleted.push(d.groupId));
      const created: string[] = [];
      manager.on("group:created", (g: { id: string }) => created.push(g.id));

      config.agent.maxConcurrent = 0;
      service.create({ instruction: "x", workspacePath: projDir });

      expect(created).toHaveLength(1);
      expect(deleted).toEqual(created);
      expect(manager.getGroup(created[0] as string)?.status ?? "deleted").toBe("deleted");
    });
  });
});
