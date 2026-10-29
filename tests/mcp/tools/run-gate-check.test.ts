// ============================================================
// run_gate_check ツール テスト（docs/spec.md §2.2.12）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleRunGateCheck } from "../../../src/mcp/tools/run-gate-check.js";
import { createRunHarness, type RunHarness } from "../../workspace/harness.js";

vi.mock("../../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("run_gate_check", () => {
  let h: RunHarness;

  beforeEach(() => {
    h = createRunHarness();
  });
  afterEach(() => h.cleanup());

  it("合格: §2.2.12 の形で結果を返す", async () => {
    const { groupId } = h.running();
    const res = await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service);
    expect(res).not.toHaveProperty("isError");
    const body = parse(res);
    expect(body).toMatchObject({
      groupId,
      gateId: "gate-P2",
      attempt: 1,
      pendingChecks: [],
      gateStatus: "passed",
      failedAttempts: 0,
      maxRetries: 2,
      retryLimitExceeded: false,
    });
    expect(body.results).toEqual([
      expect.objectContaining({
        checkIndex: 0,
        text: "ビルドが成功する",
        command: "npm run build",
        passed: true,
        exitCode: 0,
        timedOut: false,
        duration_ms: 5,
        stdoutTail: "out of npm run build",
      }),
    ]);
    expect(body.instruction).toBeUndefined();
  });

  it("不合格が続いて上限超過なら retryLimitExceeded: true と instruction を返す", async () => {
    const { groupId } = h.running();
    h.runner.results.set("npm run build", { exitCode: 1 });
    let body = parse(await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service));
    expect(body.gateStatus).toBe("failed");
    await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service);
    body = parse(await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service));
    expect(body.retryLimitExceeded).toBe(true);
    expect(body.failedAttempts).toBe(3);
    expect(body.instruction).toContain("差し戻し上限超過で一時停止");
  });

  it("GROUP_NOT_FOUND", async () => {
    const res = await handleRunGateCheck(h.manager, { groupId: "grp-nope", gateId: "g" }, h.service);
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ error: true, code: "GROUP_NOT_FOUND" });
  });

  it("Workspace に紐付かないグループは NOT_WORKSPACE_GROUP", async () => {
    const g = h.manager.createGroup("普通のグループ", "magentic");
    const res = await handleRunGateCheck(h.manager, { groupId: g.id, gateId: "gate-P2" }, h.service);
    expect(parse(res)).toMatchObject({ error: true, code: "NOT_WORKSPACE_GROUP" });
  });

  it("Workspace サービスが無ければ NOT_WORKSPACE_GROUP", async () => {
    const g = h.manager.createGroup("普通のグループ", "magentic");
    const res = await handleRunGateCheck(h.manager, { groupId: g.id, gateId: "gate-P2" });
    expect(parse(res).code).toBe("NOT_WORKSPACE_GROUP");
  });

  it.each([
    ["nope", "GATE_NOT_FOUND"],
    ["gate-final", "NO_COMMAND_CHECK"],
  ])("ゲート %s → %s", async (gateId, code) => {
    const { groupId } = h.running();
    const res = await handleRunGateCheck(h.manager, { groupId, gateId }, h.service);
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe(code);
  });

  it("停止中の Workspace は WORKSPACE_NOT_RUNNING", async () => {
    const { id, groupId } = h.running();
    h.service.abort(id);
    const res = await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service);
    expect(parse(res).code).toBe("WORKSPACE_NOT_RUNNING");
  });

  it("禁止コマンドは COMMAND_DENIED（実行しない）", async () => {
    const { groupId } = h.running();
    h.config.workspace = {
      gateCommands: { deny: ["npm run build"], allow: [], timeout_ms: 600000, maxOutput_bytes: 1048576 },
    };
    const res = await handleRunGateCheck(h.manager, { groupId, gateId: "gate-P2" }, h.service);
    expect(parse(res).code).toBe("COMMAND_DENIED");
    expect(h.runner.calls).toHaveLength(0);
  });
});
