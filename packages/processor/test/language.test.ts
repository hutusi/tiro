import { describe, expect, test } from "bun:test";
import { cjkRatio, detectLang } from "../src/language.ts";

describe("detectLang", () => {
  test("classifies English prose as en", () => {
    expect(
      detectLang("A plain English paragraph about language models.", 0.3),
    ).toBe("en");
  });

  test("classifies Chinese prose as zh", () => {
    expect(
      detectLang("这是一段完全使用中文撰写的文字，用来测试语言检测。", 0.3),
    ).toBe("zh");
  });

  test("mixed text follows the threshold", () => {
    const mixed =
      "LLM 模型 is a tool 工具 for text 文本 processing 处理 tasks 任务";
    expect(cjkRatio(mixed)).toBeGreaterThan(0.1);
    expect(detectLang(mixed, 0.9)).toBe("en");
  });

  test("ignores code blocks when computing the ratio", () => {
    const body = [
      "只有一句中文。",
      "",
      "```",
      "const englishCode = 'lots of english identifiers here';",
      "```",
    ].join("\n");
    expect(detectLang(body, 0.3)).toBe("zh");
  });

  test("empty body is not Chinese", () => {
    expect(detectLang("", 0.3)).toBe("en");
  });
});
