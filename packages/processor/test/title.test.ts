import { describe, expect, test } from "bun:test";
import {
  acceptableSourceSummary,
  acceptableTitleZh,
  sourceSummaryPromptLine,
  titlePromptLines,
} from "../src/llm/title.ts";

describe("acceptableTitleZh", () => {
  const SOURCE = "Small Models Have Arrived";

  test("keeps a translation and trims it", () => {
    expect(acceptableTitleZh("  小模型时代已经到来  ", SOURCE)).toBe(
      "小模型时代已经到来",
    );
  });

  test("keeps a translation that is mostly a product name", () => {
    // The reason the bar is one Han character and not a ratio.
    expect(
      acceptableTitleZh("为 Claude Fable 5.1 编写提示词", "Prompting Claude"),
    ).toBe("为 Claude Fable 5.1 编写提示词");
  });

  test("rejects an echo of the source title", () => {
    expect(
      acceptableTitleZh("The Twelve-Factor App", "The Twelve-Factor App"),
    ).toBeUndefined();
  });

  test("rejects an echo of a source title that already contains Han", () => {
    // The Han test passes here — the echo carries the Chinese the source had.
    const mixed = "AI 与 the Future";
    expect(acceptableTitleZh(mixed, mixed)).toBeUndefined();
    // Folded, because an echo can come back in a different case or spacing.
    expect(acceptableTitleZh("ai 与  THE future", mixed)).toBeUndefined();
  });

  test("rejects nothing, empty and whitespace", () => {
    expect(acceptableTitleZh(undefined, SOURCE)).toBeUndefined();
    expect(acceptableTitleZh("", SOURCE)).toBeUndefined();
    expect(acceptableTitleZh("   ", SOURCE)).toBeUndefined();
  });
});

describe("acceptableSourceSummary", () => {
  const accept = (candidate: string | undefined, summary: string) =>
    acceptableSourceSummary(candidate, summary, "zh", 0.3);

  test("keeps a summary in another language and trims it", () => {
    expect(accept("  An English summary.  ", "中文摘要")).toBe(
      "An English summary.",
    );
  });

  test("rejects a verbatim repeat of the target-language summary", () => {
    expect(accept("中文摘要", "  中文摘要  ")).toBeUndefined();
  });

  test("rejects a near-repeat, and a rewrite in the target language", () => {
    // What equality cannot see, and what actually happens: asked for the
    // summary in the article's own language, the model writes the target
    // language again in different words.
    expect(accept("中文摘要。", "中文摘要")).toBeUndefined();
    expect(
      accept("这是另一段中文摘要，措辞不同但仍然是中文。", "中文摘要"),
    ).toBeUndefined();
  });

  test("keeps an English summary quoting a Chinese term", () => {
    // The line the ratio has to sit on the right side of: a quoted term is not
    // a summary written in the target language.
    const candidate = 'The author calls it "读后感" throughout the piece.';
    expect(accept(candidate, "中文摘要")).toBe(candidate);
  });
});

describe("prompt lines", () => {
  test("name the field and the target language", () => {
    const lines = titlePromptLines("zh").join("\n");
    expect(lines).toContain('"title_zh"');
    expect(lines).toContain('"zh"');
  });

  test("the source summary line names its field", () => {
    expect(sourceSummaryPromptLine()).toContain('"summary_orig"');
  });
});
