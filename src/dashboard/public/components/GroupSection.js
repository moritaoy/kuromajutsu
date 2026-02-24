// ============================================================
// GroupSection — グループセクション（アコーディオン）
// ============================================================

import { createElement as h, useState } from "react";
import { AgentCard } from "./AgentCard.js";

/**
 * 台帳パネル: タスク台帳・進捗台帳・履歴を表示
 */
function LedgerPanel({ ledger }) {
  const [activeTab, setActiveTab] = useState("task");

  if (!ledger) return null;
  const { taskLedger, progressLedger, progressHistory = [] } = ledger;

  const hasTask = !!taskLedger;
  const hasProgress = !!progressLedger;
  const hasHistory = progressHistory.length > 0;

  if (!hasTask && !hasProgress) return null;

  return h("div", { className: "ledger-panel" },
    h("div", { className: "ledger-tabs" },
      hasTask && h("button", {
        className: `ledger-tab ${activeTab === "task" ? "ledger-tab--active" : ""}`,
        onClick: (e) => { e.stopPropagation(); setActiveTab("task"); },
      }, "タスク台帳"),
      hasProgress && h("button", {
        className: `ledger-tab ${activeTab === "progress" ? "ledger-tab--active" : ""}`,
        onClick: (e) => { e.stopPropagation(); setActiveTab("progress"); },
      }, "進捗台帳"),
      hasHistory && h("button", {
        className: `ledger-tab ${activeTab === "history" ? "ledger-tab--active" : ""}`,
        onClick: (e) => { e.stopPropagation(); setActiveTab("history"); },
      }, `履歴 (${progressHistory.length})`),
    ),
    activeTab === "task" && hasTask && renderTaskLedger(taskLedger),
    activeTab === "progress" && hasProgress && renderProgressLedger(progressLedger),
    activeTab === "history" && hasHistory && renderProgressHistory(progressHistory),
  );
}

function renderTaskLedger(ledger) {
  const { facts, plan, updatedAt } = ledger;
  const factCategories = [
    { key: "given", label: "与えられた事実", items: facts.given },
    { key: "toInvestigate", label: "調査すべき事項", items: facts.toInvestigate },
    { key: "toDerive", label: "導出すべき事項", items: facts.toDerive },
    { key: "assumptions", label: "推測・仮定", items: facts.assumptions },
  ];

  return h("div", { className: "ledger-content" },
    h("div", { className: "ledger-timestamp" }, `更新: ${new Date(updatedAt).toLocaleTimeString()}`),
    h("div", { className: "ledger-facts" },
      factCategories.map(({ key, label, items }) =>
        items.length > 0 && h("div", { className: "fact-card", key },
          h("div", { className: "fact-card-label" }, label),
          h("ul", { className: "fact-list" },
            items.map((item, i) => h("li", { key: i }, item)),
          ),
        ),
      ),
    ),
    plan.length > 0 && h("div", { className: "ledger-plan" },
      h("div", { className: "fact-card-label" }, "実行計画"),
      h("ol", { className: "plan-list" },
        plan.map((step, i) => h("li", { key: i }, step)),
      ),
    ),
  );
}

function renderProgressLedger(ledger) {
  const judgments = [
    { key: "isRequestSatisfied", label: "リクエスト充足", data: ledger.isRequestSatisfied },
    { key: "isInLoop", label: "ループ検知", data: ledger.isInLoop },
    { key: "isProgressBeingMade", label: "進捗あり", data: ledger.isProgressBeingMade },
  ];

  const actions = [
    { key: "nextAction", label: "次のアクション", data: ledger.nextAction },
    { key: "instruction", label: "サブAgent指示", data: ledger.instruction },
  ];

  return h("div", { className: "ledger-content" },
    h("div", { className: "ledger-timestamp" },
      `反復 #${ledger.iteration} — ${new Date(ledger.updatedAt).toLocaleTimeString()}`,
    ),
    h("div", { className: "ledger-judgments" },
      judgments.map(({ key, label, data }) =>
        h("div", { className: "judgment-item", key },
          h("div", { className: "judgment-header" },
            h("span", { className: "judgment-label" }, label),
            h("span", {
              className: `judgment-badge ${getBadgeClass(key, data.answer)}`,
            }, formatAnswer(data.answer)),
          ),
          h("div", { className: "judgment-reason" }, data.reason),
        ),
      ),
    ),
    h("div", { className: "ledger-actions" },
      actions.map(({ key, label, data }) =>
        h("div", { className: "action-card", key },
          h("div", { className: "action-card-label" }, label),
          h("div", { className: "action-card-answer" }, data.answer),
          data.reason && h("div", { className: "action-card-reason" }, data.reason),
        ),
      ),
    ),
  );
}

