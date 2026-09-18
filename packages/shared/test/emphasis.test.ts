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
    // `*` works inside a word where `_` does not, so a swap here would turn an
    // identifier into italics. The last two are the ones that matter: a CJK
    // character in front is not evidence of emphasis, because an identifier in
    // Chinese prose has one too.
    for (const untouched of [
      "调用 snake_case_name 之后",
      "the fire_and_forget function",
      "中文_file_name 的说明",
      "数据_table_name_ 的字段",
      // CJK *inside* an identifier is no different: Latin sits on both sides
      // of these delimiters, so there is no CJK adjacency to cure.
      "my_报告_draft 文件",
      "a 报告_draft_file name",
    ]) {
      expect(normalizeCjkEmphasis(untouched)).toBe(untouched);
    }
  });

  test("repairs a Latin span when CJK adjacency is the only obstacle", () => {
    // Same shape as `中文_file_name` above and the opposite answer, decided by
    // what follows the closing delimiter: punctuation here, a word character
    // there. That is CommonMark's own intraword rule, asked of the Latin side.
    expect(normalizeCjkEmphasis("一个_tick_（时刻）便流逝")).toBe(
      "一个*tick*（时刻）便流逝",
    );
  });

  test("repairs a CJK span that a word character follows", () => {
    // The probe alone would refuse this one — `_少于_8` is intraword on the
    // Latin side — but the content is CJK, which no identifier is a fragment
    // of, so there is nothing to be ambiguous about.
    expect(normalizeCjkEmphasis("不会_少于_8个月的估算")).toBe(
      "不会*少于*8个月的估算",
    );
  });

  test("treats a span as prose once CJK sits against a delimiter", () => {
    // `用户_信息_table` is repaired and `my_报告_draft` is not, and the only
    // difference is the CJK character in front. The two are genuinely
    // ambiguous — an identifier can look like either — so this follows the
    // corpus: a delimiter that ran into CJK is overwhelmingly prose, which is
    // also what makes `不会_少于_8个月` above come out right.
    expect(normalizeCjkEmphasis("the 用户_信息_table column")).toBe(
      "the 用户*信息*table column",
    );
  });

  test("matches delimiter runs whole", () => {
    // Reading `__强调__` as a `_` pair with an underscore either side rewrote
    // the inner two and left the outer two standing — italics with stray
    // underscores, where the author wrote strong emphasis.
    expect(normalizeCjkEmphasis("中文__强调__文字")).toBe("中文**强调**文字");
    expect(normalizeCjkEmphasis("中文___双重___文字")).toBe(
      "中文***双重***文字",
    );
  });

  test("leaves runs of different lengths alone", () => {
    // CommonMark reads this by splitting the runs, which is more than a
    // delimiter swap can faithfully reproduce.
    expect(normalizeCjkEmphasis("中文__不匹配_文字")).toBe("中文__不匹配_文字");
  });

  test("an unpaired underscore does not hide the lines after it", () => {
    expect(normalizeCjkEmphasis("前文_未闭合\n细节_真的_很重要")).toBe(
      "前文_未闭合\n细节*真的*很重要",
    );
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
