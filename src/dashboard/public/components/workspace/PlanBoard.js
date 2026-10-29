// ============================================================
// PlanBoard — フェーズ帯ボード（モック workspace.html の Board / PhaseBand / StepCard / drawEdges の移植）
// ============================================================
// フェーズを上から積み、帯の中は依存段ごとに手順を横に並べる（= 並列）。
// 依存は SVG の直交ルーティングで結ぶ。状態はすべて props（サーバー由来）から描く。

import { createElement as h, useRef, useLayoutEffect, useState, useMemo } from "react";
import {
  computeLevels, phaseRows, phaseState, stepsOf, workOf, gateOf, fixesOf, stepById, phaseById,
  isHuman, roleInfo, MARK_LABEL, PHASE_COLORS, PHASE_STATE_LABEL,
} from "./plan-utils.js";

// --------------------------------------------------
// 小さな部品
// --------------------------------------------------

/** 職種名とモデル名（小さく）。実行環境（cursor / claude）は出さない */
export function RoleChip({ config, role }) {
  const r = roleInfo(config, role);
  return h("span", { className: "role", style: { "--rc": r.color }, title: r.model || r.name },
    h("i"), role, r.model ? h("span", { className: "mdl" }, r.model) : null);
}

const PILL = {
  waiting: "レビュー待ち",
  running: (s) => (s.kind === "gate" ? "チェック中" : "実行中"),
  done: (s) => (s.kind === "gate" ? "合格" : "完了"),
  skipped: "スキップ",
};

function pillText(s) {
  if (!s.status) return "";
  if (s.gateFailed) return "差し戻し";
  const p = PILL[s.status];
  if (!p) return "待機";
  return typeof p === "function" ? p(s) : p;
}

// --------------------------------------------------
// カード
// --------------------------------------------------

function StepCard({ step: s, mode, config, isFinal, isTarget, isSelected, lit, onClick, onHover }) {
  const review = mode === "review";
  const live = mode === "run" && !!s.status;
  const hum = isHuman(s);
  const cls = [
    "card", s.kind, isFinal ? "final" : "", hum ? "human" : "",
    live ? s.status : "", live && s.gateFailed ? "rework" : "",
    s.mark ? `mk-${s.mark}` : "", isSelected ? "sel" : "", isTarget ? "target" : "", lit ? "lit" : "",
  ].filter(Boolean).join(" ");
  const autoN = s.checks.filter((c) => c.method !== "human").length;
  const humanN = s.checks.filter((c) => c.method === "human").length;
  return h("div", {
    className: cls,
    "data-step": s.id,
    title: review ? "クリック: 指示の対象に追加 / 解除" : "クリック: 詳細",
    onClick: (e) => { e.stopPropagation(); onClick(s.id); },
    onMouseEnter: () => onHover(s.id),
    onMouseLeave: () => onHover(null),
  },
    h("div", { className: "top" },
      h("span", { className: "id" }, s.id),
      h("span", { className: "k" }, s.kind === "gate" ? (isFinal ? "◆ FINAL GATE" : hum ? "👤 HUMAN GATE" : "◆ GATE") : "WORK"),
      s.mark && h("span", { className: `tag ${s.mark}` }, MARK_LABEL[s.mark]),
      s.irregular && h("span", { className: "tag irregular", title: "AI がこのゲートを変更しました" }, "⚠ 変更済"),
      live ? h("span", { className: "pill" }, pillText(s))
        : review ? h("span", { className: "tg" }, isTarget ? "◉" : "○") : null),
    h("div", { className: "ttl" }, s.title),
    h("div", { className: "bot" },
      h(RoleChip, { config, role: s.role }),
      h("span", null, s.kind === "work" ? `DoD ${s.doneCriteria.length}`
        : hum ? `AUTO ${autoN} · 👤 ${humanN}` : `CHK ${s.checks.length}`),
      live && s.retries > 0 && h("span", { className: "retry", title: "不合格になった回数" }, `↻${s.retries}`)),
    live && s.status === "running" && h("div", { className: "prog indet" }, h("div")));
}

