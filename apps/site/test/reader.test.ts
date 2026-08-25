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
