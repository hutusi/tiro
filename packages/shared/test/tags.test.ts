import { describe, expect, test } from "bun:test";
import { tagSlug } from "../src/slug.ts";
import {
  aliasProblems,
  normalizeTag,
  normalizeTags,
  TAG_LIMIT,
  tagAliases,
  tagFormProblems,
  tagKey,
} from "../src/tags.ts";

describe("normalizeTag", () => {
  test("one spelling for the variants the vault actually holds", () => {
    for (const variant of [
      "open source",
      "open-source",
      "open_source",
      "  open   source ",
      "#open-source",
      '"open source"',
    ]) {
      expect(normalizeTag(variant)).toBe("open source");
    }
  });

  test("keeps case, which the key compares away", () => {
    // ADR 0035: `AI安全`, not `ai安全`. Case is how a tag is written, and
    // never what makes two tags different.
    for (const tag of ["AI安全", "Git", "OpenAI", "LLM", "强化学习"]) {
      expect(normalizeTag(tag)).toBe(tag);
    }
    expect(normalizeTag("Open-Source")).toBe("Open Source");
    expect(tagKey("Open-Source")).toBe("open source");
    expect(tagKey("AI安全")).toBe(tagKey("ai 安全"));
  });

  test("takes no gap beside a Chinese character", () => {
    for (const variant of [
      "AI安全",
      "AI 安全",
      "AI-安全",
      "AI_安全",
      "ＡＩ　安全",
    ]) {
      expect(normalizeTag(variant)).toBe("AI安全");
    }
    expect(normalizeTag("强化 学习")).toBe("强化学习");
    // Before the digit rule, which would otherwise keep the second hyphen.
    expect(normalizeTag("GPT-4 发布")).toBe("GPT-4发布");
    expect(normalizeTag("GPT-4-发布")).toBe("GPT-4发布");
    expect(normalizeTag("C++ 模板")).toBe("C++模板");
    // Korean is written with spaces between words.
    expect(normalizeTag("인공 지능")).toBe("인공 지능");
  });

  test("drops Chinese punctuation around a tag", () => {
    expect(normalizeTag("「熵」")).toBe("熵");
    expect(normalizeTag("『熵』")).toBe("熵");
    expect(normalizeTag("热力学。")).toBe("热力学");
    expect(normalizeTag("热力学、")).toBe("热力学");
  });

  test("keeps a hyphen that is part of a name", () => {
    // Beside a digit a hyphen is a version or a model, not a join between
    // words — the live vault has gpt-2, eupl-1.2, l2-cache and z3-solver.
    expect(normalizeTag("GPT-4")).toBe("GPT-4");
    expect(normalizeTag("utf-8")).toBe("utf-8");
    expect(normalizeTag("l2-cache")).toBe("l2-cache");
    expect(normalizeTag("gpt-6 astra")).toBe("gpt-6 astra");
    expect(normalizeTag("x86-64")).toBe("x86-64");
  });

  test("keeps punctuation that means something", () => {
    for (const tag of [
      "c++",
      "c#",
      "node.js",
      "ci/cd",
      "async/await",
      "llama.cpp",
      ".name tld",
      "fermat's last theorem",
    ]) {
      expect(normalizeTag(tag)).toBe(tag);
    }
  });

  test("drops sentence punctuation off the end", () => {
    expect(normalizeTag("security.")).toBe("security");
    expect(normalizeTag("privacy;")).toBe("privacy");
  });

  test("folds full-width forms", () => {
    expect(normalizeTag("ＡＩ")).toBe("AI");
  });

  test("can come out empty", () => {
    expect(normalizeTag(" # ")).toBe("");
    expect(normalizeTag("-")).toBe("");
  });

  test("is idempotent", () => {
    for (const raw of [
      "Open-Source",
      "GPT-4",
      "#C#.",
      "a - b",
      "state-of-the-art",
      "ai安全",
      '"quoted"',
      "AI 安全",
      "GPT-4 发布",
      "「熵」 ",
      "C++ 模板",
    ]) {
      const once = normalizeTag(raw);
      expect(normalizeTag(once)).toBe(once);
    }
  });

  test("never moves a tag off the page its variants shared", () => {
    // The site groups tags by slug. Normalizing must not split a group that
    // already existed, or an article would drop off a tag page it was on.
    for (const raw of [
      "Open-Source",
      "open source",
      "AI Safety",
      "ci/cd",
      "AI 安全",
      "AI-安全",
      "AI_安全",
      "AI/安全",
      "GPT-4 发布",
      "C++ 模板",
      "ＡＩ　安全",
    ]) {
      expect(tagSlug(normalizeTag(raw))).toBe(tagSlug(raw));
    }
  });
});

