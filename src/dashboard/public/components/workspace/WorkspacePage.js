// ============================================================
// WorkspacePage — #/workspace（`#/workspace/<id>` で特定の Workspace を開く）
// ============================================================
// status に応じて 4 画面を出す（spec §13.10.1）。状態はすべてサーバー由来（楽観的更新はしない）。
//   planning → 生成中 / review → 計画レビュー / running・waiting_human → 実行 / done → 完了レポート
//   failed・aborted → 理由 + 最後の計画（読み取り専用）

import { createElement as h, useState, useEffect, useRef, useMemo } from "react";
import { workspaceApi } from "../../hooks/useWorkspaceApi.js";
import { InstructView } from "./InstructView.js";
import { ReviewView } from "./ReviewView.js";
import { RunView, ReadonlyBoard } from "./RunView.js";
import { ReportView } from "./ReportView.js";
import { IrregularBanner } from "./IrregularBanner.js";
import { STATUS_LABEL, fmtDateTime, truncate } from "./plan-utils.js";

const BASE = "#/workspace";

/** `#/workspace/<id>` から id を取り出す（なければ null） */
export function workspaceIdFromRoute(route) {
  const m = /^#\/workspace\/([^/?#]+)/.exec(route || "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function openWorkspace(id) {
  window.location.hash = id ? `${BASE}/${encodeURIComponent(id)}` : BASE;
}

// --------------------------------------------------
// 上部の Workspace 切替
// --------------------------------------------------

function StatusBadge({ status }) {
  return h("span", { className: `st-badge st-${status}` }, STATUS_LABEL[status] || status);
}

function Switcher({ workspaces, currentId, onOpen }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const list = [...workspaces].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const current = currentId ? workspaces.find((w) => w.id === currentId) : null;

  return h("div", { className: "wsbar" },
    h("div", { className: "wsw", ref },
      h("button", { className: "wsw-btn", onClick: () => setOpen(!open), "aria-expanded": open },
        current
          ? [h(StatusBadge, { key: "b", status: current.status }), h("span", { key: "t", className: "wsw-t" }, truncate(current.instruction, 56))]
          : h("span", { className: "wsw-t muted" }, list.length ? "Workspace を選ぶ" : "Workspace なし"),
        h("span", { className: "wsw-c" }, "▾")),
      open && h("div", { className: "wsw-menu" },
        list.length === 0 && h("div", { className: "wsw-empty" }, "Workspace はまだありません"),
        list.map((w) => h("div", { key: w.id, className: `wsw-item${w.id === currentId ? " cur" : ""}`, onClick: () => { setOpen(false); onOpen(w.id); } },
          h(StatusBadge, { status: w.status }),
          h("span", { className: "wsw-t" }, truncate(w.instruction, 64)),
          h("span", { className: "wsw-d" }, fmtDateTime(w.createdAt)))))),
    h("button", { className: "wbtn sm", onClick: () => onOpen(null) }, "＋ 新しい指示"));
}

// --------------------------------------------------
// ① 計画生成中
// --------------------------------------------------

function PlanningView({ workspace, meta, state, api, dispatch }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // 計画生成グループの Planner Agent の様子
  const planner = useMemo(() => {
    const gids = new Set(Object.values(state.groups).filter((g) => g.workspaceId === workspace.id && g.status === "active").map((g) => g.id));
    return Object.values(state.agents).filter((a) => gids.has(a.groupId)).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] || null;
  }, [state.groups, state.agents, workspace.id]);

  const last = workspace.revisions.length;
  const rev = (meta && meta.planRevision) || last + 1;
  const instrs = (meta && meta.instructions) || [];
  const lastInstr = last > 0 ? instrs[instrs.length - 1] : null;

  const abort = async () => {
    if (busy || !window.confirm("計画の生成を中断しますか？")) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await api.abort(workspace.id);
      if (ws && ws.id) dispatch({ type: "workspace:updated", data: ws });
    } catch (e) {
      setError(e.message || String(e));
      setBusy(false);
    }
  };

  return h("div", { className: "planning" },
    h("div", { className: "echo" }, h("span", { className: "caret" }, ">"), lastInstr ? lastInstr.text : workspace.instruction),
    h("ul", null,
      h("li", { className: "on" }, h("span", { className: "spin" }), (meta && meta.planMessage) || "計画を生成しています", h("span", { className: "muted" }, `rev ${rev}`)),
      planner && h("li", { className: "ok" }, h("span", { className: "mk" }, "·"),
        `Planner ${planner.status}${planner.toolCallCount ? ` · ツール ${planner.toolCallCount} 回` : ""}${planner.lastAssistantMessage ? ` — ${truncate(planner.lastAssistantMessage, 90)}` : ""}`)),
    h("div", { className: "planning-act" },
      h("button", { className: "wbtn sm danger", disabled: busy, onClick: abort }, "中断")),
    error && h("div", { className: "ws-error" }, error));
}

