import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceReport } from "../../src/workspace/report.js";
import type { AgentState, MagenticLedger, Workspace } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

const plan = makeAuthPlan();

function agent(
  agentId: string,
  role: string,
  o: {
    startedAt: string;
    finishedAt?: string;
    edited?: string[];
    created?: string[];
    summary?: string;
    resultEdited?: string[];
    resultCreated?: string[];
  },
): AgentState {
  return {
    agentId,
    groupId: "grp-1",
    role,
    model: "m",
    provider: "claude",
    status: o.finishedAt ? "resultReported" : "running",
    startedAt: o.startedAt,
    elapsed_ms: 1000,
    toolCallCount: 0,
    recentToolCalls: [],
    result: o.finishedAt
      ? {
          agentId,
          groupId: "grp-1",
          status: "success",
          summary: o.summary ?? `${role} 完了`,
          response: "",
          editedFiles: o.resultEdited ?? [],
          createdFiles: o.resultCreated ?? [],
          duration_ms: 1000,
          model: "m",
          role,
          toolCallCount: 0,
          timestamp: o.finishedAt,
        }
      : null,
    editedFiles: o.edited ?? [],
    createdFiles: o.created ?? [],
    maxIterations: 1,
    currentIteration: 0,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1739487600-ab12",
    instruction: "JWT 認証を追加",
    workspacePath: "/tmp/project",
    status: "done",
    revisions: [plan],
    approvedRevision: 1,
    groupId: "grp-1",
    gateResults: [
      {
        gateId: "gate-final",
        phaseId: "PF",
        status: "passed",
        attempts: [
          {
            attempt: 1,
            checks: [
              { checkIndex: 0, method: "agent-review", passed: true, note: "全テスト成功を確認", at: "2026-10-29T00:30:00.000Z" },
            ],
            closedAt: "2026-10-29T00:30:00.000Z",
          },
        ],
        retryInstructions: [],
      },
    ],
    humanReviews: [
      {
        gateId: "gate-P1",
        version: 1,
        status: "changes_requested",
        docFile: "reviews/gate-P1-v1.html",
        comments: [{ sectionId: "alternatives", text: "案 B の理由が弱い" }, { text: "短く" }],
        requestedAt: "2026-10-29T00:10:00.000Z",
        resolvedAt: "2026-10-29T00:12:00.000Z",
      },
      {
        gateId: "gate-P1",
        version: 2,
        status: "approved",
        docFile: "reviews/gate-P1-v2.html",
        comments: [],
        requestedAt: "2026-10-29T00:15:00.000Z",
        resolvedAt: "2026-10-29T00:16:00.000Z",
      },
    ],
    gateChanges: [
      {
        id: "gc-1",
        gateId: "gate-P2",
        before: plan.steps.find((s) => s.id === "gate-P2")!,
        after: null,
        reason: "CI が無いためコマンドを変更",
        at: "2026-10-29T00:20:00.000Z",
      },
      {
        id: "gc-2",
        gateId: "gate-P3",
        before: plan.steps.find((s) => s.id === "gate-P3")!,
        after: plan.steps.find((s) => s.id === "gate-P3")!,
        reason: "確認済みの変更",
        at: "2026-10-29T00:21:00.000Z",
        acknowledgedAt: "2026-10-29T00:25:00.000Z",
      },
    ],
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:30:00.000Z",
    ...overrides,
  };
}

const ledger: MagenticLedger = {
  groupId: "grp-1",
  taskLedger: {
    facts: { given: [], toInvestigate: [], toDerive: [], assumptions: [] },
    plan: [],
    phases: plan.phases,
    scheduledSteps: [
      { stepId: "s1", role: "research", description: "調査", status: "completed", phaseId: "P1", kind: "work" },
      { stepId: "s2", role: "design", description: "設計", status: "completed", phaseId: "P1", kind: "work" },
      { stepId: "gate-P1", role: "code-review", description: "P1 ゲート", status: "completed", phaseId: "P1", kind: "gate" },
      { stepId: "impl-1", role: "impl-code", description: "追加された実装手順", status: "completed", phaseId: "P2", kind: "work" },
      { stepId: "gate-P2", role: "code-review", description: "P2 ゲート", status: "completed", phaseId: "P2", kind: "gate" },
      { stepId: "gate-final", role: "code-review", description: "最終", status: "completed", phaseId: "PF", kind: "gate" },
    ],
    updatedAt: "2026-10-29T00:29:00.000Z",
  },
  progressHistory: [1, 2, 3].map((i) => ({
    isRequestSatisfied: { reason: "", answer: false },
    isInLoop: { reason: "", answer: false },
    isProgressBeingMade: { reason: "", answer: true },
    nextAction: { reason: "", answer: "" },
    instruction: { reason: "", answer: "" },
    iteration: i,
    updatedAt: "2026-10-29T00:00:00.000Z",
  })),
};

