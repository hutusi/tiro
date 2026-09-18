import { describe, expect, test } from "bun:test";
import { splitBlocks } from "../src/blocks.ts";
import { normalizeCjkEmphasis } from "../src/emphasis.ts";

describe("normalizeCjkEmphasis", () => {
  test("rewrites emphasis CommonMark cannot read between CJK characters", () => {
    expect(normalizeCjkEmphasis("细节_真的_很重要")).toBe("细节*真的*很重要");
    expect(normalizeCjkEmphasis("现在你几乎在_各个地方_都能看到")).toBe(
      "现在你几乎在*各个地方*都能看到",
    );
  });

  test("rewrites a span whose edge is CJK punctuation", () => {
    // Neither delimiter closes this in strict CommonMark; `*` does under the
    // CJK amendment the contract and the site both parse with.
    expect(normalizeCjkEmphasis("_— John 1:1，_描述了")).toBe(
      "*— John 1:1，*描述了",
    );
  });

  test("covers the CJK scripts without word separators", () => {
    expect(normalizeCjkEmphasis("これは_重要_です")).toBe("これは*重要*です");
    expect(normalizeCjkEmphasis("이것은_중요_합니다")).toBe(
      "이것은*중요*합니다",
    );
  });

  test("leaves emphasis the parser already reads alone", () => {
    for (const untouched of [
      "任何你说“_你应该X_”或",
      "更快地实现 _训练_：在将序列",
      "English _italic_ reads fine",
    ]) {
      expect(normalizeCjkEmphasis(untouched)).toBe(untouched);
    }
  });

  test("leaves underscores that were never delimiters alone", () => {
    // The CJK guard is what separates these from a refused delimiter: `*`
    // works inside a word where `_` does not, so a swap here would turn an
    // identifier into italics.
    for (const untouched of [
      "调用 snake_case_name 之后",
      "the fire_and_forget function",
    ]) {
      expect(normalizeCjkEmphasis(untouched)).toBe(untouched);
    }
  });

  test("never reaches inside code, math, HTML or a link destination", () => {
    for (const untouched of [
      "见 [链接](https://example.com/a_b_c) 的说明",
      "行内 `a_b_c` 的代码",
      "公式 $x_i_j$ 的下标",
      "```\n代码_不动_块\n```",
      "$$\nx_i_j\n$$",
      '<span title="a_b_c">中文</span>',
      "![图_说明_图](./assets/a_b_c.png)",
    ]) {
      expect(normalizeCjkEmphasis(untouched)).toBe(untouched);
    }
  });

  test("respects backslash escapes", () => {
    expect(normalizeCjkEmphasis("转义 \\_下划线\\_ 保留")).toBe(
      "转义 \\_下划线\\_ 保留",
    );
  });

  test("repairs inside every block a translation can hold", () => {
    const body = [
      "# 标题_强调_了",
      "",
      "> 引用_强调_中",
      "",
      "- 列表_强调_项",
      "",
      "| a | b |",
      "| - | - |",
      "| 单元_强调_格 | x |",
    ].join("\n");
    expect(normalizeCjkEmphasis(body)).toBe(
      body.replaceAll("_强调_", "*强调*"),
    );
  });

  test("preserves block structure and is idempotent", () => {
    const body = "# 标题_强调_了\n\n段落_强调_里\n\n```\n_不动_\n```\n";
    const once = normalizeCjkEmphasis(body);
    expect(splitBlocks(once).map((b) => b.type)).toEqual(
      splitBlocks(body).map((b) => b.type),
    );
    expect(normalizeCjkEmphasis(once)).toBe(once);
  });

  test("refuses a swap that would pair with a literal asterisk", () => {
    // The new `*` would open against the one in `2*3` and emphasise a span the
    // author never wrote. Left broken rather than rewritten wrong: the check is
    // that the rendered text is unchanged apart from the delimiters, and here
    // it is not.
    const body = "乘法 2*3 与 强调_中文_了";
    expect(normalizeCjkEmphasis(body)).toBe(body);
  });

  test("leaves a body with nothing to repair byte-identical", () => {
    const body = "# Heading\n\nPlain **bold** and _italic_ prose.\n";
    expect(normalizeCjkEmphasis(body)).toBe(body);
  });
});