// --------------------------------------------------
// failed / aborted
// --------------------------------------------------

function EndedView({ workspace, meta, config, state, api, dispatch }) {
  const reason = workspace.statusReason;
  return h("div", null,
    h("div", { className: `ended ${workspace.status}` },
      h("div", { className: "ended-h" }, h(StatusBadge, { status: workspace.status }), reason ? reason.message : STATUS_LABEL[workspace.status]),
      h("div", { className: "ended-i" }, h("span", { className: "caret" }, ">"), workspace.instruction),
      reason && h("div", { className: "hint" }, `code: ${reason.code}${reason.gateId ? ` · gate: ${reason.gateId}` : ""}`),
      h("div", { style: { marginTop: 10 } }, h("button", { className: "wbtn sm", onClick: () => openWorkspace(null) }, "新しい指示を書く"))),
    // 終了後も、未確認のイレギュラーは確認できるようにする（確認済みは折りたたみで残る）
    h(IrregularBanner, { workspace, api, dispatch }),
    workspace.revisions.length > 0 && h(ReadonlyBoard, { workspace, meta, config, state }));
}

// --------------------------------------------------
// ページ
// --------------------------------------------------

/**
 * @param {{ route: string, state: object, dispatch: function }} props
 */
export function WorkspacePage({ route, state, dispatch }) {
  const api = workspaceApi;
  const routeId = workspaceIdFromRoute(route);
  const workspace = routeId ? state.workspaces[routeId] : null;
  const meta = routeId ? state.workspaceMeta[routeId] : null;
  const config = state.config;
  const [loadState, setLoadState] = useState("idle"); // idle | loading | notfound

  useEffect(() => {
    dispatch({ type: "workspace:select", data: { workspaceId: routeId } });
  }, [routeId, dispatch]);

  // 直接 URL を開いた（WebSocket の初期状態がまだ / 一覧に無い）場合は GET で取得する
  useEffect(() => {
    if (!routeId || workspace) { setLoadState("idle"); return undefined; }
    let cancelled = false;
    setLoadState("loading");
    const t = setTimeout(() => {
      api.get(routeId)
        .then((ws) => { if (!cancelled) dispatch({ type: "workspace:loaded", data: ws }); })
        .catch((e) => { if (!cancelled) setLoadState(e && e.status === 404 ? "notfound" : "idle"); });
    }, 600); // WebSocket の初期状態を少し待つ
    return () => { cancelled = true; clearTimeout(t); };
  }, [routeId, !!workspace, api, dispatch]);

  const workspaces = Object.values(state.workspaces);

  const create = async ({ instruction, workspacePath }) => {
    const ws = await api.create({ instruction, workspacePath });
    if (ws && ws.id) {
      dispatch({ type: "workspace:created", data: ws });
      openWorkspace(ws.id);
    }
  };

  let body;
  let withBar = false;
  if (!routeId) {
    body = h(InstructView, { onSubmit: create });
  } else if (!workspace) {
    body = h("div", { className: "empty-box" }, loadState === "notfound" ? `Workspace が見つかりません: ${routeId}` : "読み込み中…");
  } else {
    const common = { workspace, meta, config, state, api, dispatch };
    switch (workspace.status) {
      case "planning":
        body = h(PlanningView, common);
        break;
      case "review":
        if (workspace.revisions.length === 0) {
          body = h("div", { className: "empty-box" }, "計画がありません");
        } else {
          withBar = true;
          body = h(ReviewView, common);
        }
        break;
      case "running":
      case "waiting_human":
        body = h(RunView, common);
        break;
      case "done":
        body = h(ReportView, common);
        break;
      default:
        body = h(EndedView, common);
    }
  }

  return h("div", { className: `ws-root${withBar ? " has-bar" : ""}` },
    h(Switcher, { workspaces, currentId: routeId, onOpen: openWorkspace }),
    h("div", { key: routeId || "new" }, body));
}
