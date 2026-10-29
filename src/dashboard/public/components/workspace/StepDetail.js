// ============================================================
// StepDetail — 選択中のフェーズ / 手順 / ゲートの詳細（読み取り専用）
// ============================================================
// 人が最初に知りたいこと（何をする / 何をチェックする / 終わりの条件）を上に出し、
// ID・モデル・コマンド・依存などの AI 向けの情報は「詳細」の折りたたみに入れる。

import { createElement as h } from "react";
import { RoleChip } from "./PlanBoard.js";
import {
  stepById, phaseById, workOf, gateOf, isHuman, roleInfo, checkResultOf, latestAttempt,
  MARK_LABEL, METHOD_LABEL, METHOD_ICON, truncate,
} from "./plan-utils.js";

const STATUS_TEXT = {
  pending: "待機中",
  running: "実行中",
  done: "完了",
  skipped: "スキップ",
  waiting: "人間レビュー待ち",
};

function dHead(kind, label, mark, onClose) {
  return h("div", { className: "dh" },
    h("span", { className: `dk ${kind}` }, label),
    mark,
    onClose && h("button", { className: "x", onClick: onClose, title: "閉じる" }, "×"));
}

function dSec(label, ...kids) {
  return h("div", { className: "ds" }, h("div", { className: "dl" }, label), ...kids);
}

function dMore(rows) {
  return h("details", { className: "dmore" },
    h("summary", null, "詳細（AI 向けの情報）"),
    h("dl", { className: "kv2" },
      rows.filter(Boolean).map(([k, v]) => [h("dt", { key: `t${k}` }, k), h("dd", { key: `d${k}`, className: "mono" }, v)])));
}

/** ゲートのチェック一覧。gateResult があれば各チェックの結果（✔ / ✖）を重ねる */
export function CheckList({ checks, gateResult, humanReview }) {
  return h("ul", { className: "dchk" }, checks.map((c, i) => {
    let ic = METHOD_ICON[c.method] || "·";
    let tone = "";
    let note = null;
    if (gateResult) {
      if (c.method === "human") {
        if (humanReview) {
          if (humanReview.status === "approved") { ic = "✔"; tone = "pass"; }
          else if (humanReview.status === "changes_requested") { ic = "✖"; tone = "fail"; }
          else { ic = "◔"; tone = "run"; }
        }
      } else {
        const r = checkResultOf(gateResult, i);
        if (r) {
          ic = r.passed ? "✔" : "✖";
          tone = r.passed ? "pass" : "fail";
          if (r.note) note = r.note;
          else if (c.method === "command" && !r.passed && r.exitCode != null) note = `exit ${r.exitCode}${r.timedOut ? "（タイムアウト）" : ""}`;
        }
      }
    }
    return h("li", { key: i, className: `${c.method} ${tone}` },
      h("span", { className: "ic", title: c.method }, ic),
      h("span", { className: "tx" }, c.text, note && h("span", { className: "cnote" }, note)),
      h("span", { className: "who" }, METHOD_LABEL[c.method] || c.method));
  }));
}

export function PhaseDetail({ model, phase: p, onSelect, onClose }) {
  const g = gateOf(model, p.id);
  const ws = workOf(model, p.id);
  const mains = model.phases.filter((x) => !x.final && !x.parentPhaseId);
  const i = mains.findIndex((x) => x.id === p.id);
  return [
    h("div", { key: "head" }, dHead("phase", p.final ? "完了確認" : p.fix ? "修正フェーズ" : `フェーズ ${i + 1}`,
      p.mark && h("span", { className: `tag ${p.mark}` }, MARK_LABEL[p.mark]), onClose)),
    h("div", { key: "t", className: "dt" }, p.name),
    p.goal && h("div", { key: "g", className: "dwhat" }, p.goal),
    !p.final && h("div", { key: "s" }, dSec("やる手順", p.planning === "deferred" && ws.length === 0
      ? h("div", { className: "ddefer" }, "まだ決めていません。前のフェーズが終わった直後に、その成果を見て AI が決めます。",
        p.notes && p.notes.length ? h("ul", null, p.notes.map((x, k) => h("li", { key: k }, x))) : null)
      : h("ol", { className: "dsteps" }, ws.map((w) => h("li", { key: w.id, onClick: () => onSelect && onSelect(w.id) },
        w.title, w.mark ? h("span", { className: `tag ${w.mark}` }, MARK_LABEL[w.mark]) : null))))),
    g && h("div", { key: "c" }, dSec(p.final ? "最後にチェックすること" : "終わりにチェックすること",
      h(CheckList, { checks: g.checks, gateResult: g.gateResult }),
      isHuman(g) && h("div", { className: "dflow human" }, "👤 AI のチェックが通ると実行が止まります。あなたが承認すると次のフェーズへ進みます。"))),
    h("div", { key: "m" }, dMore([
      ["id", p.id],
      ["手順の決め方", p.planning === "deferred" ? "deferred（開始直前に Orchestrator が計画）" : "fixed（計画時に確定）"],
      g && ["出口ゲート", `${g.id} ${g.title}`],
    ])),
  ];
}

