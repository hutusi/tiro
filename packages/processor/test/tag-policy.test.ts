import { describe, expect, test } from "bun:test";
import { TAG_LIMIT, tagAliases } from "@tiro/shared";
import { isEnglishTag, writableTags } from "../src/tag-policy.ts";

describe("isEnglishTag", () => {
  test("Han, kana and hangul are not; accented Latin is", () => {
    expect(isEnglishTag("ai安全")).toBe(false);
    expect(isEnglishTag("十二要素")).toBe(false);
    expect(isEnglishTag("カタカナ")).toBe(false);
    expect(isEnglishTag("한국어")).toBe(false);
    expect(isEnglishTag("gödel")).toBe(true);
    expect(isEnglishTag("c++")).toBe(true);
  });
});

describe("writableTags", () => {
  const none = new Map<string, string | null>();

  test("writes the model's tags in canonical form", () => {
    expect(writableTags(["Open-Source", "AI_Safety", "GPT-4"], none)).toEqual([
      "open source",
      "ai safety",
      "gpt-4",
    ]);
  });

  test("drops tags that are not in English, and says so", () => {
    const logs: string[] = [];
    expect(
      writableTags(["ai安全", "ai safety", "熵"], none, (m) => logs.push(m)),
    ).toEqual(["ai safety"]);
    expect(logs).toEqual(["dropped non-English tag(s): ai安全, 熵"]);
  });

  test("says nothing when nothing was dropped", () => {
    const logs: string[] = [];
    writableTags(["rust"], none, (m) => logs.push(m));
    expect(logs).toEqual([]);
  });

  test("applies the vault's aliases", () => {
    const aliases = tagAliases({ "large language models": "llm", misc: null });
    expect(
      writableTags(["Large-Language-Models", "misc", "LLM"], aliases),
    ).toEqual(["llm"]);
  });

  test("an alias can bring a tag into English", () => {
    const aliases = tagAliases({ 人工智能: "ai" });
    expect(writableTags(["人工智能"], aliases)).toEqual(["ai"]);
  });

  test("filters before it caps", () => {
    // A reply that leads with tags this drops still gets its full allowance.
    const offered = ["一", "二", "三", "a", "b", "c", "d", "e", "f", "g"];
    expect(writableTags(offered, none)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"].slice(0, TAG_LIMIT),
    );
  });
});