// --------------------------------------------------
// フェーズ帯
// --------------------------------------------------

function PhaseBand({ p, idx, ctx }) {
  const { model, mode, config, levels, targets, selectedId, hover, lit, onPhaseClick, onStepClick, onHover } = ctx;
  const review = mode === "review";
  const g = gateOf(model, p.id);
  const rows = phaseRows(model, p.id, levels);
  const st = mode === "run" ? phaseState(model, p) : null;
  const unplanned = p.planning === "deferred" && rows.length === 0;
  const isT = review && targets.includes(p.id);
  const fx = !!p.fix;
  const ss = stepsOf(model, p.id);
  const doneN = ss.filter((s) => s.status === "done" || s.status === "skipped").length;
  const failedGate = fx ? stepById(model, p.fix.failedGateId) : null;
  const color = p.final ? "var(--accent-yellow)" : fx ? "#ffa657" : PHASE_COLORS[Math.max(0, ctx.mainOrder.indexOf(p.id)) % PHASE_COLORS.length];

  const head = h("div", {
    className: "ph",
    onClick: () => onPhaseClick(p.id),
    title: review ? "クリック: このフェーズを指示の対象に追加 / 解除" : "クリック: 詳細",
  },
    h("span", { className: "pidx" }, idx),
    h("span", { className: "pnm" }, p.name),
    !p.final && !fx && h("span", { className: `pmode ${p.planning}` },
      p.planning === "deferred" ? (rows.length ? "手順: 直前に計画済み" : "手順: 未決定 · 直前に計画") : "手順: 確定"),
    fx && h("span", { className: "pmode fix" }, `${failedGate ? failedGate.title : p.fix.failedGateId} の不合格から追加`),
    g && isHuman(g) && h("span", { className: "phuman" }, fx ? "👤 出口で人間の再レビュー" : "👤 出口で人間レビュー"),
    p.mark && !fx && h("span", { className: `tag ${p.mark}` }, MARK_LABEL[p.mark]),
    h("span", { className: "psp" }),
    st && ss.length > 0 && h("span", { className: "pst" }, `${doneN}/${ss.length}`),
    st && h("span", { className: `pst ${st}` }, PHASE_STATE_LABEL[st]),
    review && h("span", { className: "tg" }, isT ? "◉" : "○"),
    p.goal && h("div", { className: "pgoal" }, p.goal));

  const body = h("div", { className: "pbody" },
    unplanned
      ? h("div", { className: "pdefer", "data-anchor": `defer-${p.id}` },
        h("div", null, h("b", null, "未決定"), " — このフェーズの開始直前に、前フェーズの成果を見て Orchestrator が手順を決めます"),
        p.notes && p.notes.length > 0 && h("ul", null, p.notes.map((x, i) => h("li", { key: i }, x))))
      : rows.map((r, i) => h("div", { className: "prow", key: `r${i}` },
        r.map((s) => h(StepCard, {
          key: s.id, step: s, mode, config, isFinal: false,
          isTarget: review && targets.includes(s.id), isSelected: selectedId === s.id, lit: lit && lit.has(s.id),
          onClick: onStepClick, onHover,
        })))),
    fixesOf(model, p.id).map((f) => h(PhaseBand, { key: f.id, p: f, idx: "↩ 修正フェーズ", ctx })),
    g && h("div", { className: "prow gaterow" },
      h(StepCard, {
        step: g, mode, config, isFinal: !!p.final,
        isTarget: review && targets.includes(g.id), isSelected: selectedId === g.id, lit: lit && lit.has(g.id),
        onClick: onStepClick, onHover,
      })));

  return h("section", {
    className: ["pband", p.final ? "final" : "", fx ? "fixband" : "", p.planning, st || "", isT ? "target" : "", selectedId === p.id ? "psel" : ""].filter(Boolean).join(" "),
    "data-phase": p.id,
    style: { "--lc": color },
  }, head, body);
}

// --------------------------------------------------
// 直交ルーティングの線
// --------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

