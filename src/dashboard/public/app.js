// ============================================================
// Kuromajutsu Dashboard — ルートコンポーネント
// ============================================================
// CDN ベースの React SPA（ビルドステップなし）
// React.createElement を直接使用

import { createElement as h, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useAgentStore } from "./hooks/useAgentStore.js";
import { Layout } from "./components/Layout.js";
import { GroupSection } from "./components/GroupSection.js";
import { HealthStatus } from "./components/HealthStatus.js";
import { RoleEditor } from "./components/RoleEditor.js";
import { HistoryTable } from "./components/HistoryTable.js";
import { ModelList } from "./components/ModelList.js";

// ============================================================
// ダッシュボード画面（メイン）
// ============================================================

function DashboardPage({ state }) {
  const groups = Object.values(state.groups).filter((g) => g.status === "active");
  const agents = state.agents;

  if (groups.length === 0 && Object.keys(agents).length === 0) {
    return h("div", null,
      h("h2", { className: "page-title" }, "Dashboard"),
      h("div", { className: "empty-state" },
        h("div", { className: "empty-state-icon" }, "\uD83E\uDDD9"),
        h("div", { className: "empty-state-text" }, "Agent はまだ実行されていません"),
        h("div", { className: "empty-state-subtext" },
          "MCP ツール create_group → run_agent で Agent を起動できます",
        ),
      ),
    );
  }

  return h("div", null,
    h("h2", { className: "page-title" }, "Dashboard"),
    groups.map((group) => {
      const groupAgents = Object.values(agents).filter(
        (a) => a.groupId === group.id,
      );
      return h(GroupSection, {
        key: group.id,
        group,
        agents: groupAgents,
        defaultExpanded: true,
      });
    }),
  );
}

// ============================================================
// 職種管理画面
// ============================================================

function RolesPage({ state, ws }) {
  const roles = state.config ? state.config.roles : [];

  if (roles.length === 0) {
    return h("div", null,
      h("h2", { className: "page-title" }, "職種管理"),
      h("div", { className: "empty-state" },
        h("div", { className: "empty-state-icon" }, "\uD83D\uDC77"),
        h("div", { className: "empty-state-text" }, "職種が設定されていません"),
        h("div", { className: "empty-state-subtext" },
          "kuromajutsu.config.yaml に職種を定義してください",
        ),
      ),
    );
  }

  return h("div", null,
    h("h2", { className: "page-title" }, "職種管理"),
    roles.map((role) =>
      h(RoleEditor, {
        key: role.id,
        role,
        healthCheck: state.healthChecks[role.id] || null,
        onSave: (updated) => {
          ws.send({ type: "config:update_role", data: updated });
        },
        onRevalidate: (roleId) => {
          ws.send({ type: "config:revalidate_model", data: { roleId } });
        },
      }),
    ),
  );
}

// ============================================================
// 実行履歴画面
// ============================================================

function HistoryPage({ state }) {
  return h(HistoryTable, {
    agents: state.agents,
    groups: state.groups,
  });
}

// ============================================================
// ヘルスチェック画面
// ============================================================

function HealthPage({ state }) {
  const roles = state.config ? state.config.roles : [];
  return h(HealthStatus, {
    healthChecks: state.healthChecks,
    roles,
  });
}

// ============================================================
// 情報画面
// ============================================================

function InfoPage({ state }) {
  return h("div", null,
    h("h2", { className: "page-title" }, "システム情報"),
    h(ModelList, { models: state.availableModels }),
  );
}

// ============================================================
// App ルートコンポーネント
// ============================================================

function App() {
  const [route, setRoute] = useState(window.location.hash || "#/");
  const { state, dispatch } = useAgentStore();
  const ws = useWebSocket();

  // WebSocket イベントを state に反映
  useEffect(() => {
    const cleanup = ws.onMessage((event) => {
      dispatch(event);
    });
    return cleanup;
  }, [ws, dispatch]);

  // 接続状態の管理
  useEffect(() => {
    if (ws.connected) {
      dispatch({ type: "SET_CONNECTED" });
    } else {
      dispatch({ type: "SET_DISCONNECTED" });
    }
  }, [ws.connected, dispatch]);

  // ハッシュ変更リスナー
  useEffect(() => {
    const handler = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // ルーティング
  const renderPage = () => {
    switch (route) {
      case "#/":
        return h(DashboardPage, { state });
      case "#/roles":
        return h(RolesPage, { state, ws });
      case "#/history":
        return h(HistoryPage, { state });
      case "#/health":
        return h(HealthPage, { state });
      case "#/info":
        return h(InfoPage, { state });
      default:
        return h(DashboardPage, { state });
    }
  };

  return h(Layout, {
    currentRoute: route,
    onNavigate: setRoute,
    connected: ws.connected,
  }, renderPage());
}

// ============================================================
// マウント
// ============================================================

const root = createRoot(document.getElementById("app"));
root.render(h(App));
