// ============================================================
// report_gate_result ツール テスト（docs/spec.md §2.2.13）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleReportGateResult } from "../../../src/mcp/tools/report-gate-result.js";
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

describe("report_gate_result", () => {
  let h: RunHarness;

  beforeEach(() => {
    h = createRunHarness();
  });
  afterEach(() => h.cleanup());

  it("agent-review の合格を記録し §2.2.13 の形で返す", () => {
    const { groupId } = h.running();
    const res = handleReportGateResult(
      h.manager,
      { groupId, gateId: "gate-P1", checkIndex: 0, passed: true, note: "矛盾なし" },
      h.service,
    );
    expect(res).not.toHaveProperty("isError");
    expect(parse(res)).toEqual({
      registered: true,
      gateId: "gate-P1",
      checkIndex: 0,
      attempt: 1,
      gateStatus: "auto_passed",
      failedAttempts: 0,
      maxRetries: 2,
      retryLimitExceeded: false,
    });
  });

  it("note は省略できる", () => {
    const { groupId } = h.running();
    const res = handleReportGateResult(h.manager, { groupId, gateId: "gate-final", checkIndex: 0, passed: true }, h.service);
    expect(parse(res).gateStatus).toBe("passed");
  });

  it("上限超過で retryLimitExceeded と instruction", () => {
    const { groupId } = h.running();
    const args = { groupId, gateId: "gate-final", checkIndex: 0, passed: false };
    handleReportGateResult(h.manager, args, h.service);
    handleReportGateResult(h.manager, args, h.service);
    const body = parse(handleReportGateResult(h.manager, args, h.service));
    expect(body.retryLimitExceeded).toBe(true);
    expect(body.instruction).toContain("差し戻し上限超過で一時停止");
  });

  it.each([
    [{ gateId: "gate-P1", checkIndex: 9 }, "CHECK_NOT_FOUND"],
    [{ gateId: "gate-P1", checkIndex: 1 }, "CHECK_METHOD_MISMATCH"], // human
    [{ gateId: "gate-P2", checkIndex: 0 }, "CHECK_METHOD_MISMATCH"], // command
    [{ gateId: "nope", checkIndex: 0 }, "GATE_NOT_FOUND"],
  ])("%j → %s", (partial, code) => {
    const { groupId } = h.running();
    const res = handleReportGateResult(h.manager, { groupId, passed: true, ...partial }, h.service);
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ error: true, code });
  });

  it("GROUP_NOT_FOUND / NOT_WORKSPACE_GROUP / WORKSPACE_NOT_RUNNING", () => {
    const { id, groupId } = h.running();
    expect(
      parse(handleReportGateResult(h.manager, { groupId: "grp-nope", gateId: "g", checkIndex: 0, passed: true }, h.service)).code,
    ).toBe("GROUP_NOT_FOUND");
    const g = h.manager.createGroup("普通", "magentic");
    expect(
      parse(handleReportGateResult(h.manager, { groupId: g.id, gateId: "g", checkIndex: 0, passed: true }, h.service)).code,
    ).toBe("NOT_WORKSPACE_GROUP");
    expect(
      parse(handleReportGateResult(h.manager, { groupId: g.id, gateId: "g", checkIndex: 0, passed: true })).code,
    ).toBe("NOT_WORKSPACE_GROUP");
    h.service.abort(id);
    expect(
      parse(handleReportGateResult(h.manager, { groupId, gateId: "gate-P1", checkIndex: 0, passed: true }, h.service)).code,
    ).toBe("WORKSPACE_NOT_RUNNING");
  });
});