const EDGE_DEFS = (() => {
  const mk = (id, c) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0.5 L8,4 L0,7.5 z" fill="${c}"/></marker>`;
  return `<defs>${mk("ws-ar-g", "#4d555e")}${mk("ws-ar-ok", "#3fb950")}${mk("ws-ar-b", "#58a6ff")}${mk("ws-ar-p", "#a371f7")}</defs>`;
})();

/** 角丸つきの直交パス */
function orthoPath(pts, rad = 5) {
  const p = [];
  for (const q of pts) {
    const l = p[p.length - 1];
    if (!l || Math.abs(l[0] - q[0]) > 0.5 || Math.abs(l[1] - q[1]) > 0.5) p.push(q);
  }
  for (let i = p.length - 2; i > 0; i--) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    if ((Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5) || (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5)) p.splice(i, 1);
  }
  if (p.length < 2) return "";
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const r = Math.min(rad, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
    const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
    const vx = Math.sign(c[0] - b[0]), vy = Math.sign(c[1] - b[1]);
    d += ` L${(b[0] - ux * r).toFixed(1)},${(b[1] - uy * r).toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${(b[0] + vx * r).toFixed(1)},${(b[1] + vy * r).toFixed(1)}`;
  }
  const e = p[p.length - 1];
  return d + ` L${e[0].toFixed(1)},${e[1].toFixed(1)}`;
}

/** 同じ通路を通る線を、重なる区間だけ別トラックに振り分ける（区間グラフの貪欲彩色） */
function assignTracks(segs) {
  segs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const ends = [];
  for (const s of segs) {
    let t = ends.findIndex((e) => e <= s.lo - 6);
    if (t < 0) { t = ends.length; ends.push(0); }
    ends[t] = s.hi;
    s.t = t;
  }
  return ends.length;
}

/**
 * 依存の線を描く。
 * - 隣の行へ: 行の間の通路で横に曲がる（フェーズ帯をまたぐときは、次の帯の見出しの下で曲がる）
 * - 行を飛ばす: 左の余白（ガター）を下りて、カードの上を通らない
 * - 未決定フェーズは点線の枠を経由する
 */
