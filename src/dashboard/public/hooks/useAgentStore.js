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
  stageProgress: {},   // groupId → { current: number, total: number }
  magenticProgress: {}, // groupId → { iteration, maxIterations }
};

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
