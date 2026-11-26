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

  // A title is the title's text, not more address: a `(` in one used to open
  // a group that never closed, and the whole address stayed in the count —
  // 535 characters for a link labelled "Map", over the thin-page threshold
  // on its own.
  test("a parenthesis in a title leaves the address out all the same", () => {
    const address = `https://maps.example.com/${"segment/".repeat(60)}`;
    for (const title of [
      '"Opening parenthesis ("',
      '"closing )"',
      '"a (b) c"',
      String.raw`"say \"hi\" ("`,
      "'single ('",
      "(parenthesized \\()",
    ]) {
      expect(readableChars(`[Map](${address} ${title})`)).toBe("Map".length);
      expect(readableChars(`![m](${address} ${title}) Rome`)).toBe(
        "Rome".length,
      );
    }
  });

  // Turndown escapes brackets in an alt, and the picture still goes whole.
  test("an alt with escaped brackets goes with its picture", () => {
    expect(
      readableChars("![map \\[north\\]](https://x.example/m.png) Rome"),
    ).toBe("Rome".length);
  });

  // Each of these used to scan on to the end of the text from every opener —
  // 50,000 pictures that never close took ~3 s, and 40,000 of `a < b` 1.8 s,
  // in the popup, as it renders.
  test("stays fast on a run of openers that never close", () => {
    for (const unit of [
      "![ x",
      "a < b ",
      "<!-- ",
      '](x "',
      "](x (",
      "](  ",
      '<a b="<',
      "<a '",
    ]) {
      const started = performance.now();
      readableChars(unit.repeat(50_000));
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test("an HTML tag still goes, and a lone `<` stays as text", () => {
    expect(readableChars("a <sup>2</sup> < b")).toBe("a 2 < b".length);
  });

  // A Markdown file's clip keeps its raw HTML. A `<` in an attribute used to
  // start the tag over, leaving the `src` before it counted: 523 characters
  // for one picture.
  test("a `<` or `>` in a quoted attribute stays inside its tag", () => {
    const src = `https://cdn.example.com/${"segment/".repeat(60)}m.png`;
    for (const alt of ['"x < y"', '"x > y"', "'x < y'", `"it's < 1"`]) {
      expect(readableChars(`<img src="${src}" alt=${alt}> Rome`)).toBe(
        "Rome".length,
      );
    }
  });

  // A tag starts with its name: a comparison in prose is text, and a quote
  // after it cannot carry a "tag" on across the sentence.
  test("a comparison in prose stays text", () => {
    expect(readableChars('if a < b and "c > d" then e > f')).toBe(
      'if a < b and "c d" then e f'.length,
    );
  });

  test("an empty or markup-only clip has nothing to read", () => {
    expect(readableChars("")).toBe(0);
    expect(readableChars("<div></div>\n\n---\n")).toBe(0);
  });
});