const agents: AgentState[] = [
  agent("research-1", "research", {
    startedAt: "2026-10-29T00:01:00.000Z",
    finishedAt: "2026-10-29T00:05:00.000Z",
    edited: ["src/b.ts", "src/a.ts"],
    created: ["docs/new.md"],
    summary: "調査した",
  }),
  agent("impl-1", "impl-code", {
    startedAt: "2026-10-29T00:17:00.000Z",
    finishedAt: "2026-10-29T00:19:00.000Z",
    edited: ["src/a.ts"],
    created: ["src/auth/jwt.ts"],
    resultEdited: ["src/c.ts"],
    resultCreated: ["src/auth/jwt.ts"],
  }),
];

const finalResponse = [
  "全て完了しました。",
  "",
  "## 何が実装されたか",
  "",
  "JWT 認証（HS256）を追加しました。",
  "",
  "### 詳細",
  "- /login でトークンを発行",
  "",
  "## 試し方",
  "",
  "```sh",
  "# このコメントは見出しではない",
  "npm test",
  "```",
  "",
  "## 確認しておくと良いこと",
  "",
  "- 署名鍵は環境変数 JWT_SECRET から読みます",
].join("\n");

const NOW = "2026-10-29T01:00:00.000Z";
const base = { workspace: makeWorkspace(), plan, ledger, agents, finalResponse, now: NOW };

describe("buildWorkspaceReport: 文章", () => {
  const r = buildWorkspaceReport(base);

  it("summary / howToTry / notes を finalResponse の見出しから抜き出す", () => {
    expect(r.summary).toContain("JWT 認証（HS256）を追加しました。");
    expect(r.summary).toContain("/login でトークンを発行"); // 小見出し配下も含む
    expect(r.summary).not.toContain("npm test");
    expect(r.howToTry).toContain("npm test");
    expect(r.howToTry).toContain("# このコメントは見出しではない");
    expect(r.notes).toContain("JWT_SECRET");
    expect(r.summary).not.toContain("## 何が実装されたか");
  });

  it("見出しはゆるく一致する（実装内容 / 動作確認 / 注意）", () => {
    const rr = buildWorkspaceReport({
      ...base,
      finalResponse: "# 実装内容\nA\n\n# 動作確認の方法\nB\n\n# 注意点\nC\n",
    });
    expect(rr.summary).toBe("A");
    expect(rr.howToTry).toBe("B");
    expect(rr.notes).toContain("C");
  });

  it("H1 のタイトルの下の H2 も拾い、一致しなかった節は notes に回す", () => {
    const rr = buildWorkspaceReport({
      ...base,
      finalResponse: "# 完了レポート\n\nはじめに\n\n## 何が実装されたか\nA\n### 内訳\nA2\n\n## 試し方\nB\n\n## 補足資料\nD\n\n### 補足の詳細\nE\n",
    });
    expect(rr.summary).toContain("A");
    expect(rr.summary).toContain("### 内訳\nA2");
    expect(rr.summary).not.toContain("D");
    expect(rr.howToTry).toBe("B");
    expect(rr.notes).toContain("## 補足資料\nD");
    expect(rr.notes).toContain("### 補足の詳細\nE");
    expect(rr.notes).toContain("# 完了レポート");
  });

  it("見出しの前の前置きは、summary の節があれば notes に回る", () => {
    const rr = buildWorkspaceReport(base);
    expect(rr.summary).not.toContain("全て完了しました。");
    expect(rr.notes).toContain("全て完了しました。");
  });

  it("見出しが見つからなければ summary に全文、他は空", () => {
    const rr = buildWorkspaceReport({ ...base, finalResponse: "ただの文章です。" });
    expect(rr.summary).toBe("ただの文章です。");
    expect(rr.howToTry).toBe("");
    // notes は追記分のみ（finalResponse 由来は無い）
    expect(rr.notes).not.toContain("ただの文章");
  });

  it("finalResponse が無ければ文章は空", () => {
    const rr = buildWorkspaceReport({ ...base, finalResponse: undefined });
    expect(rr.summary).toBe("");
    expect(rr.howToTry).toBe("");
  });

  it("試し方だけ見つかった場合、summary はそれ以外の部分", () => {
    const rr = buildWorkspaceReport({ ...base, finalResponse: "前置き\n\n## 試し方\nnpm test\n" });
    expect(rr.summary).toBe("前置き");
    expect(rr.howToTry).toBe("npm test");
  });
});