describe("tagAliases and normalizeTags", () => {
  test("an alias matches however either side is spelled", () => {
    const aliases = tagAliases({ "Large-Language-Models": "LLM" });
    expect(normalizeTags(["large language models"], aliases)).toEqual(["LLM"]);
    expect(normalizeTags(["LARGE language MODELS"], aliases)).toEqual(["LLM"]);
  });

  test("an alias's target is how the vault spells that tag", () => {
    // The vault's forty `llm` tags would otherwise outvote the table's `LLM`.
    const aliases = tagAliases({ "large language models": "LLM" });
    expect(normalizeTags(["llm"], aliases)).toEqual(["LLM"]);
    const respell = tagAliases({ ai: "AI", "ai safety": "AI安全" });
    expect(normalizeTags(["ai", "ai 安全", "AI Safety"], respell)).toEqual([
      "AI",
      "AI安全",
    ]);
  });

  test("respelling under a sound table changes nothing the second time", () => {
    const aliases = tagAliases({
      ai: "AI",
      "reinforcement learning": "强化学习",
      "ai safety": "AI安全",
      ai安全: "AI安全",
      misc: null,
    });
    const once = normalizeTags(
      ["ai", "Reinforcement-Learning", "ai安全", "misc", "熵"],
      aliases,
    );
    expect(once).toEqual(["AI", "强化学习", "AI安全", "熵"]);
    expect(normalizeTags(once, aliases)).toEqual(once);
  });

  test("null drops a tag", () => {
    const aliases = tagAliases({ misc: null });
    expect(normalizeTags(["misc", "rust"], aliases)).toEqual(["rust"]);
  });

  test("an alias is one hop, not a chain", () => {
    const aliases = tagAliases({ a: "b", b: "c" });
    expect(normalizeTags(["a"], aliases)).toEqual(["b"]);
  });

  test("drops empties and duplicates, keeping first spellings and positions", () => {
    expect(
      normalizeTags(["Rust", "", "#", "rust", "Open-Source", "open source"]),
    ).toEqual(["Rust", "Open Source"]);
    expect(normalizeTags(["AI安全", "ai 安全"])).toEqual(["AI安全"]);
  });

  test("an alias that merges two tags leaves one", () => {
    const aliases = tagAliases({ "large language models": "llm" });
    expect(normalizeTags(["llm", "large language models"], aliases)).toEqual([
      "llm",
    ]);
  });

  test(`caps the list at ${TAG_LIMIT}`, () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(normalizeTags(many)).toEqual(many.slice(0, TAG_LIMIT));
  });
});

describe("tagFormProblems", () => {
  test("canonical tags, in any language, are fine", () => {
    // Language is the processor's policy, not the contract: a person may
    // give an article a tag in any script.
    expect(tagFormProblems(["rust", "gpt-4", "ci/cd", "知识管理"])).toEqual([]);
  });

  test("names a tag that is not in canonical form, and its canonical form", () => {
    expect(tagFormProblems(["Open-Source"])).toEqual([
      'tag "Open-Source" is not in canonical form ("Open Source")',
    ]);
    expect(tagFormProblems(["AI 安全"])).toEqual([
      'tag "AI 安全" is not in canonical form ("AI安全")',
    ]);
  });

  test("takes any case as canonical", () => {
    expect(tagFormProblems(["AI安全", "Git", "强化学习", "llm"])).toEqual([]);
  });

  test("names a tag listed twice, however it was spelled", () => {
    expect(tagFormProblems(["rust", "rust"])).toEqual([
      'tag "rust" is listed more than once',
    ]);
    expect(tagFormProblems(["open source", "open-source"])).toContain(
      'tag "open-source" is listed more than once',
    );
    expect(tagFormProblems(["AI", "ai"])).toEqual([
      'tag "ai" is listed more than once',
    ]);
  });

  test("names a tag that normalizes to nothing", () => {
    expect(tagFormProblems(["#"])).toEqual([
      'tag "#" is empty once normalized',
    ]);
  });

  test("names an empty tag, which is its own canonical form", () => {
    // The trap: "" normalizes to "", so a check that only asks "did
    // normalizing change it?" accepts it, and the site renders a blank chip.
    expect(tagFormProblems([""])).toEqual(['tag "" is empty']);
    expect(tagFormProblems(["rust", ""])).toEqual(['tag "" is empty']);
    expect(tagFormProblems(["", ""])).toEqual([
      'tag "" is empty',
      'tag "" is empty',
    ]);
  });

  test(`counts more than ${TAG_LIMIT}`, () => {
    const tags = ["a", "b", "c", "d", "e", "f", "g"];
    expect(tagFormProblems(tags)).toEqual([`7 tags, at most ${TAG_LIMIT}`]);
  });
});

describe("aliasProblems", () => {
  test("a sound table, respellings included, has none", () => {
    expect(
      aliasProblems({
        ai: "AI",
        "ai safety": "AI安全",
        ai安全: "AI安全",
        "large language models": "LLM",
        misc: null,
      }),
    ).toEqual([]);
  });

  test("names two entries for one tag", () => {
    expect(aliasProblems({ AI: "人工智能", ai: "AI" })).toEqual([
      'aliases "AI" and "ai" name the same tag',
    ]);
  });

  test("names a chain, and a cycle, which would rewrite a tag every run", () => {
    expect(aliasProblems({ a: "B", b: "C" })).toEqual([
      'alias "a" → "B", but "b" → "C": a tag it writes would be rewritten again',
    ]);
    expect(aliasProblems({ a: "b", b: "a" })).toHaveLength(2);
    expect(aliasProblems({ a: "B", b: null })).toHaveLength(1);
  });

  test("names one tag spelled two ways", () => {
    expect(aliasProblems({ x: "Git", y: "git" })).toEqual([
      'aliases "x" and "y" spell one tag two ways: "Git" and "git"',
    ]);
  });
});
