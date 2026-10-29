import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMermaidRuntime,
  prepareReviewFiles,
  renderReviewDoc,
  reviewFileName,
  reviewFilesDirName,
} from "../../src/workspace/review-doc.js";
import type { ReviewDoc, ReviewSection } from "../../src/types/index.js";

function doc(sections: ReviewSection[], extra: Partial<ReviewDoc> = {}): ReviewDoc {
  return { title: "認証方式のレビュー", version: 1, sections, ...extra };
}

function md(id: string, body: string, heading = id): ReviewSection {
  return { id, heading, kind: "markdown", body };
}

describe("reviewFileName / reviewFilesDirName", () => {
  it("版ごとのファイル名とディレクトリ名", () => {
    expect(reviewFileName("gate-P1", 2)).toBe("gate-P1-v2.html");
    expect(reviewFilesDirName("gate-P1", 2)).toBe("gate-P1-v2.files");
  });
});

describe("renderReviewDoc: 全体", () => {
  it("自己完結の HTML（外部リソースなし）で title と版を出す", () => {
    const html = renderReviewDoc(doc([md("conclusion", "**決定**")], { version: 3, previousFeedback: md("prev", "対応済み", "前回の指摘への対応") }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<title>認証方式のレビュー");
    expect(html).toContain("v3");
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/<(?:link|img|iframe)[^>]+src=["']https?:/i);
  });

  it("タイトルをエスケープする", () => {
    const html = renderReviewDoc({ ...doc([md("a", "x")]), title: `<img src=x onerror=alert(1)>` });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("節ごとに section[data-section-id] と見出しとコメントボタンを持つ", () => {
    const html = renderReviewDoc(doc([md("conclusion", "本文", "結論"), md("spec", "表", "仕様")]));
    expect(html).toContain(`<section data-section-id="conclusion"`);
    expect(html).toContain(`<section data-section-id="spec"`);
    expect(html).toContain("結論");
    const buttons = html.match(/class="comment-btn"/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html).toContain("コメント");
    expect(html).toContain("送信");
    expect(html).toContain("<textarea");
  });

  it("コメント送信で親へ postMessage する（prompt は使わない）", () => {
    const html = renderReviewDoc(doc([md("a", "x")]));
    expect(html).toContain("window.parent.postMessage");
    expect(html).toContain("review:comment");
    expect(html).toContain("sectionId");
    expect(html).not.toContain("prompt(");
  });

  it("previousFeedback は最初の節として出す", () => {
    const html = renderReviewDoc(
      doc([md("conclusion", "本文")], {
        version: 2,
        previousFeedback: md("previous-feedback", "指摘に対応しました", "前回の指摘への対応"),
      }),
    );
    const iPrev = html.indexOf(`data-section-id="previous-feedback"`);
    const iFirst = html.indexOf(`data-section-id="conclusion"`);
    expect(iPrev).toBeGreaterThan(-1);
    expect(iPrev).toBeLessThan(iFirst);
    expect(html).toContain("前回の指摘への対応");
  });

  it("節 ID と見出しをエスケープする", () => {
    const html = renderReviewDoc(doc([{ id: `a"><script>x</script>`, heading: "<b>見出し</b>", kind: "markdown", body: "x" }]));
    expect(html).not.toContain(`"><script>x</script>`);
    expect(html).toContain("&lt;b&gt;見出し&lt;/b&gt;");
  });

  it("コメント用スクリプトが唯一のインライン script（mermaid なし）で、</script を含む文字列を持たない", () => {
    const html = renderReviewDoc(doc([md("a", "```\n</script><script>alert(1)</script>\n```")]));
    const scripts = html.match(/<script[\s>]/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(html).toContain("&lt;/script&gt;");
  });
});

describe("renderReviewDoc: markdown", () => {
  it("Markdown を HTML に変換する", () => {
    const html = renderReviewDoc(doc([md("a", "# 見出し\n\n- 項目1\n- 項目2\n\n**太字** と `code`")]));
    expect(html).toContain("<li>項目1</li>");
    expect(html).toContain("<strong>太字</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("GFM の表を変換する", () => {
    const html = renderReviewDoc(doc([md("a", "| a | b |\n|---|---|\n| 1 | 2 |")]));
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("生 HTML はエスケープされる（ブロック・インライン）", () => {
    const html = renderReviewDoc(
      doc([md("a", `<script>alert(1)</script>\n\nテキスト <img src=x onerror=alert(2)> と <b>bold</b>\n\n<div onclick="x()">d</div>`)]),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<div onclick");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("リンクは rel=noopener を付け、javascript: は無効化する", () => {
    const html = renderReviewDoc(doc([md("a", "[docs](https://example.com/x) と [bad](javascript:alert(1))")]));
    expect(html).toContain(`<a href="https://example.com/x" rel="noopener">docs</a>`);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain("bad");
  });

  it("href の空白・制御文字による偽装（java<TAB>script: など）を無効化する", () => {
    const cases = [
      "[x](<java\tscript:alert(1)>)",
      "[x](<java\nscript:alert(1)>)",
      "[x](<\u0001javascript:alert(1)>)",
      "[x](<  javascript:alert(1)>)",
      "[x](<JaVaScRiPt:alert(1)>)",
      "[x](<vbscript:msgbox(1)>)",
      "[x](<data:text/html;base64,PHNjcmlwdD4=>)",
      "[x](<file:///etc/passwd>)",
      "[x](//evil.example.com/a)",
      "[x](/\\evil.example.com/a)",
      "[x][r]\n\n[r]: javascript:alert(1)",
      "[x][r]\n\n[r]: <java\tscript:alert(1)>",
      "<javascript:alert(1)>",
    ];
    for (const src of cases) {
      const html = renderReviewDoc(doc([md("a", src)]));
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs, src).toEqual([]);
      expect(html, src).not.toMatch(/href="[^"]*script:/i);
    }
  });

  it("許可する href（http/https/mailto、フラグメント、相対パス）は正規化後の値で出力する", () => {
    const cases: [string, string][] = [
      ["[x](https://example.com/a?b=1#c)", "https://example.com/a?b=1#c"],
      ["[x](HTTP://example.com)", "HTTP://example.com"],
      ["[x](mailto:a@example.com)", "mailto:a@example.com"],
      ["[x](#sec)", "#sec"],
      ["[x](/abs/path)", "/abs/path"],
      ["[x](./rel/a.html)", "./rel/a.html"],
      ["[x](../up.html)", "../up.html"],
      ["[x](docs/a.html)", "docs/a.html"],
      ["[x](a.html?x=http://y)", "a.html?x=http://y"],
      ["[x][r]\n\n[r]: https://example.com/ref", "https://example.com/ref"],
      ["[x](<https://exa\tmple.com/>)", "https://example.com/"],
    ];
    for (const [src, expected] of cases) {
      const html = renderReviewDoc(doc([md("a", src)]));
      expect(html, src).toContain(`<a href="${expected}" rel="noopener">`);
    }
  });

  it("外部画像は読み込まない（代替テキストのみ）", () => {
    const html = renderReviewDoc(doc([md("a", "![図](https://example.com/a.png)")]));
    expect(html).not.toContain("<img");
    expect(html).toContain("図");
  });
});

describe("renderReviewDoc: table", () => {
  it("列・セルをすべてエスケープする", () => {
    const html = renderReviewDoc(
      doc([
        {
          id: "spec",
          heading: "仕様",
          kind: "table",
          table: { columns: ["名前<x>", "値&"], rows: [[`<script>alert(1)</script>`, `"q"`], ["b"]] },
        },
      ]),
    );
    expect(html).toContain("<th>名前&lt;x&gt;</th>");
    expect(html).toContain("<th>値&amp;</th>");
    expect(html).toContain("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
    expect(html).toContain("<td>&quot;q&quot;</td>");
    expect(html).not.toMatch(/<script>alert/);
  });
});

describe("renderReviewDoc: 型の揺れ", () => {
  it("表のセルが文字列でなくても出力できる", () => {
    const html = renderReviewDoc(
      doc([{ id: "t", heading: "t", kind: "table", table: { columns: [1 as unknown as string], rows: [[2 as unknown as string, null as unknown as string]] } }]),
    );
    expect(html).toContain("<th>1</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("<td>null</td>");
  });

  it("version が整数でなければ Error", () => {
    for (const v of [1.5, NaN, "1<script>" as unknown as number, undefined as unknown as number]) {
      expect(() => renderReviewDoc({ ...doc([md("a", "x")]), version: v })).toThrow(/version/);
    }
  });
});

describe("renderReviewDoc: CSP", () => {
  it("外側の HTML に CSP を前置する（外部リソース不可・base/form 禁止）", () => {
    const html = renderReviewDoc(doc([md("a", "x")]));
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)?.[1] ?? "";
    expect(meta).toContain("default-src &#39;none&#39;");
    expect(meta).toContain("frame-src &#39;self&#39; data: about:");
    expect(meta).toContain("base-uri &#39;none&#39;");
    expect(meta).toContain("form-action &#39;none&#39;");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<style>"));
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
  });

  it("入れ子の html の CSP にも base-uri / form-action を入れる", () => {
    const html = renderReviewDoc(doc([{ id: "m", heading: "m", kind: "html", body: "<p>x</p>" }]));
    const srcdoc = html.match(/srcdoc="([^"]*)"/)?.[1] ?? "";
    expect(srcdoc).toContain("base-uri &#39;none&#39;");
    expect(srcdoc).toContain("form-action &#39;none&#39;");
  });
});

describe("loadMermaidRuntime", () => {
  it("読み込んだランタイムをキャッシュする", () => {
    const first = loadMermaidRuntime();
    expect(typeof first).toBe("string");
    expect((first ?? "").length).toBeGreaterThan(100_000);
    const t = Date.now();
    expect(loadMermaidRuntime()).toBe(first);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe("renderReviewDoc: mermaid", () => {
  const section: ReviewSection = { id: "structure", heading: "構成", kind: "mermaid", body: "graph TD\n  A[<b>x</b>] --> B" };

  it("mermaidRuntime が無ければコードブロック表示", () => {
    const html = renderReviewDoc(doc([section]));
    expect(html).not.toContain(`class="mermaid"`);
    expect(html).not.toContain("mermaid.initialize");
    expect(html).toContain(`<pre class="mermaid-source"><code>graph TD`);
    expect(html).toContain("A[&lt;b&gt;x&lt;/b&gt;]");
  });

  it("mermaidRuntime があればインライン埋め込みし initialize する", () => {
    const html = renderReviewDoc(doc([section]), { mermaidRuntime: "window.mermaid={initialize(){},run(){}};" });
    expect(html).toContain("window.mermaid={initialize(){},run(){}};");
    expect(html).toContain(`startOnLoad: true`);
    expect(html).toContain(`securityLevel: "strict"`);
    expect(html).toContain("mermaid.parseError");
    expect(html).toContain(`<pre class="mermaid"`);
    expect(html).toContain("A[&lt;b&gt;x&lt;/b&gt;]");
    expect(html).not.toContain("A[<b>x</b>]");
  });

  it("mermaid 節が無ければ runtime は埋め込まない", () => {
    const html = renderReviewDoc(doc([md("a", "x")]), { mermaidRuntime: "window.mermaid={};/*RUNTIME*/" });
    expect(html).not.toContain("RUNTIME");
  });

  it("runtime 内の </script を壊さずにエスケープする", () => {
    const html = renderReviewDoc(doc([section]), { mermaidRuntime: `var s="</script><script>alert(1)</script>";` });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("<\\/script");
  });
});

describe("renderReviewDoc: html", () => {
  it("入れ子の sandbox=allow-scripts iframe に srcdoc（エスケープ済み）で描画する", () => {
    const html = renderReviewDoc(
      doc([{ id: "mock", heading: "モック", kind: "html", body: `<h1 class="x">Hi & "bye"</h1><script>alert(1)</script>` }]),
    );
    expect(html).toContain(`<iframe sandbox="allow-scripts"`);
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("srcdoc=");
    expect(html).toContain("&lt;h1 class=&quot;x&quot;&gt;Hi &amp; &quot;bye&quot;&lt;/h1&gt;");
    expect(html).not.toContain(`<script>alert(1)</script>`);
  });

  it("srcdoc に外部リソースを禁じる CSP を前置する", () => {
    const html = renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "html", body: "<p>x</p>" }]));
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src &#39;none&#39;");
  });

  it("本文が 1 MiB を超えると Error", () => {
    const big = "a".repeat(1024 * 1024 + 1);
    expect(() => renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "html", body: big }]))).toThrow(/1 MiB/);
  });

  it("ちょうど 1 MiB は許容", () => {
    const ok = "a".repeat(1024 * 1024);
    expect(() => renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "html", body: ok }]))).not.toThrow();
  });
});

