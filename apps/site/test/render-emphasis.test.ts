import { describe, expect, test } from "bun:test";
import { renderBlockHtml } from "../src/lib/render.ts";

/**
 * The two ways CJK broke emphasis, from the same article: the delimiter the
 * clipper used to write, and the one the translator still writes.
 */
describe("emphasis in CJK prose", () => {
  test("closes a span whose text ends in CJK punctuation", () => {
    expect(renderBlockHtml("这是**事实上，**的部分", "s")).toContain(
      "<strong>事实上，</strong>",
    );
    expect(renderBlockHtml("*— John 1:1，*描述了", "s")).toContain(
      "<em>— John 1:1，</em>",
    );
  });

  test("reads asterisk emphasis between CJK characters", () => {
    expect(renderBlockHtml("细节*真的*很重要", "s")).toContain("<em>真的</em>");
  });

  test("still refuses intraword underscores, as CommonMark requires", () => {
    // Not a gap: the content is repaired instead (`normalizeCjkEmphasis`), so
    // that an identifier like `snake_case_name` keeps working everywhere.
    const html = renderBlockHtml("the fire_and_forget function", "s");
    expect(html).toContain("fire_and_forget");
    expect(html).not.toContain("<em>");
  });

  test("leaves prose without CJK exactly as CommonMark renders it", () => {
    expect(renderBlockHtml("a _b_ and **c** here", "s")).toBe(
      "<p>a <em>b</em> and <strong>c</strong> here</p>",
    );
  });
});