export function StepDetail({ model, step: s, config, workspace, onSelect, onClose }) {
  const p = phaseById(model, s.phaseId);
  const fin = !!(p && p.final);
  const hum = isHuman(s);
  const role = roleInfo(config, s.role);
  const eff = s.deps.map((d) => stepById(model, d)).filter(Boolean);
  const mark = [
    s.mark && h("span", { key: "mk", className: `tag ${s.mark}` }, MARK_LABEL[s.mark]),
    s.irregular && h("span", { key: "ir", className: "tag irregular" }, "⚠ AI が変更"),
  ];
  const more = dMore([
    ["id", s.id],
    ["フェーズ", p ? `${p.id} ${p.name}` : "—"],
    ["職種", `${s.role}${role.model ? `（${role.model}）` : ""}`],
    s.kind === "work" && ["scope", s.scope || "—"],
    s.kind === "gate" && ["commands", s.checks.filter((c) => c.command).map((c) => `$ ${c.command}`).join("\n") || "—"],
    [s.kind === "gate" ? "開始条件" : "依存", eff.length ? eff.map((d) => `${d.id} ${d.title}`).join("\n") : "なし（最初に着手）"],
    s.kind === "gate" && ["不合格時", hum
      ? "差し戻されると、指摘を反映する手順を追加して再レビュー"
      : `原因を切り分けたうえで直し、同じ条件で再チェック（最大 ${s.onFail ? s.onFail.maxRetries : 2} 回）。超過すると人の判断待ち`],
  ]);

  // 実行中の状態
  let live = null;
  if (s.status) {
    const gr = s.gateResult;
    const att = latestAttempt(gr);
    const fails = att ? att.checks.filter((c) => !c.passed) : [];
    live = h("div", { className: `dlive ${s.status}` },
      h("b", null, s.gateFailed ? "不合格（修正待ち）" : STATUS_TEXT[s.status] || s.status),
      s.retries > 0 ? `不合格 ${s.retries} 回` : null,
      fails.map((c, i) => h("div", { key: i, className: "fail" }, `不合格: ${s.checks[c.checkIndex] ? s.checks[c.checkIndex].text : `チェック ${c.checkIndex}`}${c.note ? ` — ${truncate(c.note, 120)}` : ""}`)));
  }
  const hr = workspace ? [...(workspace.humanReviews || [])].reverse().find((r) => r.gateId === s.id) : null;
  const change = workspace ? (workspace.gateChanges || []).find((c) => c.gateId === s.id) : null;

  if (s.kind === "gate") {
    return [
      live && h("div", { key: "live" }, live),
      h("div", { key: "h" }, dHead(hum ? "human" : "gate", fin ? "最終チェック" : hum ? "👤 人間レビュー" : "自動チェック", mark, onClose)),
      h("div", { key: "t", className: "dt" }, s.title),
      s.description && h("div", { key: "d", className: "dwhat" }, s.description),
      h("div", { key: "c" }, dSec("チェックすること", s.checks.length
        ? h(CheckList, { checks: s.checks, gateResult: s.gateResult, humanReview: hr })
        : h("div", { className: "hint" }, "まだありません"))),
      h("div", { key: "f", className: `dflow${hum ? " human" : ""}` }, hum
        ? "👤 AI のチェックが通ると実行が止まります。あなたが承認すると次へ進み、差し戻すと AI が直して再レビューします。"
        : "不合格なら、AI が原因を切り分けて直し、再チェックします。"),
      change && h("div", { key: "ch", className: "dflow irr" }, `⚠ このゲートは実行中に AI が変更しました（${truncate(change.reason, 140)}）`),
      h("div", { key: "meta", className: "dmeta" }, p && h("span", null, `${p.name} の出口`), h("span", null, "担当 ", h(RoleChip, { config, role: s.role }))),
      h("div", { key: "more" }, more),
    ];
  }
  return [
    live && h("div", { key: "live" }, live),
    h("div", { key: "h" }, dHead("work", "作業", mark, onClose)),
    h("div", { key: "t", className: "dt" }, s.title),
    h("div", { key: "w" }, dSec("やること", h("div", { className: "dwhat" }, s.description || "—"))),
    h("div", { key: "dod" }, dSec("終わったと言える条件", s.doneCriteria.length
      ? h("ul", { className: "ddod" }, s.doneCriteria.map((x, i) => h("li", { key: i }, x)))
      : h("div", { className: "hint" }, "まだありません"))),
    h("div", { key: "meta", className: "dmeta" }, h("span", null, "担当 ", h(RoleChip, { config, role: s.role })), p && h("span", null, p.name)),
    h("div", { key: "more" }, more),
  ];
}

/** id（フェーズ / 手順 / ゲート）の詳細。見つからなければ null */
export function DetailFor({ model, id, config, workspace, onSelect, onClose }) {
  const s = id && stepById(model, id);
  if (s) return h(StepDetail, { model, step: s, config, workspace, onSelect, onClose });
  const p = id && phaseById(model, id);
  if (p) return h(PhaseDetail, { model, phase: p, onSelect, onClose });
  return null;
}