function drawEdges(board, svg, model, hoverSets) {
  if (!board || !svg) return;
  const br = board.getBoundingClientRect();
  const box = (el) => { const r = el.getBoundingClientRect(); return { x0: r.left - br.left, x1: r.right - br.left, y0: r.top - br.top, y1: r.bottom - br.top }; };
  const rowEls = [...board.querySelectorAll(".prow, .pdefer")];
  const rowBox = rowEls.map(box);
  const rowBand = rowEls.map((el) => el.closest(".pband"));
  const rowOf = Object.create(null);
  rowEls.forEach((el, i) => {
    if (el.classList.contains("pdefer")) rowOf[el.dataset.anchor] = i;
    else el.querySelectorAll(".card[data-step]").forEach((c) => { rowOf[c.dataset.step] = i; });
  });
  const C = Object.create(null);
  board.querySelectorAll(".card[data-step]").forEach((el) => { C[el.dataset.step] = box(el); });
  board.querySelectorAll(".pdefer").forEach((el) => { C[el.dataset.anchor] = box(el); });

  const edges = [];
  for (const s of model.steps) {
    const anchor = `defer-${s.phaseId}`;
    if (s.kind === "gate" && C[anchor]) {
      s.deps.forEach((d) => edges.push({ a: d, b: anchor }));
      edges.push({ a: anchor, b: s.id });
    } else {
      s.deps.forEach((d) => edges.push({ a: d, b: s.id }));
    }
  }
  const E = edges.filter((e) => C[e.a] && C[e.b] && rowOf[e.b] > rowOf[e.a]);
  if (!E.length) { svg.innerHTML = EDGE_DEFS; return; }

  const corr = (i) => i + 1 >= rowBox.length ? rowBox[i].y1 + 14
    : rowBand[i] === rowBand[i + 1] ? (rowBox[i].y1 + rowBox[i + 1].y0) / 2 : rowBox[i + 1].y0 - 11;
  const gutter = Math.min(...Object.values(C).map((c) => c.x0), ...rowBox.map((r) => r.x0)) - 22;
  E.forEach((e) => { e.ra = rowOf[e.a]; e.rb = rowOf[e.b]; e.kind = e.rb === e.ra + 1 ? "direct" : "skip"; });
  const mid = (c) => (c.x0 + c.x1) / 2;
  const outs = Object.create(null), ins = Object.create(null);
  E.forEach((e) => { (outs[e.a] = outs[e.a] || []).push(e); (ins[e.b] = ins[e.b] || []).push(e); });
  const spread = (c, list, tx, key) => {
    list.sort((p, q) => tx(p) - tx(q));
    const n = list.length, w = Math.min(14, (c.x1 - c.x0 - 24) / Math.max(1, n));
    list.forEach((e, i) => { e[key] = mid(c) + (i - (n - 1) / 2) * w; });
  };
  for (const id in outs) spread(C[id], outs[id], (e) => e.kind === "skip" ? gutter : mid(C[e.b]), "xa");
  for (const id in ins) spread(C[id], ins[id], (e) => e.kind === "skip" ? gutter : e.xa, "xb");

  const segs = Object.create(null), gsegs = [];
  const add = (k, lo, hi, e, slot) => (segs[k] = segs[k] || []).push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi), e, slot });
  E.forEach((e) => {
    if (e.kind === "direct") { if (Math.abs(e.xa - e.xb) > 1) add(e.ra, e.xa, e.xb, e, "c"); }
    else { add(e.ra, e.xa, gutter, e, "c1"); add(e.rb - 1, gutter, e.xb, e, "c2"); gsegs.push({ lo: corr(e.ra), hi: corr(e.rb - 1), e, slot: "g" }); }
  });
  const off = (list, e, slot) => {
    if (!list) return 0;
    if (list._n == null) list._n = assignTracks(list);
    const s = list.find((x) => x.e === e && x.slot === slot);
    return s ? (s.t - (list._n - 1) / 2) * 6 : 0;
  };

  const statusOf = Object.create(null);
  model.steps.forEach((s) => { statusOf[s.id] = s.status; });
  const { up, down } = hoverSets;
  const paths = [];
  for (const e of E) {
    const A = C[e.a], B = C[e.b];
    let d;
    if (e.kind === "direct") {
      const y = corr(e.ra) + off(segs[e.ra], e, "c");
      d = orthoPath([[e.xa, A.y1], [e.xa, y], [e.xb, y], [e.xb, B.y0]]);
    } else {
      const y1 = corr(e.ra) + off(segs[e.ra], e, "c1"), y2 = corr(e.rb - 1) + off(segs[e.rb - 1], e, "c2"), gx = gutter + off(gsegs, e, "g");
      d = orthoPath([[e.xa, A.y1], [e.xa, y1], [gx, y1], [gx, y2], [e.xb, y2], [e.xb, B.y0]]);
    }
    const done = statusOf[e.a] === "done" || statusOf[e.a] === "skipped";
    const isUp = up.has(e.a) && up.has(e.b);
    const isDown = !isUp && down.has(e.a) && down.has(e.b);
    const cls = ["edge", done ? "done" : "", done && statusOf[e.b] === "running" ? "act" : "", isUp || isDown ? "lit" : "", isUp ? "up" : "", isDown ? "down" : ""].filter(Boolean).join(" ");
    // step id は外部（Planner / Orchestrator）由来の文字列なので、文字列連結せず DOM API で組み立てる
    // （id は属性にも入れない）
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    paths.push({ lit: isUp || isDown, el: path });
  }
  // 強調する線を最前面に
  paths.sort((a, b) => Number(a.lit) - Number(b.lit));
  svg.innerHTML = EDGE_DEFS; // 定数（ユーザー入力を含まない）
  paths.forEach((p) => svg.appendChild(p.el));
}

/** ホバー中のカードの上流・下流 */
function focusSets(model, id) {
  const up = new Set(), down = new Set();
  if (id && stepById(model, id)) {
    const walkUp = (x) => { if (up.has(x)) return; up.add(x); const s = stepById(model, x); if (s) s.deps.forEach(walkUp); };
    const walkDown = (x) => { if (down.has(x)) return; down.add(x); model.steps.forEach((s) => { if (s.deps.includes(x)) walkDown(s.id); }); };
    walkUp(id);
    walkDown(id);
  }
  return { up, down };
}

