// ============================================================
// request_human_review ツール テスト（docs/spec.md §2.2.14）
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { handleRequestHumanReview } from "../../../src/mcp/tools/request-human-review.js";
import { createRunHarness, reviewDoc, type RunHarness } from "../../workspace/harness.js";

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

describe("request_human_review", () => {
  let h: RunHarness;

  beforeEach(() => {
    h = createRunHarness();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    h.cleanup();
    vi.restoreAllMocks();
  });

  it("§2.2.14 の形で返し、レビュー資料を保存して waiting_human にする", () => {
    const { id, groupId } = h.running();
    h.service.reportGateResult(groupId, "gate-P1", 0, true);
    const writer = h.writerReports(groupId, reviewDoc());

    const res = handleRequestHumanReview(
      h.manager,
      { groupId, gateId: "gate-P1", reviewDocPath: `agent:${writer}` },
      h.service,
    );
    expect(res).not.toHaveProperty("isError");
    const body = parse(res);
    expect(body).toMatchObject({
      registered: true,
      gateId: "gate-P1",
      reviewVersion: 1,
      reviewFile: "reviews/gate-P1-v1.html",
      status: "waiting_human",
    });
    expect(body.next).toContain("report_result");
    expect(existsSync(join(h.dir, "workspaces", id, "reviews", "gate-P1-v1.html"))).toBe(true);
    expect(h.store.get(id)?.status).toBe("waiting_human");
  });

  it.each([
    ["gate-P3", "NO_HUMAN_CHECK"],
    ["gate-P1", "AUTO_CHECKS_NOT_PASSED"],
    ["nope", "GATE_NOT_FOUND"],
  ])("ゲート %s → %s", (gateId, code) => {
    const { groupId } = h.running();
    const writer = h.writerReports(groupId, reviewDoc());
    const res = handleRequestHumanReview(h.manager, { groupId, gateId, reviewDocPath: `agent:${writer}` }, h.service);
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ error: true, code });
  });

  it("REVIEW_DOC_NOT_FOUND / REVIEW_DOC_INVALID", () => {
    const { groupId } = h.running();
    h.service.reportGateResult(groupId, "gate-P1", 0, true);
    expect(
      parse(handleRequestHumanReview(h.manager, { groupId, gateId: "gate-P1", reviewDocPath: "agent:nope-1" }, h.service)).code,
    ).toBe("REVIEW_DOC_NOT_FOUND");
    const bad = h.writerReports(groupId, "JSON ではない");
    const res = handleRequestHumanReview(h.manager, { groupId, gateId: "gate-P1", reviewDocPath: `agent:${bad}` }, h.service);
    expect(parse(res).code).toBe("REVIEW_DOC_INVALID");
  });

  it("GROUP_NOT_FOUND / NOT_WORKSPACE_GROUP / WORKSPACE_NOT_RUNNING", () => {
    const { id, groupId } = h.running();
    const args = { gateId: "gate-P1", reviewDocPath: "agent:x" };
    expect(parse(handleRequestHumanReview(h.manager, { groupId: "grp-nope", ...args }, h.service)).code).toBe("GROUP_NOT_FOUND");
    const g = h.manager.createGroup("普通", "magentic");
    expect(parse(handleRequestHumanReview(h.manager, { groupId: g.id, ...args }, h.service)).code).toBe("NOT_WORKSPACE_GROUP");
    expect(parse(handleRequestHumanReview(h.manager, { groupId: g.id, ...args })).code).toBe("NOT_WORKSPACE_GROUP");
    h.service.abort(id);
    expect(parse(handleRequestHumanReview(h.manager, { groupId, ...args }, h.service)).code).toBe("WORKSPACE_NOT_RUNNING");
  });
});
