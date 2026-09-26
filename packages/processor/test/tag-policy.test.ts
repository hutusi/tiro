import { describe, expect, test } from "bun:test";
import { TAG_LIMIT, tagAliases } from "@tiro/shared";
import {
  buildVocabulary,
  isEnglishTag,
  MAX_NEW_TAGS,
  VOCABULARY_LIMIT,
  writableTags,
} from "../src/tag-policy.ts";

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

describe("writableTags with a vocabulary", () => {
  const none = new Map<string, string | null>();
  const known = new Set(["rust", "databases", "performance", "security"]);

  test("keeps every listed tag and at most two new ones", () => {
    const logs: string[] = [];
    expect(
      writableTags(
        ["rust", "borrow checker", "databases", "lifetimes", "arenas"],
        none,
        (m) => logs.push(m),
        known,
      ),
    ).toEqual(["rust", "borrow checker", "databases", "lifetimes"]);
    expect(logs).toEqual([
      `left out new tag(s) past the ${MAX_NEW_TAGS} allowed: arenas`,
    ]);
  });

  test("never leaves an article with fewer than three for want of a listed tag", () => {
    // An article on a topic the vault has never seen still gets its tags.
    expect(
      writableTags(
        ["zig", "comptime", "allocators", "wasm"],
        none,
        () => {},
        known,
      ),
    ).toEqual(["zig", "comptime", "allocators"]);
  });

  test("an empty vocabulary caps nothing", () => {
    expect(
      writableTags(["a", "b", "c", "d"], none, () => {}, new Set()),
    ).toEqual(["a", "b", "c", "d"]);
  });

  test("a spelling variant of a listed tag counts as listed", () => {
    expect(
      writableTags(["Rust", "Databases", "x", "y", "z"], none, () => {}, known),
    ).toEqual(["rust", "databases", "x", "y"]);
  });
});

describe("buildVocabulary", () => {
  const none = new Map<string, string | null>();

  test("keeps tags that recur, most used first", () => {
    expect(
      buildVocabulary(
        [
          ["rust", "databases"],
          ["rust", "security"],
          ["rust", "databases"],
          ["one-off"],
        ],
        none,
      ),
    ).toEqual(["rust", "databases"]);
  });

  test("counts an article once, however it spelled a tag", () => {
    expect(
      buildVocabulary([["Open-Source", "open source"], ["zig"]], none),
    ).toEqual([]);
    expect(buildVocabulary([["Open-Source"], ["open_source"]], none)).toEqual([
      "open source",
    ]);
  });

  test("leaves out tags that are not in English", () => {
    expect(buildVocabulary([["知识管理"], ["知识管理"]], none)).toEqual([]);
  });

  test("merges through the aliases", () => {
    const aliases = tagAliases({ "large language models": "llm" });
    expect(
      buildVocabulary([["llm"], ["large language models"]], aliases),
    ).toEqual(["llm"]);
  });

  test("breaks ties by spelling, so the list is stable", () => {
    expect(
      buildVocabulary(
        [
          ["b", "a"],
          ["a", "b"],
        ],
        none,
      ),
    ).toEqual(["a", "b"]);
  });

  test(`offers at most ${VOCABULARY_LIMIT}`, () => {
    const tags = Array.from(
      { length: VOCABULARY_LIMIT + 10 },
      (_, i) => `t${i}`,
    );
    expect(buildVocabulary([tags, tags], none)).toHaveLength(VOCABULARY_LIMIT);
  });
});
