import { describe, expect, test } from "bun:test";
import { buildReaderView } from "../src/lib/reader.ts";
import { renderBlockHtml, scopedAnchorId } from "../src/lib/render.ts";

const body = "# Title\n\nA paragraph.\n\n![img](./assets/abc.png)";
const zhAligned = "# 标题\n\n一个段落。\n\n![img](./assets/abc.png)";
const zhMisaligned = "# 标题\n\n一个段落。";

describe("renderBlockHtml", () => {
  test("renders markdown and rewrites asset paths", () => {
    const html = renderBlockHtml("![img](./assets/abc.png)", "my-slug");
    expect(html).toContain('src="/vault-assets/my-slug/abc.png"');
  });

  test("renders an image paragraph with prose as a figure (ADR 0011)", () => {
    const html = renderBlockHtml(
      "![alt](./assets/x.png)\nFigure 1: what it shows.",
      "s",
    );
    expect(html).toContain("<figure>");
    expect(html).toContain('src="/vault-assets/s/x.png"');
    expect(html).toContain("<figcaption>Figure 1: what it shows.</figcaption>");
  });

  test("a hard break between image and caption is the separator, not content", () => {
    const html = renderBlockHtml("![alt](./assets/x.png)  \nA caption.", "s");
    expect(html).toContain("<figcaption>A caption.</figcaption>");
    expect(html).not.toContain("<br>");
  });

  test("keeps a captioned image's lightbox link", () => {
    const html = renderBlockHtml(
      "[![alt](./assets/x.png)](https://example.com/full.png)\nA caption.",
      "s",
    );
    expect(html).toContain('<figure><a href="https://example.com/full.png">');
    expect(html).toContain("<figcaption>A caption.</figcaption>");
  });

  test("an image on its own stays a plain image, not an empty figure", () => {
    const html = renderBlockHtml("![alt](./assets/x.png)", "s");
    expect(html).not.toContain("<figure>");
  });

  test("a paragraph of several images is not a figure", () => {
    const html = renderBlockHtml(
      "![one](./assets/a.png)\n![two](./assets/b.png)",
      "s",
    );
    expect(html).not.toContain("<figure>");
  });

  test("prose that merely contains an image is not a figure", () => {
    const html = renderBlockHtml("As shown ![alt](./assets/x.png) here.", "s");
    expect(html).not.toContain("<figure>");
  });

  test("figure markup a page smuggled in is still stripped", () => {
    // The only figures on this site are the ones the renderer builds after
    // sanitization; the allowlist never has to admit the tag (ADR 0009).
    const html = renderBlockHtml(
      '<figure><img src="./assets/x.png"><figcaption>cap</figcaption></figure>',
      "s",
    );
    expect(html).not.toContain("<figure>");
    expect(html).not.toContain("<figcaption>");
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

  test("wraps a table in a horizontal scroll box", () => {
    const html = renderBlockHtml("| a | b |\n| --- | --- |\n| 1 | 2 |", "s");
    expect(html).toContain('<div class="table-scroll">');
    expect(html).toMatch(/<div class="table-scroll"><table>/);
  });

  // The wrapper carries a class the sanitize schema allows on nothing, so it
  // is only safe because it is emitted after that step (ADR 0009). A table
  // arriving as clipped raw HTML must come out wrapped too, and stripped of
  // whatever the source page styled it with.
  test("wraps a table that arrived as raw HTML, without its attributes", () => {
    const html = renderBlockHtml(
      '<table width="900" style="width:900px" class="src"><tr><td>x</td></tr></table>',
      "s",
    );
    expect(html).toContain('<div class="table-scroll">');
    expect(html).not.toContain("style=");
    expect(html).not.toContain('class="src"');
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

  test("infers a language for a bare fence and highlights it", () => {
    // Every fence in the vault is bare, so this is the path the whole corpus
    // takes. detect-language.test.ts owns which answer is right; this owns
    // that the answer reaches the rendered HTML at all.
    const html = renderBlockHtml(
      "```\npub enum Data {\n    A(Ipv4Addr),\n    B(Txt),\n}\n```",
      "s",
    );
    expect(html).toContain('<span style="color:');
    expect(html).toContain("pub");
  });

  test("leaves a bare fence of prose unhighlighted", () => {
    const html = renderBlockHtml(
      "```\nPlease remove all mannered prose.\n```",
      "s",
    );
    expect(html).toContain('class="shiki');
    expect(html).not.toContain('<span style="color:');
  });

  test("a declared language still wins over inference", () => {
    // `# Heading` plus a list is markdown to the detector; the fence says
    // otherwise and the fence is what the page told us.
    const html = renderBlockHtml("```yaml\n# Heading\n- a\n- b\n```", "s");
    expect(html).toContain('class="shiki');
    expect(html).toContain("# Heading");
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

describe("in-document anchors are scoped to their pane", () => {
  const note = '<span id="fn1"></span>\\[1\\] The note text.';
  const ref = "See \\[[1](#fn1)\\] above.";

  /**
   * Both halves of one rule. The sanitizer clobbers `id` to `user-content-…`
   * and leaves `href="#fn1"` alone, so before this every in-document link in
   * every clipped article pointed at an id that no longer spelled that way.
   */
  test("an id and the link pointing at it come out matching", () => {
    const target = renderBlockHtml(note, "s", { pane: "original" });
    const link = renderBlockHtml(ref, "s", { pane: "original" });
    expect(target).toContain('id="tiro-o-fn1"');
    expect(link).toContain('href="#tiro-o-fn1"');
  });

  /**
   * The sanitizer clobbers `aria-labelledby` and `aria-describedby` alongside
   * `id`, and hast parses those as arrays because they are space-separated id
   * lists. Handling only string values moved the id and left the reference
   * spelled the old way — a screen reader losing the label, with nothing
   * visibly wrong. remark-gfm's own footnotes are the shape that proves it.
   */
  test("an aria reference moves with the id it points at", () => {
    const html = renderBlockHtml("Text[^1].\n\n[^1]: The note.", "s", {
      pane: "original",
    });
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBe("tiro-o-footnote-label");
    expect(html).toContain(`id="${described}"`);
  });

  /**
   * The title block names an anchor without rendering its block, so this has to
   * agree with what the pipeline produces — a second rule that could drift. The
   * awkward case is an id that already begins with the clobber prefix: the
   * sanitizer adds one and the pass strips one, so it still round-trips.
   */
  test.each(["top", "user-content-fn-1"])(
    "scopedAnchorId agrees with the rendered id, for %s",
    (id) => {
      const html = renderBlockHtml(`<span id="${id}"></span>x`, "s", {
        pane: "original",
      });
      expect(html).toContain(`id="${scopedAnchorId(id, "original")}"`);
    },
  );

  // `[slug].astro` puts both columns in one document, so an unscoped id would
  // appear twice and a jump would land in whichever came first.
  test("the two panes never share an id", () => {
    const original = renderBlockHtml(note, "s", { pane: "original" });
    const translation = renderBlockHtml(note, "s", { pane: "translation" });
    expect(original).toContain('id="tiro-o-fn1"');
    expect(translation).toContain('id="tiro-t-fn1"');
    expect(original).not.toContain('id="tiro-t-fn1"');
  });

  test("a link stays inside its own pane", () => {
    expect(renderBlockHtml(ref, "s", { pane: "translation" })).toContain(
      'href="#tiro-t-fn1"',
    );
  });

  // The clobber exists to stop a page-chosen id shadowing a DOM property. Any
  // non-empty prefix serves that, so replacing it loses no protection.
  test("still shields a page-chosen id from clobbering the DOM", () => {
    const html = renderBlockHtml('<span id="body"></span>text', "s");
    expect(html).toContain('id="tiro-o-body"');
    expect(html).not.toContain('id="body"');
  });

  /**
   * GitHub renders its own footnotes with `user-content-` ids, so a clipped
   * GitHub page carries them as the author's spelling. The sanitizer clobbers
   * that to `user-content-user-content-fn-1`; stripping exactly one occurrence
   * hands the author's id back rather than eating half of it, and the link is
   * prefixed from the same spelling so the two still meet.
   */
  test("gives back an author id that itself begins user-content-", () => {
    expect(
      renderBlockHtml('<span id="user-content-fn-1"></span>x', "s"),
    ).toContain('id="tiro-o-user-content-fn-1"');
    expect(renderBlockHtml("[x](#user-content-fn-1)", "s")).toContain(
      'href="#tiro-o-user-content-fn-1"',
    );
  });

  // A dead fragment is exactly as dead as before; rendering it as plain text
  // would remove the reader's ability to see, hover or copy it (ADR 0024).
  test("a fragment with no target in this article is still a link", () => {
    expect(renderBlockHtml("[see](#nowhere)", "s")).toContain(
      'href="#tiro-o-nowhere"',
    );
  });

  test("leaves an absolute URL that carries a fragment alone", () => {
    expect(
      renderBlockHtml("[spec](https://example.test/a#part)", "s"),
    ).toContain('href="https://example.test/a#part"');
  });

  // A bare "#" addresses the top of the page rather than an id.
  test("leaves a bare hash alone", () => {
    expect(renderBlockHtml("[top](#)", "s")).toContain('href="#"');
  });

  // The prefix holds nothing encodable, so an escaped fragment still matches
  // the id, which was written from the same bytes.
  test("a percent-encoded fragment keeps its encoding", () => {
    expect(renderBlockHtml("[x](#a%2Eb)", "s")).toContain(
      'href="#tiro-o-a%2Eb"',
    );
  });

  // Stacked is the degraded mode, and it emits two whole lists into the one
  // document — so it has exactly the collision `paired` has.
  test("scopes both lists of a stacked view, not just the first", () => {
    const view = buildReaderView(`# Title\n\n${note}`, "# 标题", "s");
    expect(view.kind).toBe("stacked");
    if (view.kind !== "stacked") return;
    expect(view.original.join("")).toContain('id="tiro-o-fn1"');
    expect(view.original.join("")).not.toContain('id="tiro-t-fn1"');
  });

  test("scopes each side of a paired row", () => {
    const view = buildReaderView(`# T\n\n${note}`, `# 标\n\n${note}`, "s");
    expect(view.kind).toBe("paired");
    if (view.kind !== "paired") return;
    const row = view.rows[1];
    expect(row?.original).toContain('id="tiro-o-fn1"');
    expect(row?.translation).toContain('id="tiro-t-fn1"');
  });
});
