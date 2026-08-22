import { describe, expect, test } from "bun:test";
import { buildReaderView } from "../src/lib/reader.ts";
import { renderBlockHtml } from "../src/lib/render.ts";

const body = "# Title\n\nA paragraph.\n\n![img](./assets/abc.png)";
const zhAligned = "# 标题\n\n一个段落。\n\n![img](./assets/abc.png)";
const zhMisaligned = "# 标题\n\n一个段落。";

describe("renderBlockHtml", () => {
  test("renders markdown and rewrites asset paths", () => {
    const html = renderBlockHtml("![img](./assets/abc.png)", "2026", "my-slug");
    expect(html).toContain('src="/vault-assets/2026/my-slug/abc.png"');
  });

  test("passes raw HTML blocks through", () => {
    expect(
      renderBlockHtml(
        '<figure><img src="./assets/x.png"></figure>',
        "2026",
        "s",
      ),
    ).toContain('<figure><img src="/vault-assets/2026/s/x.png"></figure>');
  });

  test("renders GFM tables", () => {
    const html = renderBlockHtml(
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "2026",
      "s",
    );
    expect(html).toContain("<table>");
  });
});

describe("buildReaderView", () => {
  test("no translation renders single-column", () => {
    const view = buildReaderView(body, null, "2026", "s");
    expect(view.kind).toBe("single");
    if (view.kind === "single") expect(view.blocks).toHaveLength(3);
  });

  test("aligned translation renders paired rows", () => {
    const view = buildReaderView(body, zhAligned, "2026", "s");
    expect(view.kind).toBe("paired");
    if (view.kind === "paired") {
      expect(view.rows).toHaveLength(3);
      expect(view.rows[0]?.original).toContain("Title");
      expect(view.rows[0]?.translation).toContain("标题");
    }
  });

  test("misaligned translation falls back to stacked", () => {
    const view = buildReaderView(body, zhMisaligned, "2026", "s");
    expect(view.kind).toBe("stacked");
  });
});
