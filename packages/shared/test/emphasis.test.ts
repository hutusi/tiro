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

  test("reads its neighbours as characters, not UTF-16 code units", () => {
    // 𠮷 is Han from Extension B, so it is a surrogate pair. Reading one code
    // unit beside the delimiter saw a lone surrogate, decided no CJK was
    // adjacent, and left the span broken.
    expect(normalizeCjkEmphasis("𠮷_强调_8 文字")).toBe("𠮷*强调*8 文字");
    expect(normalizeCjkEmphasis("名字𠮷_tick_（时刻）")).toBe(
      "名字𠮷*tick*（时刻）",
    );
    // A supplementary character that is not CJK is still not CJK.
    expect(normalizeCjkEmphasis("😀_x_y 表情")).toBe("😀_x_y 表情");
  });

  test("pairs delimiters that sit either side of an inline node", () => {
    // The span wraps a link, so its two delimiters are in different text
    // nodes — the shape a per-node scan could never pair, which left literal
    // underscores on four articles.
    expect(
      normalizeCjkEmphasis("决定的_[纽约时报](https://e.com/a_b)_文章抓住了"),
    ).toBe("决定的*[纽约时报](https://e.com/a_b)*文章抓住了");
    // The `a_b` in the destination is not a text node, so it stays put.
    expect(normalizeCjkEmphasis("见 [链接](https://e.com/a_b_c) 的说明")).toBe(
      "见 [链接](https://e.com/a_b_c) 的说明",
    );
  });

  test("does not re-bracket a sentence the parser already read as spans", () => {
    // Six delimiters: the parser pairs the inner four and strands the outer
    // two. Joining those two would emphasise the whole sentence instead of the
    // three phrases the author marked, so the sentence is left as it is.
    const run = `是指_"悲惨"_，而_"悲惨"_是指_"自作自受"_的话`;
    expect(normalizeCjkEmphasis(run)).toBe(run);
  });

  test("does not let a stray underscore swallow the next span's opener", () => {
    // Reaching across the link, the first underscore would pair with the
    // opener of `_真的_` — italicising text nobody marked and leaving the real
    // span broken. The nearer, same-node reading wins.
    expect(
      normalizeCjkEmphasis("调用 中文_file[链接](url)中文_真的_文字"),
    ).toBe("调用 中文_file[链接](url)中文*真的*文字");
  });

  test("a span of the other delimiter inside is not in the way", () => {
    expect(normalizeCjkEmphasis("看看_这个**重点**的说明_吧")).toBe(
      "看看*这个**重点**的说明*吧",
    );
  });

  test("a pipe outside a table is an ordinary character", () => {
    // Only a cell wall separates text on one line. Barring a span from
    // crossing any `|` refused these, which the parser reads without complaint.
    expect(normalizeCjkEmphasis("中文_`foo | bar`_文字")).toBe(
      "中文*`foo | bar`*文字",
    );
    expect(normalizeCjkEmphasis("中文_[链接](https://e.com/a|b)_文字")).toBe(
      "中文*[链接](https://e.com/a|b)*文字",
    );
  });

  test("a span inside a link label is a flow of its own", () => {
    // An emphasis the parser built inside the label cannot interleave with
    // delimiters outside the link, so it is not evidence against this pair.
    expect(normalizeCjkEmphasis("中文_[链接 _important_](url)_文字")).toBe(
      "中文*[链接 _important_](url)*文字",
    );
  });

  test("does not pair across a table cell boundary", () => {
    // Two cells are not one span. Nothing rejects this in the scan — the
    // verification does, because `*a` and `b*` in separate cells are not
    // emphasis and the rendered text would change.
    const table = "| 甲 | 乙 |\n| --- | --- |\n| 中文_a | b_文 |";
    expect(normalizeCjkEmphasis(table)).toBe(table);
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
