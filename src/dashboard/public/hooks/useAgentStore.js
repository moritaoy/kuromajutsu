// ============================================================
// useAgentStore — Agent/Group 状態管理フック
// ============================================================
// useReducer + Context で全状態を管理

import { useReducer, useCallback } from "react";

/** 初期状態 */
const initialState = {
  groups: {},      // groupId → GroupDefinition
  agents: {},      // agentId → AgentState
  healthChecks: {}, // roleId → HealthCheckResult
  config: null,
  serverStatus: "connecting",
  serverStartedAt: null,
  availableModels: [], // 利用可能モデル一覧
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

    case "group:created":
      return {
        ...state,
        groups: {
          ...state.groups,
          [action.data.id]: action.data,
        },
      };

    case "group:deleted": {
      const groupId = action.data.groupId;
      // グループを state から削除
      const groups = { ...state.groups };
      delete groups[groupId];
      // グループに所属する Agent も削除
      const agents = { ...state.agents };
      for (const [agentId, agent] of Object.entries(agents)) {
        if (agent.groupId === groupId) {
          delete agents[agentId];
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
