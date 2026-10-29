// ============================================================
// ReviewDoc → 自己完結 HTML（docs/spec.md §13.6.2 / §13.6.3）
//
// - `renderReviewDoc`: ReviewDoc を外部リソースなしの 1 枚の HTML にする（純粋関数）
// - `loadMermaidRuntime`: 同梱の mermaid ランタイム（dist/mermaid.min.js）を読む
// - `prepareReviewFiles`: kind: "file" の節のファイルを検証して reviews/ 配下へ複製する
// ============================================================

import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Marked } from "marked";
import type { ReviewDoc, ReviewSection } from "../types/index.js";

// --------------------------------------------------
// 定数・命名
// --------------------------------------------------

/** `kind: "html"` の本文の上限（§13.6.2） */
export const REVIEW_HTML_MAX_BYTES = 1024 * 1024;

/** `kind: "file"` の 1 ファイルの上限（§13.6.2） */
export const REVIEW_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** レビュー資料のファイル名（`reviews/` 配下） */
export function reviewFileName(gateId: string, version: number): string {
  return `${gateId}-v${version}.html`;
}

/** `file` 節の複製先ディレクトリ名（`reviews/` 配下） */
export function reviewFilesDirName(gateId: string, version: number): string {
  return `${gateId}-v${version}.files`;
}