function renderProgressHistory(history) {
  const reversed = [...history].reverse();
  return h("div", { className: "ledger-content ledger-history" },
    reversed.map((entry, i) =>
      h("div", { className: "history-entry", key: i },
        h("div", { className: "history-entry-header" },
          h("span", { className: "history-iteration" }, `反復 #${entry.iteration}`),
          h("span", { className: "ledger-timestamp" }, new Date(entry.updatedAt).toLocaleTimeString()),
        ),
        h("div", { className: "history-entry-badges" },
          h("span", {
            className: `judgment-badge judgment-badge--small ${getBadgeClass("isRequestSatisfied", entry.isRequestSatisfied.answer)}`,
            title: `充足: ${entry.isRequestSatisfied.reason}`,
          }, entry.isRequestSatisfied.answer ? "充足" : "未充足"),
          h("span", {
            className: `judgment-badge judgment-badge--small ${getBadgeClass("isInLoop", entry.isInLoop.answer)}`,
            title: `ループ: ${entry.isInLoop.reason}`,
          }, entry.isInLoop.answer ? "ループ" : "正常"),
          h("span", {
            className: `judgment-badge judgment-badge--small ${getBadgeClass("isProgressBeingMade", entry.isProgressBeingMade.answer)}`,
            title: `進捗: ${entry.isProgressBeingMade.reason}`,
          }, entry.isProgressBeingMade.answer ? "進捗あり" : "停滞"),
        ),
        h("div", { className: "history-entry-actions" },
          h("div", { className: "action-card action-card--compact" },
            h("div", { className: "action-card-label" }, "次のアクション"),
            h("div", { className: "action-card-answer" }, entry.nextAction.answer),
          ),
          entry.instruction && entry.instruction.answer && h("div", { className: "action-card action-card--compact" },
            h("div", { className: "action-card-label" }, "サブAgent指示"),
            h("div", { className: "action-card-answer" }, entry.instruction.answer),
          ),
        ),
      ),
    ),
  );
}

function getBadgeClass(key, answer) {
  if (key === "isRequestSatisfied") return answer ? "badge-success" : "badge-danger";
  if (key === "isInLoop") return answer ? "badge-danger" : "badge-success";
  if (key === "isProgressBeingMade") return answer ? "badge-success" : "badge-danger";
  return "badge-neutral";
}

function formatAnswer(answer) {
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  return String(answer);
}

/**
 * Magentic モード用: Orchestrator + 子グループのネスト表示
 */
function renderMagenticContent(group, agents, allGroups, allAgents, stageProgress, magenticProgress, ledger, allLedgers) {
  const elements = [];

  if (ledger) {
    elements.push(
      h(LedgerPanel, { ledger, key: "ledger" }),
    );
  }

  const orchestratorAgent = agents.find(
    (a) => a.agentId === group.orchestratorAgentId,
  );
  if (orchestratorAgent) {
    elements.push(
      h("div", { className: "orchestrator-section", key: "orchestrator" },
        h("div", { className: "orchestrator-label" }, "Orchestrator"),
        h(AgentCard, { agent: orchestratorAgent }),
      ),
    );
  }

  const childGroups = Object.values(allGroups || {}).filter(
    (g) => g.parentGroupId === group.id && g.status === "active",
  );
  for (const childGroup of childGroups) {
    const childAgents = Object.values(allAgents || {}).filter(
      (a) => a.groupId === childGroup.id,
    );
    elements.push(
      h("div", { className: "child-group-wrapper", key: childGroup.id },
        h(GroupSection, {
          group: childGroup,
          agents: childAgents,
          allGroups,
          allAgents,
          stageProgress,
          magenticProgress,
          ledgers: allLedgers,
          defaultExpanded: true,
          isChild: true,
        }),
      ),
    );
  }

  return elements;
}

