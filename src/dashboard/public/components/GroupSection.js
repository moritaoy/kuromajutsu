// ============================================================
// GroupSection — グループセクション（アコーディオン）
// ============================================================

import { createElement as h, useState } from "react";
import { AgentCard } from "./AgentCard.js";

/**
 * @param {{ group: object, agents: object[], defaultExpanded?: boolean }} props
 */
export function GroupSection({ group, agents, defaultExpanded }) {
  // running Agent がある場合はデフォルトで展開
  const hasRunning = agents.some((a) => a.status === "running" || a.status === "queued");
  const [expanded, setExpanded] = useState(defaultExpanded ?? hasRunning ?? true);

  const doneCount = agents.filter((a) =>
    ["completed", "failed", "timedOut", "resultReported"].includes(a.status),
  ).length;
  const total = agents.length;
  const progress = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return h("div", { className: "group-section" },
    // ヘッダー
    h("div", {
      className: "group-header",
      onClick: () => setExpanded(!expanded),
    },
      h("span", { className: `group-chevron ${expanded ? "expanded" : ""}` }, "\u25B6"),
      h("span", { className: "group-id" }, group.id),
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
          agents.length > 0
            ? agents.map((agent) =>
                h(AgentCard, { key: agent.agentId, agent }),
              )
            : h("div", { className: "empty-state" },
                h("div", { className: "empty-state-text" }, "Agent はまだありません"),
              ),
        )
      : null,
  );
}
