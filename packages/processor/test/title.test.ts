import { describe, expect, test } from "bun:test";
import {
  acceptableSourceSummary,
  acceptableTitleZh,
  sourceSummaryPromptLine,
  titlePromptLines,
} from "../src/llm/title.ts";

describe("acceptableTitleZh", () => {
  test("keeps a translation and trims it", () => {
    expect(acceptableTitleZh("  小模型时代已经到来  ")).toBe(
      "小模型时代已经到来",
    );
  });

  test("keeps a translation that is mostly a product name", () => {
    // The reason the bar is one Han character and not a ratio.
    expect(acceptableTitleZh("为 Claude Fable 5.1 编写提示词")).toBe(
      "为 Claude Fable 5.1 编写提示词",
    );
  });

  test("rejects an echo of the source title", () => {
    expect(acceptableTitleZh("The Twelve-Factor App")).toBeUndefined();
  });

  test("rejects nothing, empty and whitespace", () => {
    expect(acceptableTitleZh(undefined)).toBeUndefined();
    expect(acceptableTitleZh("")).toBeUndefined();
    expect(acceptableTitleZh("   ")).toBeUndefined();
  });
});

describe("acceptableSourceSummary", () => {
  test("keeps a summary in another language and trims it", () => {
    expect(acceptableSourceSummary("  An English summary.  ", "中文摘要")).toBe(
      "An English summary.",
    );
  });

  test("rejects a repeat of the target-language summary", () => {
    expect(acceptableSourceSummary("中文摘要", "  中文摘要  ")).toBeUndefined();
  });

  test("keeps an English summary quoting a Chinese term", () => {
    // No script test here on purpose: this is generated prose, not a short
    // string a model hands back verbatim.
    const candidate = 'The author calls it "读后感" throughout.';
    expect(acceptableSourceSummary(candidate, "中文摘要")).toBe(candidate);
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
