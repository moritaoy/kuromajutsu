import { describe, it, expect } from "vitest";
import {
  buildResumePrompt,
  buildWorkspaceInjectionBlock,
  type ResumePromptInput,
} from "../../src/workspace/orchestrator-prompt.js";
import type { MagenticLedger, Workspace } from "../../src/types/index.js";
import { makeAuthPlan } from "./fixtures.js";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const plan = makeAuthPlan();
  return {
    id: "ws-1739487600-ab12",
    instruction: "既存 API に JWT 認証を追加してください",
    workspacePath: "/tmp/project",
    status: "running",
    revisions: [plan],
    approvedRevision: 1,
    groupId: "grp-1739487600-b4e1",
    gateResults: [],
    humanReviews: [],
    gateChanges: [],
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:10:00.000Z",
    ...overrides,
  };
}

describe("buildWorkspaceInjectionBlock", () => {
  const plan = makeAuthPlan();
  const text = buildWorkspaceInjectionBlock({ workspace: makeWorkspace(), plan });

  it("「この計画を正とする」と、フェーズ順・ゲート・DoD を守る旨を含む", () => {
    expect(text).toContain("この計画を正とする");
    expect(text).toContain("フェーズ");
    expect(text).toContain("DoD");
  });

  it("既存プロンプトと同じ「---【...】---」ブロックの文体", () => {
    expect(text).toMatch(/^---\n【[^】]+】/);
    const blocks = text.match(/^【[^】]+】$/gm) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  it("deferred フェーズは開始直前に手順を決めて update_ledger で追加し、ゲートの前に完了させる", () => {
    expect(text).toContain("deferred");
    expect(text).toContain("開始直前");
    expect(text).toContain(`update_ledger(type: "task", phases, scheduledSteps)`);
    expect(text).toMatch(/ゲートを実行する前/);
  });

  it("サブ Agent の起動時に run_agents の各 agent へ担当手順の stepId を必ず付ける旨を含む", () => {
    expect(text).toContain("`run_agents` の各 agent に担当する手順の `stepId` を **必ず** 付ける");
    expect(text).toContain("1 Agent 1 手順");
    expect(text).toContain("`stepId` はその手順の作業を担当する Agent にだけ付ける");
    expect(text).toContain("原因の切り分けやレビューは、対応する手順（triage 手順・ゲート）の stepId を付け、別の手順の stepId を使い回さない");
    expect(text).toContain("手順の状態をダッシュボードに反映する");
  });

  it("手順の status はサーバーが同期する（失敗は変えない）。scheduledSteps は応答の stepStatuses を使い completed を戻さない", () => {
    expect(text).toContain("サブ Agent の起動（`in_progress`）と成功報告（`completed`）で同期する。失敗は変えない");
    expect(text).toContain("`update_ledger` の応答の `stepStatuses` にある最新の status を使い、`completed` を戻さない");
  });

  it("遅延計画・修正フェーズでは、手順を台帳に追加してから run_agents を呼ぶ（台帳に無い stepId は同期されない）", () => {
    const matches = text.match(/台帳に追加してから\*\*? `run_agents` を呼ぶ（台帳に無い stepId は同期されない）/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("ゲートの実行手順（command / agent-review / human）", () => {
    expect(text).toContain("run_gate_check(groupId, gateId)");
    expect(text).toContain("report_gate_result(groupId, gateId, checkIndex, passed, note)");
    expect(text).toContain(`request_human_review(groupId, gateId, reviewDocPath: "agent:<text-writer の agentId>")`);
    expect(text).toContain(`report_result(status: "success", summary: "人間レビュー待ちで一時停止")`);
    expect(text).toContain("text-writer");
  });

  it("不合格時の原則と retryLimitExceeded の扱い", () => {
    expect(text).toContain("自分で調査・修正しない");
    expect(text).toContain("原因の切り分け");
    expect(text).toContain("retryLimitExceeded: true");
    expect(text).toContain(`report_result(status: "success", summary: "差し戻し上限超過で一時停止")`);
  });

  it("Task Ledger は登録済みで、type: task で登録し直さず、手順を変えないなら scheduledSteps を省略する・言い換えない", () => {
    expect(text).toContain("登録済み");
    expect(text).toContain("実行の開始直後（最初の反復）は");
    expect(text).toContain(`\`update_ledger(type: "task")\` で登録し直さず`);
    expect(text).toContain(`最初の呼び出しは \`type: "progress"\``);
    expect(text).toContain("`scheduledSteps` を省略する");
    expect(text).toContain("言い換えない");
    // 再開時・手順の追加では従来どおり type: task を使う
    expect(text).toContain("再開時や手順の追加（直前計画・修正フェーズ）では、従来どおり");
  });

  it("ゲートの変更ルール", () => {
    expect(text).toContain("irregular: true");
    expect(text).toContain("reason");
    expect(text).toMatch(/最終ゲートの削除/);
    expect(text).toMatch(/人間レビューの省略/);
  });

  it("ゲートの status を自分で completed にしない", () => {
    expect(text).toMatch(/status.*completed.*しない/s);
    expect(text).toContain("GATE_PROTECTED");
  });

  it("ReviewDoc の型定義と標準の節 7 つ（id と順序）、text-writer への依頼ひな形", () => {
    expect(text).toContain("interface ReviewDoc");
    expect(text).toContain("interface ReviewSection");
    const ids = ["conclusion", "alternatives", "structure", "spec", "changed-files", "precheck", "decisions"];
    let last = -1;
    for (const id of ids) {
      const i = text.indexOf(`\`${id}\``, text.indexOf("標準の節"));
      expect(i, id).toBeGreaterThan(last);
      last = i;
    }
    expect(text).toContain("previousFeedback");
    expect(text).toContain("依頼文のひな形");
  });

  it("図は kind: \"mermaid\" の節にする指示（コードブロック不可）を ReviewDoc の説明と依頼ひな形の両方に含む", () => {
    const rule = "図（構成図・フロー図）は markdown のコードブロックではなく";
    expect(text).toContain(rule);
    expect(text).toContain("図にならずコードとして表示される");
    // 依頼ひな形（``` で囲まれた部分）の中にも入っている
    const tmpl = text.slice(text.indexOf("依頼文のひな形"));
    expect(tmpl).toContain('kind: "mermaid"');
    expect(tmpl).toContain("コードブロック");
  });

  it("最終 report_result の response の見出し", () => {
    expect(text).toContain("## 何が実装されたか");
    expect(text).toContain("## 試し方");
    expect(text).toContain("## 確認しておくと良いこと");
  });

  it("既存の Orchestrator の原則を維持する旨", () => {
    expect(text).toContain("scope");
    expect(text).toContain("constraints");
    expect(text).toContain("maxIterations");
  });

  it("計画の全文: フェーズ・手順・ゲート", () => {
    for (const p of plan.phases) {
      expect(text).toContain(p.id);
      expect(text).toContain(p.name);
      expect(text).toContain(p.goal);
    }
    expect(text).toContain("設計の分割を見て手順を決める"); // phase.notes
    for (const s of plan.steps) {
      expect(text).toContain(s.id);
    }
    expect(text).toContain("research");
    expect(text).toContain("impl-test");
    expect(text).toContain("s1 の作業");
    expect(text).toContain("s1 が完了している"); // doneCriteria
    expect(text).toContain("tests/unit/**"); // scope
    expect(text).toContain("dependsOn: s1");
    expect(text).toContain("npm run build");
    expect(text).toContain("npm test && npx tsc --noEmit");
    expect(text).toContain("agent-review");
    expect(text).toContain("human");
    expect(text).toContain("方針に合意できる");
    expect(text).toContain("maxRetries");
  });

  it("deferred フェーズと final フェーズが分かる", () => {
    expect(text).toMatch(/P2[^\n]*deferred/);
    expect(text).toMatch(/PF[^\n]*final/);
  });

  it("Workspace の指示・作業ディレクトリ・spec を含む", () => {
    expect(text).toContain("ws-1739487600-ab12");
    expect(text).toContain("/tmp/project");
    expect(text).toContain("認証機能（JWT）の追加");
    expect(text).toContain("npm test が成功する");
    expect(text).toContain("HS256 署名");
  });

  it("groupId は Workspace の親グループの ID であり、子グループの ID ではない", () => {
    expect(text).toContain("Workspace の親（Magentic）グループの ID");
    expect(text).toContain("子グループの ID ではない");
    expect(text).toContain("grp-1739487600-b4e1");
  });

  it("gateStatus が pending のときは pendingChecks の agent-review を続けて実行する", () => {
    expect(text).toContain("`pending`");
    expect(text).toContain("pendingChecks");
  });

  it("修正フェーズの作り方を update_ledger の形で具体的に示す", () => {
    expect(text).toContain("parentPhaseId");
    expect(text).toContain("fix: { failedGateId");
    expect(text).toContain("causePhaseId");
    expect(text).toContain("triageStepId");
    expect(text).toContain('planning: "fixed"');
    expect(text).toContain("triage-<ゲート ID>-1");
    expect(text).toContain("出口ゲートを必ず置く");
    expect(text).toContain("元の（不合格になった）ゲートと同じ");
    expect(text).toContain('{ text: "...", method: "human" }');
    expect(text).toMatch(/title.*scope.*無い.*description/s);
    expect(text).toContain("fix.failedGateId");
  });

  it("gateCommandNote があれば command の実行手順に含める", () => {
    const withNote = buildWorkspaceInjectionBlock({
      workspace: makeWorkspace(),
      plan,
      gateCommandNote: "git push は禁止されています（NOTE-XYZ）",
    });
    expect(withNote).toContain("NOTE-XYZ");
    expect(text).not.toContain("NOTE-XYZ");
  });
});

describe("buildResumePrompt", () => {
  const plan = makeAuthPlan();

  const ledger: MagenticLedger = {
    groupId: "grp-1739487600-b4e1",
    taskLedger: {
      facts: { given: ["GIVEN-FACT"], toInvestigate: [], toDerive: [], assumptions: [] },
      plan: ["PLAN-LINE-1"],
      phases: plan.phases,
      scheduledSteps: [
        { stepId: "s1", role: "research", description: "調査", status: "completed", phaseId: "P1", kind: "work" },
        { stepId: "s2", role: "design", description: "設計", status: "completed", dependsOn: ["s1"], phaseId: "P1", kind: "work" },
        { stepId: "gate-P1", role: "code-review", description: "ゲート", status: "in_progress", phaseId: "P1", kind: "gate" },
      ],
      updatedAt: "2026-10-29T00:05:00.000Z",
    },
    progressLedger: {
      isRequestSatisfied: { reason: "未完", answer: false },
      isInLoop: { reason: "no", answer: false },
      isProgressBeingMade: { reason: "進んでいる", answer: true },
      nextAction: { reason: "r", answer: "NEXT-ACTION-2" },
      instruction: { reason: "r", answer: "INSTRUCTION-2" },
      iteration: 2,
      updatedAt: "2026-10-29T00:06:00.000Z",
    },
    progressHistory: [
      {
        isRequestSatisfied: { reason: "未完", answer: false },
        isInLoop: { reason: "no", answer: false },
        isProgressBeingMade: { reason: "p", answer: true },
        nextAction: { reason: "r", answer: "NEXT-ACTION-1" },
        instruction: { reason: "r", answer: "INSTRUCTION-1" },
        iteration: 1,
        updatedAt: "2026-10-29T00:01:00.000Z",
      },
    ],
  };

  const workspace = makeWorkspace({
    gateResults: [
      {
        gateId: "gate-P1",
        phaseId: "P1",
        status: "auto_passed",
        attempts: [
          {
            attempt: 1,
            checks: [{ checkIndex: 0, method: "agent-review", passed: true, note: "REVIEW-NOTE-OK", at: "2026-10-29T00:04:00.000Z" }],
          },
        ],
        retryInstructions: [
          { text: "OLD-INSTRUCTION", at: "2026-10-29T00:02:00.000Z" },
          { text: "LATEST-INSTRUCTION-FROM-STATE", at: "2026-10-29T00:03:00.000Z" },
        ],
      },
    ],
    humanReviews: [
      {
        gateId: "gate-P1",
        version: 1,
        status: "changes_requested",
        docFile: "reviews/gate-P1-v1.html",
        comments: [
          { sectionId: "alternatives", text: "案 B の不採用理由が弱い" },
          { text: "全体にもう少し短く" },
        ],
        requestedAt: "2026-10-29T00:07:00.000Z",
        resolvedAt: "2026-10-29T00:08:00.000Z",
      },
    ],
    gateChanges: [
      {
        id: "gc-1",
        gateId: "gate-P2",
        before: plan.steps.find((s) => s.id === "gate-P2")!,
        after: null,
        reason: "IRREGULAR-REASON",
        at: "2026-10-29T00:09:00.000Z",
      },
    ],
  });

  const agentSummaries: ResumePromptInput["agentSummaries"] = [
    { agentId: "research-1-aaaa", role: "research", summary: "SUMMARY-RESEARCH", editedFiles: ["a.ts"], createdFiles: ["b.ts"] },
    { agentId: "design-1-bbbb", role: "design", summary: "SUMMARY-DESIGN", editedFiles: [], createdFiles: ["docs/design.md"] },
  ];

  const base = { workspace, plan, ledger, agentSummaries };

  it("共通: run_agents の各 agent に担当手順の stepId を必ず付ける注意を含む", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-P1" } });
    expect(text).toContain("`run_agents` の各 agent に担当する手順の `stepId` を **必ず** 付ける");
    expect(text).toContain("手順の状態をダッシュボードに反映する");
    expect(text).toContain("`stepId` はその手順の作業を担当する Agent にだけ付ける");
    expect(text).toContain("`update_ledger` の応答の `stepStatuses` にある最新の status を使い、`completed` を戻さない");
  });

  it("共通: 完了したサブ Agent の担当手順（stepId）を「担当手順: <stepId>」で出す（無ければ出さない）", () => {
    const text = buildResumePrompt({
      ...base,
      agentSummaries: [
        { ...agentSummaries[0], stepId: "s1-STEP" },
        { ...agentSummaries[1] },
      ],
      reason: { kind: "approved", gateId: "gate-P1" },
    });
    expect(text).toContain("担当手順: s1-STEP");
    expect(text.match(/担当手順:/g)).toHaveLength(1);
  });

  it("共通: Workspace・Task Ledger・Progress Ledger・ゲート結果・レビュー・イレギュラー・Agent 要約を含む", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-P1" } });
    // Workspace
    expect(text).toContain("既存 API に JWT 認証を追加してください");
    expect(text).toContain("/tmp/project");
    expect(text).toContain("npm test が成功する");
    expect(text).toContain("TDD");
    // Task Ledger
    expect(text).toContain("GIVEN-FACT");
    expect(text).toContain("PLAN-LINE-1");
    expect(text).toContain('"stepId": "s1"');
    expect(text).toContain('"status": "completed"');
    expect(text).toContain('"status": "in_progress"');
    expect(text).toContain('"id": "P2"');
    // Progress Ledger
    expect(text).toContain("NEXT-ACTION-1");
    expect(text).toContain("INSTRUCTION-2");
    expect(text).toContain("isProgressBeingMade");
    // ゲート結果
    expect(text).toContain("REVIEW-NOTE-OK");
    expect(text).toContain('"attempt": 1');
    // レビュー
    expect(text).toContain("案 B の不採用理由が弱い");
    expect(text).toContain("alternatives");
    // イレギュラー
    expect(text).toContain("IRREGULAR-REASON");
    expect(text).toContain("gc-1");
    // Agent 要約
    expect(text).toContain("research-1-aaaa");
    expect(text).toContain("SUMMARY-RESEARCH");
    expect(text).toContain("a.ts");
    expect(text).toContain("docs/design.md");
  });

  it("JSON は JSON.stringify(x, null, 2) で貼る", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-P1" } });
    expect(text).toContain(JSON.stringify(ledger.taskLedger!.scheduledSteps, null, 2));
    expect(text).toContain(JSON.stringify(workspace.gateResults, null, 2));
    expect(text).toContain(JSON.stringify(workspace.humanReviews, null, 2));
  });

  it("承認: 対象ゲートは合格済み。次のフェーズへ進む（deferred は直前計画から）", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-P1" } });
    expect(text).toContain("承認");
    expect(text).toContain("gate-P1");
    expect(text).toMatch(/合格済み/);
    expect(text).toContain("P2");
    expect(text).toContain("deferred");
    expect(text).toContain("直前計画");
    expect(text).not.toContain("レビュー指摘の反映");
  });

  it("承認: 最終ゲートなら完了の報告へ", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-final" } });
    expect(text).toContain("最終ゲート");
    expect(text).toContain("report_result");
    expect(text).toContain("## 何が実装されたか");
  });

  describe("実行時の計画（Task Ledger）から引く", () => {
    const fixPhases = [
      ...plan.phases,
      {
        id: "FX1",
        name: "P1 の修正",
        goal: "直す",
        planning: "fixed" as const,
        notes: [],
        parentPhaseId: "P2",
        fix: { failedGateId: "gate-P2", causePhaseId: "P1", triageStepId: "triage-gate-P2-1" },
      },
    ];
    const fixLedger: MagenticLedger = {
      ...ledger,
      taskLedger: {
        ...ledger.taskLedger!,
        phases: fixPhases,
        scheduledSteps: [
          ...ledger.taskLedger!.scheduledSteps!,
          { stepId: "gate-P2", role: "code-review", description: "P2 ゲート", status: "failed" as never, phaseId: "P2", kind: "gate" as const },
          { stepId: "gate-FX1", role: "code-review", description: "FX1 ゲート", status: "in_progress", phaseId: "FX1", kind: "gate" },
        ],
      },
    };

    it("修正フェーズの出口ゲートの承認: 元の不合格ゲートを同じ条件で再チェックする", () => {
      const text = buildResumePrompt({ ...base, ledger: fixLedger, reason: { kind: "approved", gateId: "gate-FX1" } });
      const next = text.slice(text.indexOf("【次にやること】"));
      expect(next).toContain("修正フェーズ FX1");
      expect(next).toContain("元の不合格ゲート gate-P2");
      expect(next).toContain("同じ条件で再チェック");
      expect(next).toContain("フェーズ P2");
      expect(next).not.toContain("次のフェーズ P3");
    });

    it("計画（plan）に無い手順・フェーズでもゲートを引ける", () => {
      expect(plan.steps.some((s) => s.id === "gate-FX1")).toBe(false);
      const text = buildResumePrompt({ ...base, ledger: fixLedger, reason: { kind: "approved", gateId: "gate-FX1" } });
      expect(text).toContain("gate-FX1");
    });

    it("次のフェーズは実行時の phases の並びで決める（入れ子の修正フェーズは飛ばす）", () => {
      const phases = [plan.phases[0], { id: "PX", name: "追加されたフェーズ", goal: "g", planning: "deferred" as const, notes: [] }, ...plan.phases.slice(1)];
      const l: MagenticLedger = { ...ledger, taskLedger: { ...ledger.taskLedger!, phases } };
      const text = buildResumePrompt({ ...base, ledger: l, reason: { kind: "approved", gateId: "gate-P1" } });
      const next = text.slice(text.indexOf("【次にやること】"));
      expect(next).toContain("次のフェーズ PX「追加されたフェーズ」");
      expect(next).toContain("deferred");
    });

    it("修正フェーズを飛ばして次のフェーズへ進む", () => {
      const phases = [plan.phases[0], plan.phases[1], fixPhases[fixPhases.length - 1], ...plan.phases.slice(2)];
      const l: MagenticLedger = { ...fixLedger, taskLedger: { ...fixLedger.taskLedger!, phases } };
      const text = buildResumePrompt({ ...base, ledger: l, reason: { kind: "approved", gateId: "gate-P1" } });
      expect(text.slice(text.indexOf("【次にやること】"))).toContain("次のフェーズ P2");
    });

    it("差し戻しのフェーズ名も実行時の phases から引く", () => {
      const text = buildResumePrompt({
        ...base,
        ledger: fixLedger,
        reason: { kind: "changes_requested", gateId: "gate-FX1", comments: [{ text: "x" }] },
      });
      expect(text).toContain("FX1「P1 の修正」");
    });
  });

  it("差し戻し: コメント（節 ID 付き）と「レビュー指摘の反映」手順・次の版の作成", () => {
    const text = buildResumePrompt({
      ...base,
      reason: {
        kind: "changes_requested",
        gateId: "gate-P1",
        comments: [
          { sectionId: "alternatives", text: "案 B の不採用理由が弱い" },
          { text: "全体にもう少し短く" },
        ],
      },
    });
    expect(text).toContain("差し戻し");
    expect(text).toContain("[alternatives] 案 B の不採用理由が弱い");
    expect(text).toContain("[全体] 全体にもう少し短く");
    expect(text).toContain("レビュー指摘の反映");
    expect(text).toContain("update_ledger");
    expect(text).toContain("自動チェック");
    expect(text).toContain("previousFeedback");
    expect(text).toContain("version: 2");
    expect(text).toContain("request_human_review");
    expect(text).toContain("人間レビュー待ちで一時停止");
    expect(text).toMatch(/maxRetries に数えない/);
  });

  it("差し戻し: 次の版は既存の最大版 + 1", () => {
    const ws = makeWorkspace({
      humanReviews: [
        { gateId: "gate-P1", version: 1, status: "changes_requested", docFile: "reviews/gate-P1-v1.html", comments: [{ text: "x" }], requestedAt: "t", resolvedAt: "t" },
        { gateId: "gate-P1", version: 2, status: "changes_requested", docFile: "reviews/gate-P1-v2.html", comments: [{ text: "y" }], requestedAt: "t", resolvedAt: "t" },
      ],
    });
    const text = buildResumePrompt({
      ...base,
      workspace: ws,
      reason: { kind: "changes_requested", gateId: "gate-P1", comments: [{ text: "y" }] },
    });
    expect(text).toContain("version: 3");
  });

  it("再試行: 人の指示と原因の切り分けからやり直す", () => {
    const text = buildResumePrompt({
      ...base,
      reason: { kind: "retry", gateId: "gate-P2", instruction: "テストの失敗は env 設定が原因のはず。まず確認して" },
    });
    expect(text).toContain("再試行");
    expect(text).toContain("gate-P2");
    expect(text).toContain("テストの失敗は env 設定が原因のはず。まず確認して");
    expect(text).toContain("原因の切り分け");
    expect(text).toMatch(/失敗回数は 0/);
  });

  it("再試行: instruction が無ければ retryInstructions の最新を使う", () => {
    const ws = makeWorkspace({
      gateResults: [
        {
          gateId: "gate-P2",
          phaseId: "P2",
          status: "failed",
          attempts: [],
          retryInstructions: [
            { text: "OLD-INSTRUCTION", at: "2026-10-29T00:02:00.000Z" },
            { text: "LATEST-INSTRUCTION-FROM-STATE", at: "2026-10-29T00:03:00.000Z" },
          ],
        },
      ],
    });
    const text = buildResumePrompt({ ...base, workspace: ws, reason: { kind: "retry", gateId: "gate-P2" } });
    expect(text).toContain("LATEST-INSTRUCTION-FROM-STATE");
    expect(text).not.toMatch(/人からの指示[^]*OLD-INSTRUCTION[^]*次にやること/);
  });

  it("異常終了からの再開: 見出し・異常終了の理由・人の指示・続きから再開する指示", () => {
    const text = buildResumePrompt({
      ...base,
      reason: { kind: "recover", failure: "FAILURE-REASON ネットワーク切断", instruction: "テストから先にやり直して" },
    });
    expect(text).toContain("Orchestrator の異常終了からの再開");
    expect(text).toContain("FAILURE-REASON ネットワーク切断");
    expect(text).toContain("人の指示: テストから先にやり直して");
    expect(text).toMatch(/人からの指示[^]*テストから先にやり直して[^]*次にやること/);
    // 停止済みのサブ Agent・部分的な成果・完了していない最初の手順から続ける・自分では作業しない・ゲートの再チェック
    expect(text).toContain("停止済み");
    expect(text).toContain("部分的");
    expect(text).toContain("完了していない最初の手順");
    expect(text).toContain("自分では作業しない");
    expect(text).toContain("サーバーの記録を正");
    // gateId の無い kind でも壊れない（undefined が文面に出ない）
    expect(text).not.toContain("undefined");
  });

  it("異常終了からの再開: 指示が無ければ「人の指示」の行は出さない", () => {
    const text = buildResumePrompt({
      ...base,
      reason: { kind: "recover", failure: "boom" },
    });
    expect(text).not.toContain("人の指示:");
    expect(text).toMatch(/人からの指示[^]*なし/);
  });

  describe("異常終了からの再開（ゲートの状態別・停止したサブ Agent・未対応の再開理由）", () => {
    const attempt = (n: number, passed: boolean, closed = true) => ({
      attempt: n,
      checks: [{ checkIndex: 0, method: "command" as const, passed, at: "2026-10-29T00:04:00.000Z" }],
      ...(closed ? { closedAt: "2026-10-29T00:04:00.000Z" } : {}),
    });
    const gateResult = (
      gateId: string,
      status: "pending" | "failed" | "auto_passed" | "waiting_human" | "passed",
      attempts: ReturnType<typeof attempt>[] = [],
      retryInstructions: { text: string; at: string; afterAttempt?: number }[] = [],
    ) => ({ gateId, phaseId: gateId.replace("gate-", ""), status, attempts, retryInstructions });
    const recover = (ws: Workspace, extra: Partial<ResumePromptInput> = {}) =>
      buildResumePrompt({
        ...base,
        workspace: ws,
        reason: { kind: "recover", failure: "boom" },
        ...extra,
      });

    it("ゲートを状態別に列挙する（failed は修正を続けてから再チェック / auto_passed は自動チェックをやり直さない / 途中の attempt は再チェック）", () => {
      const ws = makeWorkspace({
        gateResults: [
          gateResult("gate-P1", "auto_passed", [attempt(1, true)]),
          gateResult("gate-P2", "failed", [attempt(1, false)]),
          gateResult("gate-P3", "pending", [attempt(1, true, false)]),
          gateResult("gate-final", "pending"),
        ],
      });
      const text = recover(ws);
      expect(text).toContain("不合格（failed）: gate-P2");
      expect(text).toContain("自動チェック合格・人間レビュー前（auto_passed）: gate-P1");
      expect(text).toContain("途中の attempt（pending）: gate-P3");
      // まだ着手していないゲートは列挙しない
      expect(text).not.toMatch(/（(failed|auto_passed|pending)）: [^\n]*gate-final/);
      // 状態別の指示
      expect(text).toMatch(/failed[^]*修正の手順[^]*終わってから[^]*再チェック/);
      expect(text).toMatch(/auto_passed[^]*自動チェックはやり直さない[^]*request_human_review/);
      expect(text).toMatch(/pending[^]*同じ条件で再チェック/);
    });

    it("該当するゲートが無ければ、その状態の行は出さない", () => {
      const text = recover(makeWorkspace({ gateResults: [gateResult("gate-P1", "passed", [attempt(1, true)])] }));
      expect(text).not.toContain("不合格（failed）:");
      expect(text).not.toContain("（auto_passed）:");
      expect(text).not.toContain("途中の attempt（pending）:");
    });

    it("手順の追加は update_ledger(type: task) で行い、ゲートは変えない", () => {
      const text = recover(makeWorkspace());
      expect(text).toContain('update_ledger(type: "task", phases, scheduledSteps)');
      expect(text).toContain("ゲートは変えない");
    });

    it("途中で停止したサブ Agent（agentId・role・途中までのファイル）を別ブロックで渡す", () => {
      const text = recover(makeWorkspace(), {
        stoppedAgents: [
          { agentId: "impl-code-9-zzzz", role: "impl-code", status: "failed", editedFiles: ["src/partial.ts"], createdFiles: ["src/new-one.ts"] },
        ],
      });
      expect(text).toContain("途中で停止したサブ Agent");
      expect(text).toContain("impl-code-9-zzzz");
      expect(text).toContain("impl-code");
      expect(text).toContain("src/partial.ts");
      expect(text).toContain("src/new-one.ts");
    });

    it("途中で停止したサブ Agent の担当手順（stepId）を「担当手順」として出す", () => {
      const text = recover(makeWorkspace(), {
        stoppedAgents: [
          { agentId: "impl-code-9-zzzz", role: "impl-code", stepId: "STOPPED-STEP", status: "failed", editedFiles: [], createdFiles: [] },
        ],
      });
      expect(text).toContain("担当手順: STOPPED-STEP");
    });

    it("停止したサブ Agent が無ければ「なし」。他の理由の再開ではこのブロックを出さない", () => {
      expect(recover(makeWorkspace())).toMatch(/途中で停止したサブ Agent[^]*（なし）/);
      const text = buildResumePrompt({
        ...base,
        reason: { kind: "approved", gateId: "gate-P1" },
        stoppedAgents: [{ agentId: "x-1", role: "x", status: "failed", editedFiles: [], createdFiles: [] }],
      });
      expect(text).not.toContain("途中で停止したサブ Agent");
    });

    const changesRequested = (version: number, status: "changes_requested" | "pending" | "approved") => ({
      gateId: "gate-P1",
      version,
      status,
      docFile: `reviews/gate-P1-v${version}.html`,
      comments: status === "changes_requested" ? [{ sectionId: "alt", text: `COMMENT-V${version}` }] : [],
      requestedAt: "2026-10-29T00:07:00.000Z",
    });

    it("未対応の人間レビューの差し戻し（それより新しい版が無い）は、コメントと次の版・previousFeedback を明示する", () => {
      const ws = makeWorkspace({
        gateResults: [gateResult("gate-P1", "pending", [attempt(1, true)])],
        humanReviews: [changesRequested(1, "changes_requested"), changesRequested(2, "changes_requested")],
      });
      const text = recover(ws);
      expect(text).toContain("未対応の人間レビューの差し戻し");
      // （状態のスナップショットの JSON には両方の版が入るため、「次にやること」の側だけを見る）
      expect(text).toMatch(/未対応の人間レビューの差し戻し[^]*COMMENT-V2/);
      expect(text).not.toMatch(/未対応の人間レビューの差し戻し[^]*COMMENT-V1/);
      expect(text).toContain("version: 3");
      expect(text).toContain("previousFeedback");
      expect(text).toContain("レビュー指摘の反映");
      // 同じゲートを「途中の attempt」としても列挙しない
      expect(text).not.toContain("途中の attempt（pending）: gate-P1");
    });

    it("差し戻しより新しい版（保留中・承認済み）があれば、未対応としない", () => {
      for (const next of ["pending", "approved"] as const) {
        const ws = makeWorkspace({
          humanReviews: [changesRequested(1, "changes_requested"), changesRequested(2, next)],
        });
        expect(recover(ws)).not.toContain("未対応の人間レビューの差し戻し");
      }
    });

    it("最新の retryInstructions の後に attempt が無ければ、その指示を明示する", () => {
      const ws = makeWorkspace({
        gateResults: [
          gateResult("gate-P2", "pending", [attempt(1, false), attempt(2, false), attempt(3, false)], [
            { text: "OLD-RETRY", at: "2026-10-29T00:02:00.000Z", afterAttempt: 1 },
            { text: "LATEST-RETRY-TEXT", at: "2026-10-29T00:05:00.000Z", afterAttempt: 3 },
          ]),
        ],
      });
      const text = recover(ws);
      expect(text).toContain("未対応の再試行の指示");
      expect(text).toMatch(/未対応の再試行の指示[^]*LATEST-RETRY-TEXT/);
      expect(text).not.toMatch(/未対応の再試行の指示[^]*OLD-RETRY/);
      expect(text).toContain("原因の切り分け");
    });

    it("再試行の指示より後に attempt があれば、未対応としない", () => {
      const ws = makeWorkspace({
        gateResults: [
          gateResult("gate-P2", "failed", [attempt(1, false), attempt(2, false)], [
            { text: "RETRY-DONE", at: "2026-10-29T00:02:00.000Z", afterAttempt: 1 },
          ]),
        ],
      });
      const text = recover(ws);
      expect(text).not.toContain("未対応の再試行の指示");
    });
  });

  it("承認 / 差し戻しでは人からの指示は「なし」", () => {
    const text = buildResumePrompt({ ...base, reason: { kind: "approved", gateId: "gate-P1" } });
    expect(text).toMatch(/人からの指示[^]*なし/);
  });

  it("Task Ledger があるときは「登録済み。再登録しない。手順を変えないなら scheduledSteps を省略」を添える", () => {
    const text = buildResumePrompt({
      ...base,
      ledger: {
        groupId: "grp-1739487600-b4e1",
        taskLedger: {
          facts: { given: [], toInvestigate: [], toDerive: [], assumptions: [] },
          plan: [],
          scheduledSteps: [],
          createdAt: "2026-10-29T00:00:00.000Z",
          updatedAt: "2026-10-29T00:00:00.000Z",
        },
        progressHistory: [],
      } as unknown as MagenticLedger,
      reason: { kind: "approved", gateId: "gate-P1" },
    });
    expect(text).toContain("Task Ledger は登録済み");
    expect(text).toContain("登録し直さない");
    expect(text).toContain("`scheduledSteps` を省略する");
  });

  it("ledger が無くても組み立てられる", () => {
    const text = buildResumePrompt({
      workspace: makeWorkspace(),
      plan,
      agentSummaries: [],
      reason: { kind: "approved", gateId: "gate-P1" },
    });
    expect(text).toContain("Task Ledger");
    expect(text).toMatch(/未登録|なし/);
  });
});