describe("renderReviewDoc: file", () => {
  it("受け取った path をそのまま iframe の src にする（sandbox=allow-scripts）", () => {
    const html = renderReviewDoc(
      doc([{ id: "mock", heading: "モック", kind: "file", path: "./gate-P1-v1.files/workspace.html" }]),
    );
    expect(html).toContain(`<iframe sandbox="allow-scripts" src="./gate-P1-v1.files/workspace.html"`);
    expect(html).not.toContain("allow-same-origin");
  });

  it("'./' で始まらない path は拒否する", () => {
    for (const path of ["gate.files/a.html", "/etc/passwd", "../a.html", "https://example.com/a.html", "javascript:alert(1)", ""]) {
      expect(() => renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "file", path }])), path).toThrow(/path が不正/);
    }
  });

  it("'..' と ':' を含む path は拒否する", () => {
    for (const path of ["./../a.html", "./a/../../b.html", "./a/%2e%2e/b.html", "./a:b.html", "./data:text/html,x", "./a\\b.html", "./a\u0001b.html"]) {
      expect(() => renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "file", path }])), path).toThrow(/path が不正/);
    }
  });

  it("名前の一部に '.' が連続していても '..' のセグメントでなければ許容する", () => {
    expect(() => renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "file", path: "./f.files/v1..2.html" }]))).not.toThrow();
  });

  it("src の特殊文字（エンコード済み）はエスケープして出力する", () => {
    const html = renderReviewDoc(doc([{ id: "mock", heading: "m", kind: "file", path: "./f.files/a%22b&c.html" }]));
    expect(html).toContain(`src="./f.files/a%22b&amp;c.html"`);
  });
});