describe("buildWorkspaceReport: 変更ファイル・人の判断・完了条件", () => {
  const r = buildWorkspaceReport(base);

  it("changedFiles は全 Agent の和集合（重複除去・ソート。自動収集 + 報告の両方）", () => {
    expect(r.changedFiles.editedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(r.changedFiles.createdFiles).toEqual(["docs/new.md", "src/auth/jwt.ts"]);
  });

  describe("changedFiles のパス正規化", () => {
    // workspacePath は /tmp/project
    const build = (a: AgentState[]) =>
      buildWorkspaceReport({ ...base, agents: a }).changedFiles;
    const t = { startedAt: "2026-10-29T00:01:00.000Z", finishedAt: "2026-10-29T00:05:00.000Z" };

    it("絶対パスと相対パスの同じファイルが 1 件になる（./ 先頭も同一視）", () => {
      const cf = build([
        agent("a", "impl-code", {
          ...t,
          edited: ["src/greet.js", "./src/util.js"],
          resultEdited: ["/tmp/project/src/greet.js", "/tmp/project/./src/util.js"],
          created: ["tests/greet.test.js"],
          resultCreated: ["/tmp/project/tests/greet.test.js"],
        }),
      ]);
      expect(cf.editedFiles).toEqual(["src/greet.js", "src/util.js"]);
      expect(cf.createdFiles).toEqual(["tests/greet.test.js"]);
    });

    it("workspacePath の外の絶対パスはそのまま残る", () => {
      const cf = build([
        agent("a", "impl-code", {
          ...t,
          edited: ["src/a.ts"],
          resultEdited: ["/other/place/x.ts", "/tmp/project/src/a.ts", "/tmp/project-2/y.ts"],
        }),
      ]);
      expect(cf.editedFiles).toEqual(["/other/place/x.ts", "/tmp/project-2/y.ts", "src/a.ts"]);
    });

    it("空文字・空白だけのパスは除外される（\".\" にならない）", () => {
      const cf = build([
        agent("a", "impl-code", {
          ...t,
          edited: ["", "  ", "src/a.ts"],
          resultEdited: [" ", "/tmp/project/src/a.ts"],
          created: [""],
          resultCreated: ["\t", "src/n.ts"],
        }),
      ]);
      expect(cf.editedFiles).toEqual(["src/a.ts"]);
      expect(cf.createdFiles).toEqual(["src/n.ts"]);
    });

    it("symlink 経由の workspacePath と、実体パスでの報告が 1 件に揃う", () => {
      const dir = mkdtempSync(join(tmpdir(), "kuromajutsu-report-"));
      try {
        const real = join(dir, "real");
        const link = join(dir, "link");
        mkdirSync(real);
        symlinkSync(real, link);
        const ws = makeWorkspace({ workspacePath: link });
        const cf = buildWorkspaceReport({
          ...base,
          workspace: ws,
          agents: [
            agent("a", "impl-code", {
              ...t,
              edited: ["src/greet.js"],
              resultEdited: [join(realpathSync(real), "src/greet.js"), join(link, "src/greet.js")],
              resultCreated: [join(realpathSync(real), "tests/greet.test.js")],
            }),
          ],
        }).changedFiles;
        expect(cf.editedFiles).toEqual(["src/greet.js"]);
        expect(cf.createdFiles).toEqual(["tests/greet.test.js"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("workspacePath が存在しない（realpath 失敗）ときは元のパスだけで比較する", () => {
      const cf = buildWorkspaceReport({
        ...base,
        workspace: makeWorkspace({ workspacePath: "/nonexistent/ws-xyz" }),
        agents: [
          agent("a", "impl-code", {
            ...t,
            edited: ["src/a.ts"],
            resultEdited: ["/nonexistent/ws-xyz/src/a.ts", "/elsewhere/b.ts"],
          }),
        ],
      }).changedFiles;
      expect(cf.editedFiles).toEqual(["/elsewhere/b.ts", "src/a.ts"]);
    });

    it("created と edited の両方にあるファイルは edited から除かれる", () => {
      const cf = build([
        agent("a", "impl-code", {
          ...t,
          edited: ["src/new.ts", "src/old.ts"],
          resultCreated: ["/tmp/project/src/new.ts"],
        }),
      ]);
      expect(cf.createdFiles).toEqual(["src/new.ts"]);
      expect(cf.editedFiles).toEqual(["src/old.ts"]);
    });
  });

  it("humanDecisions は人間レビューごと（ゲート・版・結果・コメント）", () => {
    expect(r.humanDecisions).toHaveLength(2);
    expect(r.humanDecisions[0]).toContain("gate-P1");
    expect(r.humanDecisions[0]).toContain("v1");
    expect(r.humanDecisions[0]).toContain("差し戻し");
    expect(r.humanDecisions[0]).toContain("[alternatives] 案 B の理由が弱い");
    expect(r.humanDecisions[0]).toContain("[全体] 短く");
    expect(r.humanDecisions[1]).toContain("v2");
    expect(r.humanDecisions[1]).toContain("承認");
  });

  it("最終ゲートが passed なら完了条件はすべて achieved（note にチェック結果）", () => {
    expect(r.completion.map((c) => c.criterion)).toEqual(plan.spec.completion);
    expect(r.completion.every((c) => c.achieved)).toBe(true);
    expect(r.completion[0].note).toContain("gate-final");
    expect(r.completion[0].note).toContain("全テスト成功を確認");
  });

  it("最終ゲートが passed でなければ achieved: false", () => {
    const ws = makeWorkspace({
      gateResults: [{ gateId: "gate-final", phaseId: "PF", status: "failed", attempts: [], retryInstructions: [] }],
    });
    const rr = buildWorkspaceReport({ ...base, workspace: ws });
    expect(rr.completion.every((c) => !c.achieved)).toBe(true);
    expect(rr.completion[0].note).toContain("failed");
  });

  it("最終ゲートの結果が無ければ achieved: false", () => {
    const rr = buildWorkspaceReport({ ...base, workspace: makeWorkspace({ gateResults: [] }) });
    expect(rr.completion.every((c) => !c.achieved)).toBe(true);
  });
});

describe("buildWorkspaceReport: イレギュラーと notes", () => {
  const r = buildWorkspaceReport(base);

  it("irregulars は gateChanges をそのまま（acknowledgedAt も）", () => {
    expect(r.irregulars).toHaveLength(2);
    expect(r.irregulars[0].acknowledgedAt).toBeUndefined();
    expect(r.irregulars[1].acknowledgedAt).toBe("2026-10-29T00:25:00.000Z");
  });

  it("notes に未確認のイレギュラー件数と前提を追記する", () => {
    expect(r.notes).toContain("未確認のイレギュラー: 1 件");
    expect(r.notes).toContain("gc-1");
    expect(r.notes).toContain("HS256 署名");
    expect(r.notes).toContain("JWT_SECRET");
  });

  it("イレギュラーが無ければ 0 件", () => {
    const rr = buildWorkspaceReport({ ...base, workspace: makeWorkspace({ gateChanges: [] }) });
    expect(rr.notes).toContain("未確認のイレギュラー: 0 件");
  });
});

describe("buildWorkspaceReport: 経過", () => {
  const r = buildWorkspaceReport(base);

  it("フェーズ別の手順（Task Ledger の scheduledSteps を phaseId でグループ化）", () => {
    expect(r.progress.phases.map((p) => p.phaseId)).toEqual(["P1", "P2", "P3", "PF"]);
    const p1 = r.progress.phases[0];
    expect(p1.name).toBe("アーキテクチャを決める");
    expect(p1.steps.map((s) => s.stepId)).toEqual(["s1", "s2", "gate-P1"]);
    expect(p1.steps[0]).toEqual({ stepId: "s1", title: "s1", role: "research", status: "completed" });
    const p2 = r.progress.phases[1];
    expect(p2.steps[0]).toMatchObject({ stepId: "impl-1", title: "追加された実装手順", status: "completed" });
    expect(r.progress.phases[2].steps).toEqual([]);
  });

  it("ledger が無ければ計画から（ゲートは gateResults の passed で completed）", () => {
    const rr = buildWorkspaceReport({ ...base, ledger: undefined });
    const pf = rr.progress.phases.find((p) => p.phaseId === "PF")!;
    expect(pf.steps[0]).toMatchObject({ stepId: "gate-final", status: "completed" });
    const p1 = rr.progress.phases.find((p) => p.phaseId === "P1")!;
    expect(p1.steps.find((s) => s.stepId === "s1")?.status).toBe("pending");
  });

  it("時系列は時刻順（Agent の起動・完了、ゲート結果、人間レビュー、イレギュラー）", () => {
    const times = r.progress.timeline.map((t) => t.at);
    expect([...times].sort()).toEqual(times);
    const kinds = new Set(r.progress.timeline.map((t) => t.kind));
    for (const k of [
      "agent_started",
      "agent_finished",
      "gate_check",
      "human_review_requested",
      "human_review_resolved",
      "irregular",
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
    const started = r.progress.timeline.find((t) => t.kind === "agent_started" && t.text.includes("research-1"))!;
    expect(started.at).toBe("2026-10-29T00:01:00.000Z");
    const finished = r.progress.timeline.find((t) => t.kind === "agent_finished" && t.text.includes("research-1"))!;
    expect(finished.at).toBe("2026-10-29T00:05:00.000Z");
    expect(finished.text).toContain("調査した");
    const gc = r.progress.timeline.find((t) => t.kind === "gate_check")!;
    expect(gc.text).toContain("gate-final");
    expect(gc.text).toContain("合格");
  });

  it("実行中の Agent は起動だけ載る", () => {
    const rr = buildWorkspaceReport({
      ...base,
      agents: [agent("run-1", "impl-code", { startedAt: "2026-10-29T00:50:00.000Z" })],
    });
    expect(rr.progress.timeline.filter((t) => t.kind === "agent_started")).toHaveLength(1);
    expect(rr.progress.timeline.filter((t) => t.kind === "agent_finished")).toHaveLength(0);
  });

  it("gateResults と数値", () => {
    expect(r.progress.gateResults).toEqual(base.workspace.gateResults);
    expect(r.progress.stats).toEqual({
      steps: 3, // work: s1, s2, impl-1
      gates: 3, // gate-P1, gate-P2, gate-final
      iterations: 3, // progressLedger が無いので履歴末尾の iteration
      duration_ms: 60 * 60 * 1000,
    });
  });

  it("iterations: progressLedger の iteration を優先し、履歴が空なら 0", () => {
    const withLatest: MagenticLedger = {
      ...ledger,
      progressLedger: { ...ledger.progressHistory[0], iteration: 7 },
    };
    expect(buildWorkspaceReport({ ...base, ledger: withLatest }).progress.stats.iterations).toBe(7);
    const empty: MagenticLedger = { ...ledger, progressHistory: [], progressLedger: undefined };
    expect(buildWorkspaceReport({ ...base, ledger: empty }).progress.stats.iterations).toBe(0);
    expect(buildWorkspaceReport({ ...base, ledger: undefined }).progress.stats.iterations).toBe(0);
  });

  it("generatedAt は now", () => {
    expect(r.generatedAt).toBe(NOW);
  });

  it("入力を変更しない", () => {
    const ws = makeWorkspace();
    const snapshot = JSON.stringify(ws);
    buildWorkspaceReport({ ...base, workspace: ws });
    expect(JSON.stringify(ws)).toBe(snapshot);
    const rr = buildWorkspaceReport({ ...base, workspace: ws });
    rr.irregulars[0].reason = "changed";
    expect(ws.gateChanges[0].reason).not.toBe("changed");
  });

  it("now を省略すると現在時刻", () => {
    const rr = buildWorkspaceReport({ ...base, now: undefined });
    expect(Math.abs(Date.parse(rr.generatedAt) - Date.now())).toBeLessThan(5000);
  });
});
