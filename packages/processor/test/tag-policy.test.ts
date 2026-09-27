import { describe, expect, test } from "bun:test";
import { TAG_LIMIT, tagAliases } from "@tiro/shared";
import {
  buildVocabulary,
  inVaultScripts,
  isEnglishTag,
  MAX_NEW_TAGS,
  undecided,
  undecidedTags,
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

describe("inVaultScripts", () => {
  test("Chinese and English are the vault's; kana and hangul are not", () => {
    expect(inVaultScripts("熵")).toBe(true);
    expect(inVaultScripts("AI安全")).toBe(true);
    expect(inVaultScripts("Git")).toBe(true);
    expect(inVaultScripts("カタカナ")).toBe(false);
    expect(inVaultScripts("한국어")).toBe(false);
  });
});

describe("undecided", () => {
  const none = new Map<string, string | null>();

  test("a lowercase English tag nothing has spelled yet", () => {
    // What every tag in the vault looked like before ADR 0035.
    expect(undecided("digital habits", none)).toBe(true);
    expect(undecided("c++", none)).toBe(true);
  });

  test("not a tag with Chinese in it, or a capital, or no letters at all", () => {
    expect(undecided("熵", none)).toBe(false);
    expect(undecided("AI安全", none)).toBe(false);
    expect(undecided("Git", none)).toBe(false);
    expect(undecided("2026", none)).toBe(false);
  });

  test("not one an alias spells, lowercase or not", () => {
    expect(undecided("npm", tagAliases({ npm: "npm" }))).toBe(false);
    expect(
      undecided("npm", tagAliases({ "node package manager": "npm" })),
    ).toBe(false);
  });
});

describe("writableTags", () => {
  const none = new Map<string, string | null>();

  test("writes the model's tags in canonical form, case kept", () => {
    expect(writableTags(["Open-Source", "AI_Safety", "GPT-4"], none)).toEqual([
      "Open Source",
      "AI Safety",
      "GPT-4",
    ]);
  });

  test("writes a vocabulary tag the way the vault spells it", () => {
    // By key: the model's `git` is the vault's `Git`, not a new tag beside it.
    expect(
      writableTags(["git", "RUST", "zig"], none, () => {}, ["Git", "rust"]),
    ).toEqual(["Git", "rust", "zig"]);
  });

  test("keeps Chinese, drops kana and hangul, and says so", () => {
    const logs: string[] = [];
    expect(
      writableTags(["熵", "ベクトル", "한국어", "AI 安全"], none, (m) =>
        logs.push(m),
      ),
    ).toEqual(["熵", "AI安全"]);
    expect(logs).toEqual([
      "dropped tag(s) in neither Chinese nor English: ベクトル, 한국어",
    ]);
  });

  test("says nothing when nothing was dropped", () => {
    const logs: string[] = [];
    writableTags(["rust"], none, (m) => logs.push(m));
    expect(logs).toEqual([]);
  });

  test("applies the vault's aliases", () => {
    const aliases = tagAliases({ "large language models": "LLM", misc: null });
    expect(
      writableTags(["Large-Language-Models", "misc", "llm"], aliases),
    ).toEqual(["LLM"]);
  });

  test("an alias translates a tag", () => {
    const aliases = tagAliases({ "reinforcement learning": "强化学习" });
    expect(writableTags(["Reinforcement-Learning"], aliases)).toEqual([
      "强化学习",
    ]);
  });

  test("filters before it caps", () => {
    // A reply that leads with tags this drops still gets its full allowance.
    const offered = ["ア", "イ", "ウ", "a", "b", "c", "d", "e", "f", "g"];
    expect(writableTags(offered, none)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"].slice(0, TAG_LIMIT),
    );
  });
});

describe("writableTags with a vocabulary", () => {
  const none = new Map<string, string | null>();
  const known = ["Rust", "数据库", "性能", "安全"];

  test(`keeps every listed tag and at most ${MAX_NEW_TAGS} new ones`, () => {
    const logs: string[] = [];
    expect(
      writableTags(
        ["Rust", "借用检查", "数据库", "生命周期", "arena", "WASM"],
        none,
        (m) => logs.push(m),
        known,
      ),
    ).toEqual(["Rust", "借用检查", "数据库", "生命周期", "arena"]);
    expect(logs).toEqual([
      `left out new tag(s) past the ${MAX_NEW_TAGS} allowed: WASM`,
    ]);
  });

  test("never leaves an article with fewer than three for want of a listed tag", () => {
    // An article on a topic the vault has never seen still gets its tags.
    expect(
      writableTags(
        ["Zig", "comptime", "分配器", "WASM"],
        none,
        () => {},
        known,
      ),
    ).toEqual(["Zig", "comptime", "分配器"]);
  });

  test("an empty vocabulary caps nothing", () => {
    expect(writableTags(["a", "b", "c", "d"], none, () => {}, [])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("a spelling variant of a listed tag counts as listed", () => {
    expect(
      writableTags(["rust", "x", "y", "z", "w"], none, () => {}, known),
    ).toEqual(["Rust", "x", "y", "z"]);
  });

  test("a topic the article already carries is not new", () => {
    // Reprocessing an article must not prune what it was about (ADR 0035):
    // the entropy article kept `熵` and `时间之箭` though neither recurs.
    expect(
      writableTags(
        ["Rust", "熵", "热力学", "统计力学", "时间之箭"],
        none,
        () => {},
        known,
        { current: ["熵", "时间之箭"] },
      ),
    ).toEqual(["Rust", "熵", "热力学", "统计力学", "时间之箭"]);
  });

  test("a caller translating tags can lift the cap, not the limit", () => {
    const offered = ["一", "二", "三", "四", "五", "六", "七"];
    expect(
      writableTags(offered, none, () => {}, known, {
        maxNew: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(offered.slice(0, TAG_LIMIT));
  });
});

describe("buildVocabulary", () => {
  const none = new Map<string, string | null>();

  test("keeps tags that recur, most used first", () => {
    expect(
      buildVocabulary(
        [["Rust", "数据库"], ["Rust", "安全"], ["Rust", "数据库"], ["一次性"]],
        none,
      ),
    ).toEqual(["Rust", "数据库"]);
  });

  test("counts an article once, however it spelled a tag", () => {
    expect(
      buildVocabulary([["Open-Source", "Open Source"], ["Zig"]], none),
    ).toEqual([]);
    expect(buildVocabulary([["Open-Source"], ["Open_Source"]], none)).toEqual([
      "Open Source",
    ]);
  });

  test("offers each tag in the spelling most of the vault uses", () => {
    expect(buildVocabulary([["Git"], ["GIT"], ["Git"]], none)).toEqual(["Git"]);
    // A tie goes by code point, never by the order the vault was read in.
    expect(buildVocabulary([["Git"], ["GIT"]], none)).toEqual(["GIT"]);
    // An alias settles it outright, however few articles use its spelling.
    const aliases = tagAliases({ "large language models": "LLM" });
    expect(buildVocabulary([["llm"], ["llm"], ["llm"]], aliases)).toEqual([
      "LLM",
    ]);
  });

  test("leaves out kana, hangul and undecided tags", () => {
    // Offered as "reuse exactly as written", the vault's lowercase English
    // would pull every new article back to English (ADR 0035).
    const list = ["知识管理", "ベクトル", "digital habits"];
    expect(buildVocabulary([list, list], none)).toEqual(["知识管理"]);
  });

  test("an alias decides a lowercase tag", () => {
    expect(
      buildVocabulary([["npm"], ["npm"]], tagAliases({ npm: "npm" })),
    ).toEqual(["npm"]);
  });

  test("merges through the aliases", () => {
    const aliases = tagAliases({ "large language models": "LLM" });
    expect(
      buildVocabulary([["llm"], ["large language models"]], aliases),
    ).toEqual(["LLM"]);
  });

  test("breaks ties by spelling, so the list is stable", () => {
    expect(
      buildVocabulary(
        [
          ["B", "A"],
          ["A", "B"],
        ],
        none,
      ),
    ).toEqual(["A", "B"]);
  });

  test(`offers at most ${VOCABULARY_LIMIT}`, () => {
    const tags = Array.from(
      { length: VOCABULARY_LIMIT + 10 },
      (_, i) => `T${i}`,
    );
    expect(buildVocabulary([tags, tags], none)).toHaveLength(VOCABULARY_LIMIT);
  });
});

describe("undecidedTags", () => {
  test("lists them with their counts, most carried first", () => {
    expect(
      undecidedTags(
        [["digital habits", "熵", "rss"], ["digital habits", "npm"], ["Git"]],
        tagAliases({ npm: "npm" }),
      ),
    ).toEqual([
      { tag: "digital habits", articles: 2 },
      { tag: "rss", articles: 1 },
    ]);
  });
});
