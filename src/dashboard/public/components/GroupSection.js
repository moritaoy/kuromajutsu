// ============================================================
// GroupSection — グループセクション（アコーディオン）
// ============================================================

import { createElement as h, useState } from "react";
import { AgentCard } from "./AgentCard.js";

/**
 * Magentic モード用: Orchestrator + 子グループのネスト表示
 */
function renderMagenticContent(group, agents, allGroups, allAgents, stageProgress, magenticProgress) {
  const elements = [];

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
 * @param {{ group: object, agents: object[], allGroups?: object, allAgents?: object, stageProgress?: object, magenticProgress?: object, defaultExpanded?: boolean, isChild?: boolean }} props
 */
export function GroupSection({
  group,
  agents,
  allGroups = {},
  allAgents = {},
  stageProgress = {},
  magenticProgress = {},
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