/**
 * Sequential モード時はステージ別に区切り線を挿入、Concurrent はフラット表示
 */
function renderAgents(agents, mode) {
  if (mode !== "sequential" || agents.every((a) => a.stageIndex == null)) {
    return agents.map((agent) => h(AgentCard, { key: agent.agentId, agent }));
  }

  const grouped = new Map();
  for (const agent of agents) {
    const si = agent.stageIndex ?? 0;
    if (!grouped.has(si)) grouped.set(si, []);
    grouped.get(si).push(agent);
  }

  const sortedStages = [...grouped.keys()].sort((a, b) => a - b);
  const elements = [];
  for (const si of sortedStages) {
    elements.push(
      h("div", { className: "stage-divider", key: `stage-${si}` },
        h("span", { className: "stage-divider-label" }, `Stage ${si + 1}`),
      ),
    );
    for (const agent of grouped.get(si)) {
      elements.push(h(AgentCard, { key: agent.agentId, agent }));
    }
  }
  return elements;
}

/**
 * @param {{ group: object, agents: object[], allGroups?: object, allAgents?: object, stageProgress?: object, magenticProgress?: object, ledgers?: object, defaultExpanded?: boolean, isChild?: boolean }} props
 */
export function GroupSection({
  group,
  agents,
  allGroups = {},
  allAgents = {},
  stageProgress = {},
  magenticProgress = {},
  ledgers = {},
  defaultExpanded,
  isChild = false,
}) {
  // running Agent がある場合はデフォルトで展開
  const hasRunning = agents.some((a) => a.status === "running" || a.status === "queued");
  const [expanded, setExpanded] = useState(defaultExpanded ?? hasRunning ?? true);

  const doneCount = agents.filter((a) =>
    ["completed", "failed", "timedOut", "resultReported"].includes(a.status),
  ).length;
  const total = agents.length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  const mode = group.mode ?? "concurrent";
  const stage = stageProgress[group.id];
  const magentic = magenticProgress[group.id];

  const sectionClass = [
    "group-section",
    isChild ? "group-section--child" : "",
    mode === "magentic" ? "group-section--magentic" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return h("div", { className: sectionClass },
    // ヘッダー
    h("div", {
      className: "group-header",
      onClick: () => setExpanded(!expanded),
    },
      h("span", { className: `group-chevron ${expanded ? "expanded" : ""}` }, "\u25B6"),
      h("span", { className: "group-id" }, group.id),
      mode === "magentic"
        ? h("span", { className: "mode-badge mode-badge-magentic" }, "Magentic")
        : mode === "sequential"
          ? h("span", { className: "mode-badge mode-badge-sequential" }, "直列")
          : h("span", { className: "mode-badge mode-badge-concurrent" }, "並列"),
      magentic && magentic.maxIterations != null
        ? h("span", { className: "magentic-iteration" },
            `反復 ${magentic.iteration ?? 0}/${magentic.maxIterations}`,
          )
        : null,
      stage && stage.total > 1
        ? h("span", { className: "group-stage-progress" },
            `Stage ${stage.current + 1}/${stage.total} 実行中`,
          )
        : null,
      h("span", { className: "group-description" }, group.description),
      h("span", { className: "group-stats" },
        `Agent: ${doneCount}/${total}`,
        h("span", { className: "group-progress" },
          h("span", {
            className: "group-progress-bar",
            style: { width: `${progress}%` },
          }),
        ),
      ),
    ),
    // ボディ（展開時のみ表示）
    expanded
      ? h("div", { className: "group-body" },
          mode === "magentic"
            ? (() => {
                const magenticEls = renderMagenticContent(
                  group,
                  agents,
                  allGroups,
                  allAgents,
                  stageProgress,
                  magenticProgress,
                  ledgers[group.id],
                  ledgers,
                );
                return magenticEls.length > 0
                  ? magenticEls
                  : h("div", { className: "empty-state" },
                      h("div", { className: "empty-state-text" }, "Agent はまだありません"),
                    );
              })()
            : agents.length > 0
              ? renderAgents(agents, mode)
              : h("div", { className: "empty-state" },
                  h("div", { className: "empty-state-text" }, "Agent はまだありません"),
                ),
        )
      : null,
  );
}
