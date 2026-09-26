import { describe, expect, test } from "bun:test";
import { tagSlug } from "../src/slug.ts";
import {
  normalizeTag,
  normalizeTags,
  TAG_LIMIT,
  tagAliases,
} from "../src/tags.ts";

describe("normalizeTag", () => {
  test("one spelling for the variants the vault actually holds", () => {
    for (const variant of [
      "open source",
      "open-source",
      "Open-Source",
      "open_source",
      "  open   source ",
      "#open-source",
      '"open source"',
    ]) {
      expect(normalizeTag(variant)).toBe("open source");
    }
  });

  test("keeps a hyphen that is part of a name", () => {
    // Beside a digit a hyphen is a version or a model, not a join between
    // words — the live vault has gpt-2, eupl-1.2, l2-cache and z3-solver.
    expect(normalizeTag("GPT-4")).toBe("gpt-4");
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
    expect(normalizeTag("ＡＩ")).toBe("ai");
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
    ]) {
      const once = normalizeTag(raw);
      expect(normalizeTag(once)).toBe(once);
    }
  });

  test("never moves a tag off the page its variants shared", () => {
    // The site groups tags by slug. Normalizing must not split a group that
    // already existed, or an article would drop off a tag page it was on.
    for (const raw of ["Open-Source", "open source", "AI Safety", "ci/cd"]) {
      expect(tagSlug(normalizeTag(raw))).toBe(tagSlug(raw));
    }
  });
});

describe("tagAliases and normalizeTags", () => {
  test("an alias matches however either side is spelled", () => {
    const aliases = tagAliases({ "Large-Language-Models": "LLM" });
    expect(normalizeTags(["large language models"], aliases)).toEqual(["llm"]);
  });

  test("null drops a tag", () => {
    const aliases = tagAliases({ misc: null });
    expect(normalizeTags(["misc", "rust"], aliases)).toEqual(["rust"]);
  });

  test("an alias is one hop, not a chain", () => {
    const aliases = tagAliases({ a: "b", b: "c" });
    expect(normalizeTags(["a"], aliases)).toEqual(["b"]);
  });

  test("drops empties and duplicates, keeping first positions", () => {
    expect(
      normalizeTags(["Rust", "", "#", "rust", "Open-Source", "open source"]),
    ).toEqual(["rust", "open source"]);
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
