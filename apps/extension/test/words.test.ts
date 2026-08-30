import { describe, expect, test } from "bun:test";
import { countWords } from "../src/words.ts";

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
