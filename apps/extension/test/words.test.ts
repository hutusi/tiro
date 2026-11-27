import { describe, expect, test } from "bun:test";
import { readableText, THIN_PAGE_CHARS } from "@tiro/shared";
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
      "Map Drag the timeline.".length,
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

  // Only the opening is read, so a long clip costs what 16 KB costs, once:
  // the popup asks on every render.
  test("a long clip is judged by its opening, once", () => {
    const paragraph = `Some prose with a [link](https://example.com/a/b) and **bold** words. ${"More words to read. ".repeat(20)}`;
    const article = `${paragraph}\n\n`.repeat(1_000);
    expect(article.length).toBeGreaterThan(400_000);
    let started = performance.now();
    const count = readableChars(article);
    // ~6 ms for the opening against ~250 ms for all of it, here.
    expect(performance.now() - started).toBeLessThan(100);
    started = performance.now();
    expect(readableChars(article)).toBe(count);
    expect(performance.now() - started).toBeLessThan(5);
    expect(count).toBeGreaterThanOrEqual(THIN_PAGE_CHARS);
    expect(count).toBeLessThan(readableText(article).length / 10);
  });

  // A table has no blank line to cut at, and the parser is slower than
  // linear on one: 3,000 rows took 1.2 s before its controls painted.
  test("a long table never holds the popup up", () => {
    const table = `| # | link | value |\n|---|---|---|\n${Array.from(
      { length: 3_000 },
      (_, i) => `| ${i} | https://example.com/item/${i} | value ${i} |\n`,
    ).join("")}`;
    const started = performance.now();
    expect(readableChars(table)).toBeGreaterThanOrEqual(THIN_PAGE_CHARS);
    expect(performance.now() - started).toBeLessThan(300);
  });

  // A paragraph is one line, and Chinese has no spaces: cutting at the last
  // line break read a 17 KB transcript as its 10-character heading.
  test("one long paragraph is read up to the limit", () => {
    for (const [heading, words] of [
      ["# Transcript", "and then we talked about the map "],
      ["# 访谈实录", "我们接着谈到了那张地图的来历"],
    ] as const) {
      const md = `${heading}\n\n${words.repeat(Math.ceil(18_000 / words.length))}`;
      expect(md.length).toBeGreaterThan(16_000);
      expect(readableChars(md)).toBeGreaterThan(15_000);
    }
  });

  // A thin page can still be a long Markdown file: a gallery of 300 pictures
  // reads nothing at all, however much of it there is.
  test("a long gallery has nothing to read", () => {
    const gallery = Array.from(
      { length: 300 },
      (_, i) =>
        `![photo ${i}](https://cdn.example.com/${"x".repeat(80)}/${i}.jpg)`,
    ).join("\n\n");
    expect(gallery.length).toBeGreaterThan(16_000);
    expect(readableChars(gallery)).toBe(0);
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
      'if a < b and "c > d" then e > f'.length,
    );
  });

  // Round three of the review, each a case the patterns could not see and
  // the parser reads as a reader would.
  test("an address on the line after its label is left out", () => {
    const address = `https://maps.example.com/${"segment/".repeat(60)}`;
    expect(readableChars(`[Map](\n${address})`)).toBe("Map".length);
    expect(readableChars(`[Map](  ${address} )`)).toBe("Map".length);
  });

  test("an attribute value may run across lines", () => {
    const src = `https://cdn.example.com/${"segment/".repeat(60)}m.png`;
    expect(readableChars(`<img src="${src}" alt="a map\nof Rome">`)).toBe(0);
  });

  test("a comment is hidden whatever it holds", () => {
    const address = `https://maps.example.com/${"segment/".repeat(60)}`;
    expect(
      readableChars(`<!-- Don't edit this file. ${address} -->\n\nMap`),
    ).toBe("Map".length);
    expect(readableChars(`<!-- it's -->\n\n[Map](${address})`)).toBe(
      "Map".length,
    );
  });

  // A README's badges and links are usually references, defined at its foot.
  test("a reference's definition is an address too", () => {
    const address = `https://maps.example.com/${"segment/".repeat(60)}`;
    expect(
      readableChars(
        `[![build](https://img.shields.io/badge/b)][ci] [Map][map]\n\n[ci]: ${address}\n[map]: ${address}`,
      ),
    ).toBe("Map".length);
  });

  test("an empty or markup-only clip has nothing to read", () => {
    expect(readableChars("")).toBe(0);
    expect(readableChars("<div></div>\n\n---\n")).toBe(0);
  });
});
