import { describe, expect, test } from "bun:test";
import { countWords, readableChars } from "../src/words.ts";

describe("countWords", () => {
  test("counts English words by whitespace", () => {
    expect(countWords("one two  three")).toBe(3);
  });

  test("counts each Chinese character, not one per paragraph", () => {
    // The regression this guards: spaceless prose split on whitespace is
    // one giant token, and the popup showed "1 词" for a full article.
    expect(countWords("中文没有空格")).toBe(6);
  });

  test("counts kana per character too", () => {
    expect(countWords("テスト")).toBe(3);
  });

  test("mixed prose sums both conventions", () => {
    expect(countWords("使用 Bun 构建")).toBe(5);
  });

  test("standalone punctuation is not a word", () => {
    // CJK punctuation is Script=Common, so it survives the Han replacement
    // as its own token; markdown leaves — and ## standing alone likewise.
    expect(countWords("中文，测试。 — hello!")).toBe(5);
  });

  test("empty text counts zero", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  \n ")).toBe(0);
  });
});

describe("readableChars (ADR 0055)", () => {
  test("counts the words a reader reads, not the markup around them", () => {
    expect(readableChars("# Map\n\nDrag the **timeline**.")).toBe(
      "Map Drag the timeline .".length,
    );
  });

  test("leaves out pictures and link targets", () => {
    const md =
      "![a legend](https://cdn.example.com/very/long/path/legend.png)\n\n[Battles](https://maps.example.com/battles/of/the/roman/republic)";
    expect(readableChars(md)).toBe("Battles".length);
  });

  // The clipper escapes parentheses in an address; Markdown also allows them
  // balanced. Either way the whole address goes, not just up to the first `)`.
  test("an address with parentheses in it goes in full", () => {
    expect(
      readableChars(
        "[Cannae](https://en.wikipedia.org/wiki/Cannae_\\(battle\\)/talk/archive)",
      ),
    ).toBe("Cannae".length);
    expect(
      readableChars("![map](https://cdn.example.com/a_(b)/c/legend.png) Rome"),
    ).toBe("Rome".length);
    expect(readableChars("[a](<https://x.example/a b\\(1\\)>) b")).toBe(
      "a b".length,
    );
  });

  test("an empty or markup-only clip has nothing to read", () => {
    expect(readableChars("")).toBe(0);
    expect(readableChars("<div></div>\n\n---\n")).toBe(0);
  });
});
