import { describe, expect, test } from "bun:test";
import { readingMinutes } from "../src/reading-time.ts";

const words = (n: number): string => Array(n).fill("word").join(" ");
const cjk = (n: number): string => "字".repeat(n);

describe("readingMinutes", () => {
  test("never reports less than a minute", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("Hi.")).toBe(1);
  });

  test("counts Latin text at 250 words a minute", () => {
    expect(readingMinutes(words(250))).toBe(1);
    expect(readingMinutes(words(600))).toBe(2);
    expect(readingMinutes(words(1000))).toBe(4);
  });

  test("counts CJK text per character at 400 a minute", () => {
    expect(readingMinutes(cjk(400))).toBe(1);
    expect(readingMinutes(cjk(1000))).toBe(3);
  });

  test("adds the two for mixed text", () => {
    expect(readingMinutes(`${words(250)}\n\n${cjk(400)}`)).toBe(2);
  });

  test("keeps a hyphenated or possessive word as one", () => {
    expect(readingMinutes(`${words(249)} read-it-later`)).toBe(1);
    expect(readingMinutes(`${words(249)} Tiro's`)).toBe(1);
  });

  test("markdown syntax alone is not reading", () => {
    expect(readingMinutes("## \n\n---\n\n> \n\n![](x.png)")).toBe(1);
  });
});
