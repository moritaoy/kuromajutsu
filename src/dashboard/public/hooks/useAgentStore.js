// ============================================================
// useAgentStore — Agent/Group 状態管理フック
// ============================================================
// useReducer + Context で全状態を管理

import { useReducer, useCallback } from "react";

/** 初期状態 */
const initialState = {
  groups: {},       // groupId → GroupDefinition
  agents: {},       // agentId → AgentState
  healthChecks: {}, // roleId → HealthCheckResult
  config: null,
  serverStatus: "connecting",
  serverStartedAt: null,
  availableModels: [], // 利用可能モデル一覧
  availableModelsByProvider: {}, // Provider 別の利用可能モデル一覧
  stageProgress: {},   // groupId → { current: number, total: number }
  magenticProgress: {}, // groupId → { iteration, maxIterations }
  ledgers: {},          // groupId → MagenticLedger
  // --- Workspace（docs/spec.md §13） ---
  workspaces: {},       // workspaceId → Workspace（サーバーの workspace:updated が最終的な正）
  workspaceMeta: {},    // workspaceId → { validation, planGenerating, planMessage, lastPlanError, pendingComments, ... }
  workspaceLog: {},     // workspaceId → 活動ログ（workspace:* イベントから積む）
  activeWorkspaceId: null,
};

const MAX_WORKSPACE_LOG = 300;

/**
 * Reducer: ServerEvent を受けて状態を更新する
 */
function agentReducer(state, action) {
  switch (action.type) {
    case "server:startup":
      return {
        ...state,
        serverStatus: "connected",
        serverStartedAt: action.data.startedAt,
        availableModels: action.data.availableModels || [],
        availableModelsByProvider: action.data.availableModelsByProvider || {},
      };

    case "healthcheck:model_validation":
      return updateHealthChecks(state, action.data.results);

    case "healthcheck:role_start": {
      const existing = state.healthChecks[action.data.roleId] || {};
      return {
        ...state,
        healthChecks: {
          ...state.healthChecks,
          [action.data.roleId]: {
            ...existing,
            roleId: action.data.roleId,
            _checking: true,
          },
        },
      };
    }

    case "healthcheck:role_complete": {
      return {
        ...state,
        healthChecks: {
          ...state.healthChecks,
          [action.data.roleId]: { ...action.data, _checking: false },
        },
      };
    }

    case "healthcheck:complete":
      return updateHealthChecks(state, action.data.results);

    case "group:created": {
      const group = action.data;
      return {
        ...state,
        groups: {
          ...state.groups,
          [group.id]: {
            ...group,
            mode: group.mode ?? "concurrent",
            parentGroupId: group.parentGroupId,
            orchestratorAgentId: group.orchestratorAgentId,
          },
        },
      };
    }

    case "group:updated": {
      const updated = action.data;
      const existing = state.groups[updated.id];
      if (!existing) return state;
      return {
        ...state,
        groups: {
          ...state.groups,
          [updated.id]: { ...existing, ...updated },
        },
      };
    }

    case "group:magentic_iteration": {
      const { groupId, iteration, maxIterations } = action.data;
      return {
        ...state,
        magenticProgress: {
          ...state.magenticProgress,
          [groupId]: { iteration, maxIterations },
        },
      };
    }

    case "group:ledger_updated": {
      const ledger = action.data;
      return {
        ...state,
        ledgers: {
          ...state.ledgers,
          [ledger.groupId]: ledger,
        },
      };
    }

    case "group:stage_advanced": {
      const { groupId, stageIndex, totalStages } = action.data;
      return {
        ...state,
        stageProgress: {
          ...state.stageProgress,
          [groupId]: { current: stageIndex, total: totalStages },
        },
      };
    }

    case "group:deleted": {
      const groupId = action.data.groupId;
      const group = state.groups[groupId];
      if (!group) return state;

      const groups = {
        ...state.groups,
        [groupId]: { ...group, status: "deleted" },
      };

      const agents = { ...state.agents };

      const deletedGroupIds = new Set(
        Object.values(groups)
          .filter((g) => g.status === "deleted")
          .map((g) => g.id),
      );
      const historyAgents = Object.values(agents)
        .filter((a) => deletedGroupIds.has(a.groupId))
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );

      const MAX_HISTORY = 20;
      if (historyAgents.length > MAX_HISTORY) {
        for (const agent of historyAgents.slice(MAX_HISTORY)) {
          delete agents[agent.agentId];
        }
      }

      for (const gid of deletedGroupIds) {
        const hasAgents = Object.values(agents).some((a) => a.groupId === gid);
        if (!hasAgents) {
          delete groups[gid];
        }
      }

      return { ...state, groups, agents };
    }

    case "agent:created":
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentId]: action.data,
        },
      };

    case "agent:status_update": {
      const existing = state.agents[action.data.agentId];
      if (!existing) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentId]: { ...existing, ...action.data },
        },
      };
    }

    case "agent:completed": {
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentId]: action.data,
        },
      };
    }

    case "agent:result_reported": {
      const agent = state.agents[action.data.agentId];
      if (!agent) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentId]: {
            ...agent,
            status: "resultReported",
            result: action.data,
          },
        },
      };
    }

    case "config:updated":
      return { ...state, config: action.data };

    case "SET_CONNECTED":
      return { ...state, serverStatus: "connected" };

    case "SET_DISCONNECTED":
      return { ...state, serverStatus: "disconnected" };

    case "SET_CONNECTING":
      return { ...state, serverStatus: "connecting" };

    default:
      if (typeof action.type === "string" && action.type.startsWith("workspace:")) {
        return workspaceReducer(state, action);
      }
      return state;
  }
}

