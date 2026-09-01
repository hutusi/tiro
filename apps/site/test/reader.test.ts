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
