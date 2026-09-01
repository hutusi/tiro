import { describe, expect, test } from "bun:test";
import { buildReaderView } from "../src/lib/reader.ts";
import { renderBlockHtml } from "../src/lib/render.ts";

const body = "# Title\n\nA paragraph.\n\n![img](./assets/abc.png)";
const zhAligned = "# 标题\n\n一个段落。\n\n![img](./assets/abc.png)";
const zhMisaligned = "# 标题\n\n一个段落。";

describe("renderBlockHtml", () => {
  test("renders markdown and rewrites asset paths", () => {
    const html = renderBlockHtml("![img](./assets/abc.png)", "my-slug");
    expect(html).toContain('src="/vault-assets/my-slug/abc.png"');
  });

  test("keeps figure markup with rewritten asset URLs", () => {
    const html = renderBlockHtml(
      '<figure><img src="./assets/x.png"><figcaption>cap</figcaption></figure>',
      "s",
    );
    expect(html).toContain("<figure>");
    expect(html).toContain('src="/vault-assets/s/x.png"');
    expect(html).toContain("<figcaption>cap</figcaption>");
  });

  test("strips event handlers but keeps the image", () => {
    const html = renderBlockHtml(
      '<img src="./assets/x.png" onerror="alert(1)" alt="a">',
      "s",
    );
    expect(html).toContain('src="/vault-assets/s/x.png"');
    expect(html).not.toContain("onerror");
  });

  test("strips script and iframe elements entirely", () => {
    const html = renderBlockHtml(
      '<script>alert(1)</script><iframe src="https://evil.example"></iframe>',
      "s",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("alert(1)");
  });

  test("strips javascript: link targets", () => {
    const html = renderBlockHtml("[click](javascript:alert(1))", "s");
    expect(html).not.toContain("javascript:");
  });

  test("highlights a fenced block with its declared language", () => {
    const html = renderBlockHtml("```ts\nconst a = 1;\n```", "s");
    expect(html).toContain('class="shiki');
    expect(html).toContain('<span style="color:');
    expect(html).toContain("const");
    // The theme's own background is dropped so the site's warm code styling
    // keeps owning it; only token colors come from Shiki.
    expect(html).not.toContain("background-color");
  });

  test("falls back to plain text for an unknown language", () => {
    const html = renderBlockHtml("```notalanguage\nx := 1\n```", "s");
    expect(html).toContain('class="shiki');
    expect(html).toContain("x := 1");
  });

  test("highlights an unlabelled fence without a trailing blank line", () => {
    const html = renderBlockHtml("```\nplain\n```", "s");
    expect(html).toContain("plain");
    expect(html.match(/class="line"/g)).toHaveLength(1);
  });

  test("keeps every child of a <pre>, not just the first <code>", () => {
    // The replacement discards the <pre>, so reading only the <code> the
    // language came from drops anything beside it — both shapes reachable
    // through clipped raw HTML.
    expect(
      renderBlockHtml(
        '<pre><code class="language-js">let a=1</code><code>SECOND</code></pre>',
        "s",
      ),
    ).toContain("SECOND");
    expect(renderBlockHtml("<pre>PREFIX<code>x</code></pre>", "s")).toContain(
      "PREFIX",
    );
  });

  test("treats <br> in clipped code as a line break", () => {
    const html = renderBlockHtml(
      '<pre><code class="language-js">let a=1<br>let b=2</code></pre>',
      "s",
    );
    expect(html).not.toContain("1let");
    expect(html.match(/class="line"/g)).toHaveLength(2);
  });

  test("does not warn about languages Shiki handles without a grammar", () => {
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      for (const lang of ["text", "plaintext", "console", "golang", "objc"]) {
        renderBlockHtml(`\`\`\`${lang}\nx\n\`\`\``, "s");
      }
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
  });

  test("keeps the code of a clip that shipped its own highlighting", () => {
    // Sanitization strips these spans' attributes but keeps the elements, so
    // reading only direct text children would render an empty block.
    const html = renderBlockHtml(
      '<pre><code class="language-js"><span style="color:red">const</span> x = 1;</code></pre>',
      "s",
    );
    expect(html).toContain("const");
    expect(html).toContain("x");
    expect(html).not.toContain("color:red");
  });

  test("highlighting does not reopen the sanitizer", () => {
    // Shiki emits class and style attributes; the schema must still refuse
    // them from clipped markup, and strip scripts before Shiki ever runs.
    const html = renderBlockHtml(
      '<pre class="evil" style="position:fixed"><code>a<script>alert(1)</script>b</code></pre>',
      "s",
    );
    expect(html).not.toContain("evil");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("ab");
  });

  test("typesets display math without the has_math flag", () => {
    // `$$…$$` is unambiguous, so it renders for every article — including
    // ones clipped before the extension knew about math.
    const html = renderBlockHtml("$$\nE = mc^2\n$$", "s");
    expect(html).toContain("katex-display");
    expect(html).toContain("<math");
    expect(html).not.toContain("$$");
  });

  test("leaves prose dollar amounts alone by default", () => {
    const html = renderBlockHtml("It costs $5 to $10 today.", "s");
    expect(html).toBe("<p>It costs $5 to $10 today.</p>");
  });

  test("typesets inline math only when the article declares it", () => {
    expect(renderBlockHtml("a $x^2$ b", "s")).toBe("<p>a $x^2$ b</p>");
    const html = renderBlockHtml("a $x^2$ b", "s", { inlineMath: true });
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-display");
  });

  test("renders an unclosed $$ fence as prose, not one red error blob", () => {
    const html = renderBlockHtml("$$10 for the basic plan.", "s");
    expect(html).toBe("<p>$$10 for the basic plan.</p>");
    expect(html).not.toContain("katex");
  });

  test("renders a pricing list instead of two empty formulas", () => {
    // These rendered as empty katex-display spans, so "moderate" and
    // "premium" vanished from the page entirely.
    const html = renderBlockHtml("- $$ — moderate\n- $$$ — premium\n", "s");
    expect(html).toContain("moderate");
    expect(html).toContain("premium");
    expect(html).not.toContain("katex");
  });

  test("keeps the text of chained unclosed fences", () => {
    // Escaping only the first opener left the second to render as an empty
    // formula, so "premium" disappeared from the page.
    for (const source of [
      "$$ — moderate\n$$$ — premium",
      "> $$ — moderate\n> $$$ — premium",
    ]) {
      const html = renderBlockHtml(source, "s");
      expect(html).toContain("moderate");
      expect(html).toContain("premium");
      expect(html).not.toContain("katex");
    }
  });

  test("leaves a clipped raw <pre> unescaped", () => {
    // Raw <pre> is a supported clipped-code shape, so backslashes leaking into
    // one are visible to the reader.
    const lines = ["- item"];
    for (let i = 0; i < 12; i += 1) lines.push(`  $$ tier ${i}`);
    lines.push("", "  <pre>", "  $$ is the shell PID", "  </pre>");
    const html = renderBlockHtml(lines.join("\n"), "s");
    const code = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
    expect(code.replace(/<[^>]+>/g, "")).toContain("$$ is the shell PID");
    expect(html).not.toContain("\\$\\$ is the shell");
  });

  test("typesets a swallowed formula past the reparse budget", () => {
    const source = [
      "- item",
      ...Array.from({ length: 12 }, (_, i) => `  $$ tier ${i}`),
      "",
      "  $$O(n)$$",
    ].join("\n");
    const html = renderBlockHtml(source, "s");
    expect(html).toContain("katex");
    expect(html).not.toContain("$$O(n)$$");
  });

  test("typesets a formula that an unclosed fence had swallowed", () => {
    const html = renderBlockHtml("- $$ — price\n\n  $$O(n)$$", "s");
    expect(html).toContain("katex");
    expect(html).toContain("price");
    expect(html).not.toContain("$$O(n)$$");
  });

  test("typesets a formula that follows inline code", () => {
    const source = [
      ...Array.from({ length: 9 }, (_, i) => `$$ tier ${i}`),
      "",
      "`complexity`$$O(n)$$",
    ].join("\n");
    const html = renderBlockHtml(source, "s", { inlineMath: true });
    expect(html).toContain("katex");
    expect(html).not.toContain("$$O(n)$$");
  });

  test("keeps text behind alternating containers", () => {
    const source = [
      ...Array.from({ length: 12 }, (_, i) => `$$ tier ${i}`),
      "",
      "> - > $$ hidden",
    ].join("\n");
    const html = renderBlockHtml(source, "s");
    expect(html).toContain("hidden");
    expect(html).not.toContain("katex");
  });

  test("keeps every item of a deeply nested list of fences", () => {
    const source = Array.from(
      { length: 12 },
      (_, i) => `${"  ".repeat(i)}- $$ tier ${i}`,
    ).join("\n");
    const html = renderBlockHtml(source, "s");
    expect(html).toContain("tier 11");
    expect(html).not.toContain("katex");
  });

  test("renders a trailing lone $$ as text, not a blank formula", () => {
    const html = renderBlockHtml("Some text\n\n$$", "s");
    expect(html).toContain("$$");
    expect(html).not.toContain("katex");
  });

  test("renders prose that merely ends in $$ as prose", () => {
    const html = renderBlockHtml("The service costs $$", "s");
    expect(html).toBe("<p>The service costs $$</p>");
    expect(html).not.toContain("katex-error");
  });

  test("promotes a single-line $$…$$ paragraph to display math", () => {
    const html = renderBlockHtml("$$E = mc^2$$", "s");
    expect(html).toContain("katex-display");
  });

  test("renders broken TeX as an error instead of failing the build", () => {
    const html = renderBlockHtml("$$\n\\frac{1}\n$$", "s");
    expect(html).toContain("katex-error");
  });

  test("math markup does not reopen the sanitizer", () => {
    // The schema gains exactly two class markers; a clipped <math> element and
    // a script inside a formula must still be stripped before KaTeX runs.
    const html = renderBlockHtml(
      '<math><mi onclick="alert(1)">x</mi></math><script>alert(2)</script>',
      "s",
    );
    expect(html).not.toContain("<math");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(");
  });

  test("renders GFM tables", () => {
    const html = renderBlockHtml("| a | b |\n| --- | --- |\n| 1 | 2 |", "s");
    expect(html).toContain("<table>");
  });
});

describe("buildReaderView", () => {
  test("no translation renders single-column", () => {
    const view = buildReaderView(body, null, "s");
    expect(view.kind).toBe("single");
    if (view.kind === "single") expect(view.blocks).toHaveLength(3);
  });

  test("aligned translation renders paired rows", () => {
    const view = buildReaderView(body, zhAligned, "s");
    expect(view.kind).toBe("paired");
    if (view.kind === "paired") {
      expect(view.rows).toHaveLength(3);
      expect(view.rows[0]?.original).toContain("Title");
      expect(view.rows[0]?.translation).toContain("标题");
    }
  });

  test("misaligned translation falls back to stacked", () => {
    const view = buildReaderView(body, zhMisaligned, "s");
    expect(view.kind).toBe("stacked");
  });
});
