// ============================================================
// Layout — 共通レイアウト（ヘッダー・ナビゲーション）
// ============================================================

import { createElement as h } from "react";

const NAV_ITEMS = [
  { hash: "#/", label: "Dashboard" },
  { hash: "#/roles", label: "Roles" },
  { hash: "#/history", label: "History" },
  { hash: "#/health", label: "Health" },
  { hash: "#/info", label: "Info" },
];

/**
 * @param {{ currentRoute: string, onNavigate: (hash: string) => void, connected: boolean, children: any }} props
 */
export function Layout({ currentRoute, onNavigate, connected, children }) {
  const connectionClass = connected
    ? "connected"
    : "disconnected";

  return h("div", null,
    // ヘッダー
    h("header", { className: "header" },
      h("span", { className: "header-title" }, "Kuromajutsu"),
      h("span", { className: "badge" }, "v0.1.0"),
      h("span", {
        className: `connection-indicator ${connectionClass}`,
        title: connected ? "接続中" : "切断",
      }),
    ),
    // ナビゲーション
    h("nav", { className: "nav" },
      NAV_ITEMS.map((item) =>
        h("div", {
          key: item.hash,
          className: `nav-item ${currentRoute === item.hash ? "active" : ""}`,
          onClick: () => {
            window.location.hash = item.hash;
            onNavigate(item.hash);
          },
        }, item.label),
      ),
    ),
    // メインコンテンツ
    h("main", { className: "container" }, children),
  );
}