// --------------------------------------------------
// ボード本体
// --------------------------------------------------

/**
 * @param {{
 *   model: object, config: object, mode: "review" | "run" | "view",
 *   targets?: string[], selectedId?: string|null,
 *   onToggleTarget?: (id: string) => void, onSelect?: (id: string) => void,
 * }} props
 */
export function PlanBoard({ model, config, mode, targets = [], selectedId = null, onToggleTarget, onSelect }) {
  const boardRef = useRef(null);
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const { levels } = useMemo(() => computeLevels(model), [model]);
  const sets = useMemo(() => focusSets(model, hover || (mode !== "review" ? selectedId : null)), [model, hover, selectedId, mode]);
  const lit = useMemo(() => (sets.up.size > 0 ? new Set([...sets.up, ...sets.down]) : null), [sets]);
  const mainOrder = model.phases.filter((p) => !p.parentPhaseId && !p.final).map((p) => p.id);

  const review = mode === "review";
  const ctx = {
    model, mode, config, levels, targets, selectedId, hover, lit, mainOrder,
    onPhaseClick: (id) => (review && onToggleTarget ? onToggleTarget(id) : onSelect && onSelect(id)),
    onStepClick: (id) => (review && onToggleTarget ? onToggleTarget(id) : onSelect && onSelect(id)),
    onHover: setHover,
  };

  // 線の描き直しは、モデル・強調対象・職種設定が変わったときだけ
  const redrawRef = useRef(() => {});
  redrawRef.current = () => drawEdges(boardRef.current, svgRef.current, model, sets);
  useLayoutEffect(() => {
    redrawRef.current();
  }, [model, sets, config]);

  // リサイズの監視は 1 回だけ登録する（ボードが現れたとき）
  const hasBoard = model.phases.length > 0;
  useLayoutEffect(() => {
    const redraw = () => redrawRef.current();
    window.addEventListener("resize", redraw);
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && boardRef.current) {
      ro = new ResizeObserver(redraw);
      ro.observe(boardRef.current);
    }
    return () => {
      window.removeEventListener("resize", redraw);
      if (ro) ro.disconnect();
    };
  }, [hasBoard]);

  let n = 0;
  const bands = model.phases
    .filter((p) => !p.parentPhaseId)
    .map((p) => h(PhaseBand, { key: p.id, p, idx: p.final ? "FINAL" : `PHASE ${++n}`, ctx }));

  if (bands.length === 0) {
    return h("div", { className: "empty" }, "計画がありません");
  }

  return h("div", { className: `board bd-p${sets.up.size > 0 ? " focus" : ""}`, ref: boardRef },
    h("svg", { ref: svgRef }),
    bands);
}

export function BoardFoot() {
  return h("div", { className: "bfoot" },
    h("span", null, "上から順にフェーズを実行"),
    h("span", null, "横並び = 並列"),
    h("span", { style: { color: "var(--accent-yellow)" } }, "◆ GATE"),
    h("span", { style: { color: "var(--accent-blue)" } }, "👤 人間レビュー"),
    h("span", { style: { color: "var(--accent-purple)" } }, "┆ 未決定 = 直前に計画"),
    h("span", null, h("i", { style: { "--bc": "var(--accent-blue)" } }), "上流"),
    h("span", null, h("i", { style: { "--bc": "var(--accent-purple)" } }), "下流"));
}

export function BoardLegend() {
  const dot = (c) => h("i", { style: { background: c } });
  return h("div", { className: "legend" },
    h("span", null, dot("var(--accent-yellow)"), "ゲート"),
    h("span", null, dot("var(--accent-blue)"), "👤 人間レビュー"),
    h("span", null, dot("var(--accent-green)"), "完了"),
    h("span", null, dot("var(--accent-purple)"), "直前計画 / AI追加"),
    h("span", null, dot("var(--accent-red)"), "差し戻し"));
}