describe("prepareReviewFiles", () => {
  let root: string;
  let ws: string;
  let out: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "review-files-")));
    ws = join(root, "ws");
    out = join(root, "reviews", "gate-P1-v1.files");
    mkdirSync(join(ws, "src", "mock"), { recursive: true });
    writeFileSync(join(ws, "src", "mock", "workspace.html"), "<h1>mock</h1>");
    writeFileSync(join(ws, "other.html"), "<h1>other</h1>");
    mkdirSync(join(ws, "a"), { recursive: true });
    mkdirSync(join(ws, "b"), { recursive: true });
    writeFileSync(join(ws, "a", "index.html"), "A");
    writeFileSync(join(ws, "b", "index.html"), "B");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (id: string, path: string): ReviewSection => ({ id, heading: id, kind: "file", path });
  const opts = () => ({ workspacePath: ws, outDir: out, publicBase: "./gate-P1-v1.files" });

  it("file 節を outDir に複製し path を書き換える", () => {
    const input = doc([md("a", "x"), file("mock", "src/mock/workspace.html")]);
    const result = prepareReviewFiles(input, opts());
    expect(result.sections[1].path).toBe("./gate-P1-v1.files/workspace.html");
    expect(readFileSync(join(out, "workspace.html"), "utf8")).toBe("<h1>mock</h1>");
    expect(result.sections[0]).toEqual(input.sections[0]);
  });

  it("入力の doc は変更しない", () => {
    const input = doc([file("mock", "src/mock/workspace.html")]);
    const snapshot = JSON.stringify(input);
    prepareReviewFiles(input, opts());
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("絶対パス（workspace 内）も受け付ける", () => {
    const result = prepareReviewFiles(doc([file("m", join(ws, "other.html"))]), opts());
    expect(result.sections[0].path).toBe("./gate-P1-v1.files/other.html");
  });

  it("previousFeedback の file 節も扱う", () => {
    const input = doc([md("a", "x")], { version: 2, previousFeedback: file("prev", "other.html") });
    const result = prepareReviewFiles(input, opts());
    expect(result.previousFeedback?.path).toBe("./gate-P1-v1.files/other.html");
  });

  it("同名ファイルは連番で衝突を避ける", () => {
    const result = prepareReviewFiles(doc([file("a", "a/index.html"), file("b", "b/index.html")]), opts());
    const names = result.sections.map((s) => s.path);
    expect(names[0]).toBe("./gate-P1-v1.files/index.html");
    expect(names[1]).toBe("./gate-P1-v1.files/index-2.html");
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe("A");
    expect(readFileSync(join(out, "index-2.html"), "utf8")).toBe("B");
  });

  it("大文字小文字だけが違う名前も衝突として扱う", () => {
    mkdirSync(join(ws, "c"), { recursive: true });
    writeFileSync(join(ws, "c", "Index.html"), "C");
    const result = prepareReviewFiles(doc([file("a", "a/index.html"), file("c", "c/Index.html")]), opts());
    expect(result.sections[0].path).toBe("./gate-P1-v1.files/index.html");
    expect(result.sections[1].path).toBe("./gate-P1-v1.files/Index-2.html");
  });

  it("同じファイルを複数の節が指しても 1 回だけ複製する", () => {
    const result = prepareReviewFiles(doc([file("a", "other.html"), file("b", "./other.html")]), opts());
    expect(result.sections[0].path).toBe(result.sections[1].path);
  });

  it("workspace の外のパスは Error", () => {
    writeFileSync(join(root, "secret.txt"), "s");
    expect(() => prepareReviewFiles(doc([file("x", "../secret.txt")]), opts())).toThrow(/ワークスペース/);
    expect(() => prepareReviewFiles(doc([file("x", join(root, "secret.txt"))]), opts())).toThrow(/ワークスペース/);
  });

  it("workspace 外を指すシンボリックリンクは Error（実パスで判定）", () => {
    writeFileSync(join(root, "secret.txt"), "s");
    symlinkSync(join(root, "secret.txt"), join(ws, "link.txt"));
    expect(() => prepareReviewFiles(doc([file("x", "link.txt")]), opts())).toThrow(/ワークスペース/);
    expect(existsSync(join(out, "link.txt"))).toBe(false);
  });

  it("workspace 内を指すシンボリックリンクは許容する", () => {
    symlinkSync(join(ws, "other.html"), join(ws, "inner-link.html"));
    const result = prepareReviewFiles(doc([file("x", "inner-link.html")]), opts());
    expect(result.sections[0].path).toBe("./gate-P1-v1.files/other.html");
  });

  it("存在しないファイルは Error", () => {
    expect(() => prepareReviewFiles(doc([file("x", "nope.html")]), opts())).toThrow(/nope\.html/);
  });

  it("ディレクトリは Error", () => {
    expect(() => prepareReviewFiles(doc([file("x", "src")]), opts())).toThrow(/ファイル/);
  });

  it("5 MiB を超えるファイルは Error", () => {
    writeFileSync(join(ws, "big.html"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect(() => prepareReviewFiles(doc([file("x", "big.html")]), opts())).toThrow(/5 MiB/);
  });

  it("file 節が無ければ何も複製しない", () => {
    const input = doc([md("a", "x")]);
    const result = prepareReviewFiles(input, opts());
    expect(result).toEqual(input);
    expect(existsSync(out)).toBe(false);
  });

  it("URL に使えない文字はエンコードして path にする", () => {
    writeFileSync(join(ws, "my mock#1.html"), "x");
    const result = prepareReviewFiles(doc([file("x", "my mock#1.html")]), opts());
    expect(result.sections[0].path).toBe("./gate-P1-v1.files/my%20mock%231.html");
    expect(existsSync(join(out, "my mock#1.html"))).toBe(true);
  });
});