// --------------------------------------------------
// エスケープ
// --------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `<script>` 内に埋め込む JS から、HTML パーサーを混乱させる並びを無害化する */
function escapeScriptContent(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

// --------------------------------------------------
// Markdown（生 HTML は無効化する）
// --------------------------------------------------

const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;

/** URL の判定前に、空白・制御文字（`java\tscript:` のような偽装）を取り除く */
function normalizeHref(href: string): string {
  return href.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
}

/**
 * 許可リスト方式。正規化後の href が次のいずれかに合致するときだけ安全とみなす。
 * - `http:` / `https:` / `mailto:`
 * - `#` で始まる / `/`（`//` とバックスラッシュ始まりを除く）/ `./` / `../` で始まる
 * - 最初の `/` `?` `#` より前に `:` を含まない（スキームのない相対パス）
 */
function isSafeHref(href: string): boolean {
  if (href === "") return false;
  if (/^(?:https?:|mailto:)/i.test(href)) return true;
  if (href.startsWith("#")) return true;
  if (href.startsWith("//") || href.startsWith("\\") || href.startsWith("/\\")) return false;
  if (href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return true;
  const cut = href.search(/[/?#]/);
  const head = cut === -1 ? href : href.slice(0, cut);
  return !head.includes(":");
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // 生 HTML（ブロック・インライン）は解釈せずエスケープして文字として見せる
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const safe = normalizeHref(href);
      if (!isSafeHref(safe)) return inner;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr} rel="noopener">${inner}</a>`;
    },
    // 外部リソースは読まない。自己完結の data: 画像だけ許可し、それ以外は代替テキストにする
    image({ href, text }) {
      if (SAFE_IMAGE_DATA_URI.test(href.trim())) {
        return `<img src="${escapeHtml(href.trim())}" alt="${escapeHtml(text)}">`;
      }
      return `<span class="img-omitted">${escapeHtml(text)}</span>`;
    },
  },
});

function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false });
}

// --------------------------------------------------
// 節の描画
// --------------------------------------------------

/** 入れ子の html 節（srcdoc）に前置する CSP。外部リソースの読み込みを禁じる */
const NESTED_HTML_CSP =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** 外側のレビュー資料に前置する CSP（外部リソースを読まない。入れ子の iframe は srcdoc / 同一配信元のファイル） */
const OUTER_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "frame-src 'self' data: about:; base-uri 'none'; form-action 'none'";

function renderTable(table: NonNullable<ReviewSection["table"]>): string {
  const head = table.columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join("");
  const body = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * `file` 節の `src` は `prepareReviewFiles` が書き換えた相対パス（`./...`）に限る。
 * `..`（親ディレクトリ）・`:`（スキーム）・バックスラッシュ・制御文字を含むものは拒否する。
 */
function assertSafeFileSrc(section: ReviewSection): string {
  const src = section.path ?? "";
  const fail = (why: string): never => {
    throw new Error(`節 ${section.id}: file の path が不正です（${why}）: ${src}`);
  };
  if (!src.startsWith("./")) fail("'./' で始まる相対パスのみ指定できます");
  if (src.includes(":")) fail("':' を含められません");
  if (/[\\\u0000-\u001f\u007f-\u009f]/.test(src)) fail("制御文字・バックスラッシュを含められません");
  for (const seg of src.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // デコードできなければそのまま判定する
    }
    if (seg === ".." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      fail("'..' を含められません");
    }
  }
  return src;
}

function renderSectionBody(section: ReviewSection, useMermaid: boolean): string {
  switch (section.kind) {
    case "markdown":
      return `<div class="md">${renderMarkdown(section.body ?? "")}</div>`;
    case "table":
      return `<div class="table-wrap">${renderTable(section.table ?? { columns: [], rows: [] })}</div>`;
    case "mermaid": {
      const source = section.body ?? "";
      if (useMermaid) {
        return `<pre class="mermaid" data-src="${escapeHtml(source)}">${escapeHtml(source)}</pre>`;
      }
      return `<pre class="mermaid-source"><code>${escapeHtml(source)}</code></pre>`;
    }
    case "html": {
      const body = section.body ?? "";
      if (Buffer.byteLength(body, "utf8") > REVIEW_HTML_MAX_BYTES) {
        throw new Error(
          `節 ${section.id}: html の本文が上限（1 MiB）を超えています`,
        );
      }
      const srcdoc = `<meta http-equiv="Content-Security-Policy" content="${NESTED_HTML_CSP}">${body}`;
      return `<iframe sandbox="allow-scripts" srcdoc="${escapeHtml(srcdoc)}" class="frame" title="${escapeHtml(section.heading)}"></iframe>`;
    }
    case "file": {
      const src = assertSafeFileSrc(section);
      return `<iframe sandbox="allow-scripts" src="${escapeHtml(src)}" class="frame" title="${escapeHtml(section.heading)}"></iframe>`;
    }
  }
}

function renderSection(section: ReviewSection, useMermaid: boolean, extraClass?: string): string {
  const cls = extraClass ? ` class="${extraClass}"` : "";
  return [
    `<section data-section-id="${escapeHtml(section.id)}"${cls}>`,
    `<h2>${escapeHtml(section.heading)}</h2>`,
    renderSectionBody(section, useMermaid),
    `<div class="comment-area">`,
    `<button type="button" class="comment-btn" data-action="toggle">コメント</button>`,
    `<span class="comment-status" role="status"></span>`,
    `<div class="comment-form" hidden>`,
    `<textarea rows="4" placeholder="この節へのコメント"></textarea>`,
    `<div class="comment-actions">`,
    `<button type="button" class="comment-send" data-action="send">送信</button>`,
    `<button type="button" class="comment-cancel" data-action="cancel">キャンセル</button>`,
    `</div>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join("\n");
}

// --------------------------------------------------
// テンプレート
// --------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; --fg:#1f2328; --bg:#ffffff; --muted:#656d76; --line:#d0d7de; --accent:#0969da; --soft:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#8b949e; --line:#30363d; --accent:#4493f8; --soft:#161b22; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg);
  font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans CJK JP", "Noto Sans JP", Meiryo, sans-serif; }
main, header { max-width: 920px; margin: 0 auto; }
header { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
h1 { font-size: 22px; margin: 0; }
.version { font-size: 13px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 10px; }
section { padding: 16px 0 12px; border-bottom: 1px solid var(--line); }
section.previous-feedback { background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0 0; }
h2 { font-size: 17px; margin: 0 0 8px; }
.md > :first-child { margin-top: 0; }
.md pre, pre.mermaid-source { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow: auto; }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.md :not(pre) > code { background: var(--soft); border-radius: 4px; padding: 1px 5px; }
.md table, .table-wrap table { border-collapse: collapse; width: 100%; }
.md th, .md td, .table-wrap th, .table-wrap td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
.md th, .table-wrap th { background: var(--soft); }
.table-wrap { overflow-x: auto; }
a { color: var(--accent); }
pre.mermaid { background: transparent; text-align: center; overflow: auto; }
.frame { width: 100%; height: 480px; border: 1px solid var(--line); border-radius: 6px; background: #fff; resize: vertical; }
.comment-area { margin-top: 10px; }
.comment-btn, .comment-send, .comment-cancel { font: inherit; font-size: 13px; padding: 3px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--fg); cursor: pointer; }
.comment-send { background: var(--accent); border-color: var(--accent); color: #fff; }
.comment-status { margin-left: 10px; font-size: 13px; color: var(--muted); }
.comment-form { margin-top: 8px; }
.comment-form[hidden] { display: none; }
.comment-form textarea { width: 100%; font: inherit; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
.comment-actions { display: flex; gap: 8px; margin-top: 6px; }
`;

/** コメント UI（iframe の sandbox では prompt() が使えないため、節内のテキストエリアで入力する） */
const COMMENT_SCRIPT = `
(function () {
  var counts = {};
  document.addEventListener("click", function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    var btn = target.closest("[data-action]");
    if (!btn) return;
    var sec = btn.closest("section[data-section-id]");
    if (!sec) return;
    var form = sec.querySelector(".comment-form");
    var ta = form.querySelector("textarea");
    var status = sec.querySelector(".comment-status");
    var action = btn.getAttribute("data-action");
    var sectionId = sec.getAttribute("data-section-id");
    if (action === "toggle") {
      form.hidden = !form.hidden;
      if (!form.hidden) ta.focus();
    } else if (action === "cancel") {
      form.hidden = true;
    } else if (action === "send") {
      var text = ta.value.trim();
      if (!text) return;
      window.parent.postMessage({ type: "review:comment", sectionId: sectionId, text: text }, "*");
      counts[sectionId] = (counts[sectionId] || 0) + 1;
      ta.value = "";
      form.hidden = true;
      status.textContent = "コメントを送信しました（" + counts[sectionId] + " 件）";
    }
  });
})();
`;

/**
 * mermaid の初期化。描画に失敗した図は本文をコードブロックで表示する。
 *
 * `mermaid.run` は最初のエラーで中断するため、失敗した図を差し替えたあと、
 * 未処理の図に対して `run` をやり直す。
 */
const MERMAID_INIT_SCRIPT = `
(function () {
  function fallback(el) {
    var pre = document.createElement("pre");
    pre.className = "mermaid-source";
    var code = document.createElement("code");
    code.textContent = el.getAttribute("data-src") || "";
    pre.appendChild(code);
    el.parentNode.replaceChild(pre, el);
  }
  function failed(el) {
    if (!el.getAttribute("data-processed")) return false;
    var svg = el.querySelector("svg");
    return !svg || svg.getAttribute("aria-roledescription") === "error" || !!svg.querySelector(".error-icon");
  }
  if (typeof mermaid === "undefined") {
    Array.prototype.slice.call(document.querySelectorAll(".mermaid")).forEach(fallback);
    return;
  }
  var retries = 0;
  mermaid.initialize({ startOnLoad: true, securityLevel: "strict" });
  mermaid.parseError = function () {
    setTimeout(function () {
      Array.prototype.slice.call(document.querySelectorAll(".mermaid")).forEach(function (el) {
        if (failed(el)) fallback(el);
      });
      var rest = Array.prototype.slice.call(document.querySelectorAll(".mermaid:not([data-processed])"));
      if (rest.length > 0 && retries++ < 100) {
        var p = mermaid.run({ nodes: rest });
        if (p && p.catch) p.catch(function () {});
      }
    }, 0);
  };
})();
`;

export interface RenderReviewDocOptions {
  /** mermaid のランタイム（JS のソース）。無ければ mermaid 節は常にコードブロック表示 */
  mermaidRuntime?: string;
}

/** ReviewDoc を自己完結の HTML にする。`html` 節の本文が 1 MiB を超えると Error */
export function renderReviewDoc(doc: ReviewDoc, opts: RenderReviewDocOptions = {}): string {
  if (!Number.isInteger(doc.version)) {
    throw new Error(`ReviewDoc の version が整数ではありません: ${String(doc.version)}`);
  }
  const version = escapeHtml(String(doc.version));
  const all = doc.previousFeedback ? [doc.previousFeedback, ...doc.sections] : doc.sections;
  const hasMermaid = all.some((s) => s.kind === "mermaid");
  const useMermaid = hasMermaid && typeof opts.mermaidRuntime === "string" && opts.mermaidRuntime !== "";

  const sections: string[] = [];
  if (doc.previousFeedback) {
    sections.push(renderSection(doc.previousFeedback, useMermaid, "previous-feedback"));
  }
  for (const s of doc.sections) sections.push(renderSection(s, useMermaid));

  const scripts: string[] = [];
  if (useMermaid) {
    scripts.push(`<script>${escapeScriptContent(opts.mermaidRuntime ?? "")}</script>`);
    scripts.push(`<script>${escapeScriptContent(MERMAID_INIT_SCRIPT)}</script>`);
  }
  scripts.push(`<script>${escapeScriptContent(COMMENT_SCRIPT)}</script>`);

  return [
    "<!doctype html>",
    `<html lang="ja">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(OUTER_CSP)}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(doc.title)}（v${version}）</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<header><h1>${escapeHtml(doc.title)}</h1><span class="version">v${version}</span></header>`,
    "<main>",
    sections.join("\n"),
    "</main>",
    scripts.join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// --------------------------------------------------
// mermaid ランタイム
// --------------------------------------------------

/** 同梱の mermaid ランタイム（`mermaid/dist/mermaid.min.js`）を読む。見つからなければ undefined */
export function loadMermaidRuntime(): string | undefined {
  if (mermaidRuntimeCache !== undefined) return mermaidRuntimeCache;
  try {
    const require = createRequire(import.meta.url);
    mermaidRuntimeCache = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");
    return mermaidRuntimeCache;
  } catch {
    return undefined;
  }
}

/** 読み込み済みのランタイム（5 MB 超あるため、読み込みは 1 回だけにする。見つからなかった場合は毎回探す） */
let mermaidRuntimeCache: string | undefined;

// --------------------------------------------------
// file 節の検証と複製
// --------------------------------------------------

export interface PrepareReviewFilesOptions {
  /** 作業ディレクトリ（file 節の path はこの中に限る） */
  workspacePath: string;
  /** 複製先（`reviews/<gateId>-v<n>.files` の絶対パス） */
  outDir: string;
  /** HTML から見た複製先の相対パス（例: `./gate-P1-v1.files`） */
  publicBase: string;
}

interface FilePlan {
  realPath: string;
  name: string;
}

/**
 * `kind: "file"` の節のファイルを検証して `outDir` に複製し、`path` を公開用の相対パスに書き換えた
 * ReviewDoc を返す（入力は変更しない）。
 *
 * - path は作業ディレクトリ内（シンボリックリンクを解決した実パス）の通常ファイルに限る
 * - 1 ファイル 5 MiB まで
 * - 同名ファイルは `name-2.ext` のように連番にする。同じ実ファイルは 1 回だけ複製する
 * - 検証がすべて通ってから複製する（失敗時に中途半端な複製を残さない）
 */
export function prepareReviewFiles(doc: ReviewDoc, opts: PrepareReviewFilesOptions): ReviewDoc {
  const result: ReviewDoc = structuredClone(doc);
  const targets: ReviewSection[] = [];
  if (result.previousFeedback?.kind === "file") targets.push(result.previousFeedback);
  for (const s of result.sections) if (s.kind === "file") targets.push(s);
  if (targets.length === 0) return result;

  const realWorkspace = realpathSync(opts.workspacePath);
  const byRealPath = new Map<string, FilePlan>();
  const usedNames = new Set<string>();
  const assigned: { section: ReviewSection; plan: FilePlan }[] = [];

  for (const section of targets) {
    if (!section.path) {
      throw new Error(`節 ${section.id}: file の path がありません`);
    }
    const candidate = resolve(realWorkspace, section.path);
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new Error(`節 ${section.id}: ファイルが見つかりません: ${section.path}`);
    }
    const rel = relative(realWorkspace, real);
    if (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel)) {
      throw new Error(
        `節 ${section.id}: ワークスペース外のパスは指定できません: ${section.path}`,
      );
    }
    const st = statSync(real);
    if (!st.isFile()) {
      throw new Error(`節 ${section.id}: ファイルではありません: ${section.path}`);
    }
    if (st.size > REVIEW_FILE_MAX_BYTES) {
      throw new Error(
        `節 ${section.id}: ファイルが上限（5 MiB）を超えています: ${section.path}`,
      );
    }

    let plan = byRealPath.get(real);
    if (!plan) {
      const { name: stem, ext } = parse(basename(real));
      let name = `${stem}${ext}`;
      for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
      usedNames.add(name.toLowerCase());
      plan = { realPath: real, name };
      byRealPath.set(real, plan);
    }
    assigned.push({ section, plan });
  }

  mkdirSync(opts.outDir, { recursive: true });
  const base = opts.publicBase.replace(/\/+$/, "");
  for (const plan of byRealPath.values()) {
    copyFileSync(plan.realPath, join(opts.outDir, plan.name));
  }
  for (const { section, plan } of assigned) {
    section.path = `${base}/${encodeURIComponent(plan.name)}`;
  }
  return result;
}