// ============================================================
// Workspace 用 reducer（既存ケースには手を入れず、ここに集約）
// ============================================================

function patchMeta(state, id, patch) {
  const prev = state.workspaceMeta[id] || {};
  const next = typeof patch === "function" ? patch(prev) : patch;
  return {
    ...state,
    workspaceMeta: { ...state.workspaceMeta, [id]: { ...prev, ...next } },
  };
}

function pushLog(state, id, entry) {
  const list = state.workspaceLog[id] || [];
  const next = [...list, { at: new Date().toISOString(), ...entry }];
  if (next.length > MAX_WORKSPACE_LOG) next.splice(0, next.length - MAX_WORKSPACE_LOG);
  return { ...state, workspaceLog: { ...state.workspaceLog, [id]: next } };
}

/** ISO 8601 文字列の比較。既存より古い updatedAt なら true */
function isStale(prev, incoming) {
  return !!prev && !!prev.updatedAt && !!incoming.updatedAt && prev.updatedAt > incoming.updatedAt;
}

function stepLabel(s) {
  return s && s.stepId ? `${s.stepId} ${(s.description || "").split("\n")[0].slice(0, 40)}` : "";
}

function workspaceReducer(state, action) {
  const d = action.data;
  switch (action.type) {
    case "workspace:created":
    case "workspace:updated": {
      const ws = d;
      const prev = state.workspaces[ws.id];
      // 古いレスポンス（HTTP）で新しい WebSocket の状態を上書きしない（同値は置換してよい）
      if (isStale(prev, ws)) return state;
      let next = { ...state, workspaces: { ...state.workspaces, [ws.id]: ws } };
      next = patchMeta(next, ws.id, (m) => ({
        // planning を抜けたら生成中の表示を止める（plan_ready / plan_failed が先に来ない場合の保険）
        planGenerating: ws.status === "planning" ? m.planGenerating !== false : false,
      }));
      if (prev && prev.status !== ws.status) {
        next = pushLog(next, ws.id, {
          kind: "status",
          text: `状態: ${prev.status} → ${ws.status}${ws.statusReason ? `（${ws.statusReason.message}）` : ""}`,
        });
      }
      return next;
    }

    // UI 内部: GET /api/workspaces/:id の結果（validation 付き）を取り込む
    case "workspace:loaded": {
      const { validation, ...ws } = d;
      // 古い応答なら Workspace 本体は置き換えない（検証結果は、その revision の分だけ取り込む）
      if (isStale(state.workspaces[ws.id], ws)) {
        const cur = state.workspaces[ws.id];
        if (cur.revisions.length !== ws.revisions.length) return state;
        return patchMeta(state, ws.id, { validation: validation || [], validationRevision: ws.revisions.length });
      }
      let next = { ...state, workspaces: { ...state.workspaces, [ws.id]: ws } };
      next = patchMeta(next, ws.id, { validation: validation || [], validationRevision: ws.revisions.length });
      return next;
    }

    case "workspace:select":
      return { ...state, activeWorkspaceId: d && d.workspaceId ? d.workspaceId : null };

    case "workspace:plan_generating":
      return patchMeta(state, d.workspaceId, {
        planGenerating: true,
        planMessage: d.message || "計画を生成しています",
        planRevision: d.revision,
        lastPlanError: null,
      });

    case "workspace:plan_ready": {
      const next = patchMeta(state, d.workspaceId, (m) => ({
        validation: d.validation || [],
        validationRevision: d.revision,
        planGenerating: false,
        lastPlanError: null,
        instructions: (m.instructions || []).map((x) => (x.pending ? { ...x, pending: false } : x)),
      }));
      return pushLog(next, d.workspaceId, { kind: "plan", text: `計画 rev ${d.revision} ができました` });
    }

    case "workspace:plan_failed": {
      // 再計画が失敗したら、送った指示を履歴から外し、入力欄に戻せるように取っておく
      const next = patchMeta(state, d.workspaceId, (m) => {
        const list = m.instructions || [];
        const failed = [...list].reverse().find((x) => x.pending);
        return {
          planGenerating: false,
          lastPlanError: d.message,
          instructions: list.filter((x) => !x.pending),
          failedInstruction: failed ? { text: failed.text, targets: failed.targets } : m.failedInstruction,
        };
      });
      return pushLog(next, d.workspaceId, { kind: "gate-fail", text: d.message });
    }

    case "workspace:phase_planned": {
      const ids = (d.addedSteps || []).map((s) => s.stepId);
      let next = patchMeta(state, d.workspaceId, (m) => ({
        plannedSteps: { ...(m.plannedSteps || {}), ...Object.fromEntries(ids.map((id) => [id, d.phaseId])) },
      }));
      next = pushLog(next, d.workspaceId, {
        kind: "plan",
        stepId: ids[0],
        text: `直前計画: フェーズ ${d.phaseId} の手順を決定 → ${(d.addedSteps || []).map(stepLabel).join(" / ")}`,
      });
      return next;
    }

    case "workspace:replanned": {
      const added = d.added || [], changed = d.changed || [], removed = d.removed || [];
      let next = patchMeta(state, d.workspaceId, (m) => ({
        replannedSteps: {
          ...(m.replannedSteps || {}),
          ...Object.fromEntries(added.map((s) => [s.stepId, "added"])),
          ...Object.fromEntries(changed.map((s) => [s.stepId, "changed"])),
        },
        replanCount: (m.replanCount || 0) + 1,
      }));
      const parts = [];
      if (added.length) parts.push(`追加 ${added.map(stepLabel).join(" / ")}`);
      if (changed.length) parts.push(`変更 ${changed.map(stepLabel).join(" / ")}`);
      if (removed.length) parts.push(`削除 ${removed.join(", ")}`);
      next = pushLog(next, d.workspaceId, { kind: "replan", stepId: (added[0] || changed[0] || {}).stepId, text: `リプラン: ${parts.join("、") || "（変更なし）"}` });
      return next;
    }

    case "workspace:gate_result": {
      const gr = d.gateResult;
      const cur = state.workspaces[d.workspaceId];
      let next = state;
      if (cur) {
        const list = cur.gateResults.filter((g) => g.gateId !== gr.gateId).concat(gr);
        next = { ...state, workspaces: { ...state.workspaces, [cur.id]: { ...cur, gateResults: list } } };
      }
      const last = gr.attempts[gr.attempts.length - 1];
      const passedN = last ? last.checks.filter((c) => c.passed).length : 0;
      const total = last ? last.checks.length : 0;
      const ok = gr.status === "passed" || gr.status === "auto_passed" || gr.status === "waiting_human";
      return pushLog(next, d.workspaceId, {
        kind: ok ? "gate-pass" : gr.status === "failed" ? "gate-fail" : "info",
        stepId: gr.gateId,
        text: `${gr.gateId} ${gr.status}（${passedN}/${total} チェック合格、attempt ${gr.attempts.length}）`,
      });
    }

    case "workspace:gate_retry_exceeded": {
      const next = patchMeta(state, d.workspaceId, { retryExceededGateId: d.gateId });
      return pushLog(next, d.workspaceId, { kind: "gate-fail", stepId: d.gateId, text: `${d.gateId}: 差し戻し上限を超過。人の判断待ち` });
    }

    case "workspace:human_review_requested": {
      const next = patchMeta(state, d.workspaceId, { pendingComments: [] });
      return pushLog(next, d.workspaceId, { kind: "human", stepId: d.review.gateId, text: `人間レビュー待ち: ${d.review.gateId}（v${d.review.version}）` });
    }

    case "workspace:human_review_resolved":
      return pushLog(state, d.workspaceId, {
        kind: d.review.status === "approved" ? "human-ok" : "human-ng",
        stepId: d.review.gateId,
        text: `人間レビュー ${d.review.gateId} v${d.review.version}: ${d.review.status === "approved" ? "承認" : "差し戻し"}`,
      });

    case "workspace:resumed":
      return pushLog(state, d.workspaceId, { kind: "info", text: `Orchestrator を再開（${d.reason}）` });

    case "workspace:irregular":
      return pushLog(state, d.workspaceId, {
        kind: "irregular",
        stepId: d.change.gateId,
        text: `イレギュラー: ゲート ${d.change.gateId} が変更された（${d.change.reason}）`,
      });

    // UI 内部: 人間レビューのコメント（iframe からの review:comment）
    case "workspace:set_pending_comments":
      return patchMeta(state, d.workspaceId, { pendingComments: d.comments });

    // UI 内部: iframe からの review:comment を 1 件追加する（関数型更新。連続して届いても取りこぼさない）
    case "workspace:add_pending_comment":
      return patchMeta(state, d.workspaceId, (m) => ({
        pendingComments: [...(m.pendingComments || []), d.comment].slice(-100),
      }));

    // UI 内部: このセッションで送った追加指示（サーバーは revision ごとの指示を保持しないため）
    case "workspace:local_instruction":
      return patchMeta(state, d.workspaceId, (m) => ({
        instructions: [...(m.instructions || []), { text: d.text, targets: d.targets || [], at: d.at, baseRevision: d.baseRevision, pending: true }],
        failedInstruction: null,
      }));

    case "workspace:clear_failed_instruction":
      return patchMeta(state, d.workspaceId, { failedInstruction: null });

    default:
      return state;
  }
}

function updateHealthChecks(state, results) {
  const healthChecks = { ...state.healthChecks };
  for (const r of results) {
    healthChecks[r.roleId] = { ...r, _checking: false };
  }
  return { ...state, healthChecks };
}

/**
 * @returns {{ state: object, dispatch: function }}
 */
export function useAgentStore() {
  const [state, dispatch] = useReducer(agentReducer, initialState);
  return { state, dispatch };
}
