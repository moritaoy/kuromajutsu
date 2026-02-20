// ============================================================
// report_result ツール テスト
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentManager } from "../../../src/agent/manager.js";
import { handleReportResult } from "../../../src/mcp/tools/report-result.js";
import type { AppConfig } from "../../../src/types/index.js";

// AgentExecutor をモック化
vi.mock("../../../src/agent/executor.js", () => {
  class MockAgentExecutor {
    execute = vi.fn().mockReturnValue(99999);
    kill = vi.fn();
    killAll = vi.fn();
  }
  return { AgentExecutor: MockAgentExecutor };
});

function createTestConfig(): AppConfig {
  return {
    dashboard: { port: 9696 },
    agent: { defaultTimeout_ms: 300_000, maxConcurrent: 10 },
    log: { level: "info" },
    roles: [
      {
        id: "impl-code",
        name: "コード実装者",
        description: "コードの実装・修正を行う",
        model: "claude-4-sonnet",
        systemPrompt: "You are a code implementer.",
        healthCheckPrompt: "OK",
      },
    ],
  };
}

describe("report_result", () => {
  let manager: AgentManager;
  let config: AppConfig;

  beforeEach(() => {
    config = createTestConfig();
    manager = new AgentManager(config);
  });

  it("存在しない Agent ID の場合 AGENT_NOT_FOUND エラーを返す（形式: { error: true, code, message }, isError: true）", () => {
    const result = handleReportResult(manager, {
      agentId: "nonexistent-agent",
      status: "success",
      summary: "完了",
      response: "実施内容の詳細レポート",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe(true);
    expect(data.code).toBe("AGENT_NOT_FOUND");
    expect(typeof data.message).toBe("string");
  });

  it("完了済み Agent に結果を登録できる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test prompt");

    // 正しい順序で状態遷移: queued → running → completed
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    const result = handleReportResult(manager, {
      agentId: agent.agentId,
      status: "success",
      summary: "実装完了",
      response: "src/index.ts にエントリーポイントを実装した。正常に動作することを確認済み。",
      editedFiles: ["src/index.ts"],
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.registered).toBe(true);
    expect(data.agentId).toBe(agent.agentId);
  });

  it("queued/running 状態の Agent に結果登録しようとすると REPORT_FAILED エラーを返す", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // queued のまま報告しようとする
    const result = handleReportResult(manager, {
      agentId: agent.agentId,
      status: "success",
      summary: "completed",
      response: "詳細レポート",
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("REPORT_FAILED");
  });

  it("結果登録後に Agent の status が resultReported に変わる", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // 正しい順序で状態遷移: queued → running → completed
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });
    handleReportResult(manager, {
      agentId: agent.agentId,
      status: "success",
      summary: "done",
      response: "タスク完了の詳細レポート",
    });

    const updatedAgent = manager.getAgent(agent.agentId);
    expect(updatedAgent!.status).toBe("resultReported");
  });

  it("agent:result_reported イベントが発火する", () => {
    const listener = vi.fn();
    manager.on("agent:result_reported", listener);

    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // 正しい順序で状態遷移: queued → running → completed
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });
    handleReportResult(manager, {
      agentId: agent.agentId,
      status: "success",
      summary: "done",
      response: "イベント発火確認用レポート",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].agentId).toBe(agent.agentId);
  });

  it("response が AgentResult に保存される", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test prompt");

    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "completed" });

    handleReportResult(manager, {
      agentId: agent.agentId,
      status: "success",
      summary: "実装完了",
      response: "## 実施内容\nエントリーポイントを実装した。\n## 成果\n全テストパス。",
    });

    const updatedAgent = manager.getAgent(agent.agentId);
    expect(updatedAgent!.result).not.toBeNull();
    expect(updatedAgent!.result!.summary).toBe("実装完了");
    expect(updatedAgent!.result!.response).toBe(
      "## 実施内容\nエントリーポイントを実装した。\n## 成果\n全テストパス。",
    );
  });

  it("失敗結果も登録できる（errorMessage 付き）", () => {
    const group = manager.createGroup("test");
    const agent = manager.startAgent(group.id, config.roles[0], "test");

    // 正しい順序で状態遷移: queued → running → failed
    manager.updateAgentState(agent.agentId, { status: "running" });
    manager.updateAgentState(agent.agentId, { status: "failed" });

    const result = handleReportResult(manager, {
      agentId: agent.agentId,
      status: "failure",
      summary: "コンパイルエラー",
      response: "TypeScript のコンパイルで型エラーが発生。src/index.ts の戻り値の型が不一致。",
      errorMessage: "型エラーが発生しました",
    });

    expect(result).not.toHaveProperty("isError");
    const data = JSON.parse(result.content[0].text);
    expect(data.registered).toBe(true);
  });
});
