// ============================================================
// HistoryTable — 実行履歴テーブル
// ============================================================

import { createElement as h, useState, useMemo } from "react";

/** ステータスのラベル・バッジクラス */
const STATUS_MAP = {
  success: { label: "\u2705 成功", cls: "success" },
  failure: { label: "\u274C 失敗", cls: "failure" },
  timeout: { label: "\u26A0 タイムアウト", cls: "timeout" },
  cancelled: { label: "\u23F9 キャンセル", cls: "cancelled" },
};

/**
 * @param {{ agents: object[], groups: object }} props
 */
export function HistoryTable({ agents, groups }) {
  const [filterGroup, setFilterGroup] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterRole, setFilterRole] = useState("all");

  // 完了済み Agent のみフィルタ（result があるもの、または completed/failed/timedOut/resultReported）
  const completedAgents = useMemo(() => {
    return Object.values(agents).filter((a) =>
      ["completed", "failed", "timedOut", "resultReported"].includes(a.status),
    );
  }, [agents]);

  // フィルタ適用
  const filtered = useMemo(() => {
    let list = completedAgents;
    if (filterGroup !== "all") {
      list = list.filter((a) => a.groupId === filterGroup);
    }
    if (filterStatus !== "all") {
      list = list.filter((a) => {
        if (a.result) return a.result.status === filterStatus;
        return a.status === filterStatus;
      });
    }
    if (filterRole !== "all") {
      list = list.filter((a) => a.role === filterRole);
    }
    // 時系列ソート（新しい順）
    return list.sort((a, b) => {
      const ta = a.result ? a.result.timestamp : a.startedAt;
      const tb = b.result ? b.result.timestamp : b.startedAt;
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
  }, [completedAgents, filterGroup, filterStatus, filterRole]);

  // フィルタ用の一意値
  const groupIds = [...new Set(completedAgents.map((a) => a.groupId))];
  const roles = [...new Set(completedAgents.map((a) => a.role))];

  if (completedAgents.length === 0) {
    return h("div", null,
      h("h2", { className: "page-title" }, "実行履歴"),
      h("div", { className: "empty-state" },
        h("div", { className: "empty-state-icon" }, "\uD83D\uDCDC"),
        h("div", { className: "empty-state-text" }, "実行履歴がありません"),
        h("div", { className: "empty-state-subtext" }, "Agent の実行が完了すると、ここに表示されます"),
      ),
    );
  }

  return h("div", null,
    h("h2", { className: "page-title" }, "実行履歴"),

    // フィルタバー
    h("div", { className: "filter-bar" },
      h("select", {
        value: filterGroup,
        onChange: (e) => setFilterGroup(e.target.value),
      },
        h("option", { value: "all" }, "全グループ"),
        groupIds.map((gid) =>
          h("option", { key: gid, value: gid },
            groups[gid] ? `${groups[gid].description} (${gid})` : gid,
          ),
        ),
      ),
      h("select", {
        value: filterStatus,
        onChange: (e) => setFilterStatus(e.target.value),
      },
        h("option", { value: "all" }, "全ステータス"),
        h("option", { value: "success" }, "成功"),
        h("option", { value: "failure" }, "失敗"),
        h("option", { value: "timeout" }, "タイムアウト"),
        h("option", { value: "cancelled" }, "キャンセル"),
      ),
      h("select", {
        value: filterRole,
        onChange: (e) => setFilterRole(e.target.value),
      },
        h("option", { value: "all" }, "全職種"),
        roles.map((r) => h("option", { key: r, value: r }, r)),
      ),
    ),

    // テーブル
    h("table", { className: "history-table" },
      h("thead", null,
        h("tr", null,
          h("th", null, "Agent ID"),
          h("th", null, "グループ"),
          h("th", null, "職種"),
          h("th", null, "状態"),
          h("th", null, "サマリ"),
          h("th", null, "時間"),
          h("th", null, "日時"),
        ),
      ),
      h("tbody", null,
        filtered.map((agent) => {
          const result = agent.result;
          const status = result ? result.status : agent.status;
          const statusInfo = STATUS_MAP[status] || { label: status, cls: "" };
          const durationMs = result ? result.duration_ms : agent.elapsed_ms;
          const durationSec = durationMs ? (durationMs / 1000).toFixed(1) + "s" : "-";
          const timestamp = result ? result.timestamp : agent.startedAt;
          const summary = result ? result.summary : (agent.lastAssistantMessage || "-");
          const groupDesc = groups[agent.groupId]
            ? groups[agent.groupId].description
            : agent.groupId;

          return h("tr", { key: agent.agentId },
            h("td", {
              style: { fontFamily: "'SF Mono', Consolas, monospace", fontSize: "12px" },
            }, agent.agentId),
            h("td", null, groupDesc),
            h("td", null, agent.role),
            h("td", null,
              h("span", { className: `status-badge ${statusInfo.cls}` }, statusInfo.label),
            ),
            h("td", {
              style: { maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, summary),
            h("td", null, durationSec),
            h("td", { style: { fontSize: "12px", color: "var(--text-secondary)" } },
              new Date(timestamp).toLocaleString("ja-JP"),
            ),
          );
        }),
      ),
    ),
  );
}
