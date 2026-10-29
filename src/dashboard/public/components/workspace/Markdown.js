// ============================================================
// Markdown — 最小限の Markdown 表示（React 要素のみ。生 HTML は出さない）
// ============================================================
// 完了レポートの summary / howToTry / notes（Orchestrator の最終報告 = Markdown）用。
// 対応: 見出し / 箇条書き / 番号付き / コードブロック / インラインコード / 太字 / http(s) リンク。

import { createElement as h } from "react";

function inline(text, keyPrefix) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyPrefix}-${i++}`;
    if (m[1]) out.push(h("code", { key: k, className: "md-code" }, m[1].slice(1, -1)));
    else if (m[2]) out.push(h("b", { key: k }, m[2].slice(2, -2)));
    else out.push(h("a", { key: k, href: m[4], target: "_blank", rel: "noopener noreferrer" }, m[3].slice(1, m[3].indexOf("]"))));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return null;
  const lines = src.split("\n");
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(h("pre", { key: key++, className: "tryit" }, buf.join("\n")));
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) {
      blocks.push(h("div", { key: key++, className: "md-h" }, inline(hm[2], `h${key}`)));
      i++;
      continue;
    }
    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*([-*])\s+/.test(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(h(ordered ? "ol" : "ul", { key: key++, className: "md-list" }, items.map((t, k) => h("li", { key: k }, inline(t, `l${key}-${k}`)))));
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(h("p", { key: key++, className: "md-p" }, inline(buf.join(" "), `p${key}`)));
  }
  return h("div", { className: "md" }, blocks);
}
