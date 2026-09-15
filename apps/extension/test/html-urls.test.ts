import { describe, expect, test } from "bun:test";
import { srcsetUrlRanges, urlAttributeRanges } from "../src/html-urls.ts";

describe("urlAttributeRanges", () => {
  const found = (html: string): string[] =>
    urlAttributeRanges(html).map(
      (a) => `${a.name}=${html.slice(a.start, a.end)}`,
    );

  test.each([
    ['<p align="center"><img src="logo.png"></p>', ["src=logo.png"]],
    ["<img src='logo.png'>", ["src=logo.png"]],
    ['<img SRC="x.png">', ["src=x.png"]],
    ['<img src="x.png"/>', ["src=x.png"]],
    ['<a href="a.md">x</a>', ["href=a.md"]],
    ['<source srcset="d.png 2x">', ["srcset=d.png 2x"]],
  ])("reads %s", (html, expected) => {
    expect(found(html)).toEqual(expected);
  });

  /**
   * Why this is a walk and not a pattern. `src=` appears inside other
   * attributes, so teaching a regex to accept unquoted values — which is what
   * the first case below needs — would have made it rewrite alt text. Reading
   * names and values as units gets both right at once.
   */
  test("resolves an unquoted value", () => {
    expect(found("<img src=logo.png>")).toEqual(["src=logo.png"]);
  });

  test("does not mistake an attribute's contents for an attribute", () => {
    expect(found('<img alt="src=x.png" src="y.png">')).toEqual(["src=y.png"]);
  });

  test("does not match a name that merely ends in one", () => {
    expect(found('<img data-src="skip.png" src="take.png">')).toEqual([
      "src=take.png",
    ]);
  });

  // A comment can hold a whole tag, and rewriting inside one changes text
  // nobody renders.
  test("skips comments and declarations", () => {
    expect(found('<!-- <img src="a.png"> --><img src="b.png">')).toEqual([
      "src=b.png",
    ]);
    expect(found('<!DOCTYPE html><img src="b.png">')).toEqual(["src=b.png"]);
  });

  test("a quoted value may contain the tag's closing bracket", () => {
    expect(found('<a href="a>b.md">x</a>')).toEqual(["href=a>b.md"]);
  });

  // `5 < 6` is prose, not a tag.
  test("ignores a bare less-than", () => {
    expect(found('5 < 6 and <img src="z.png">')).toEqual(["src=z.png"]);
  });

  test("does not run past the end of an unterminated tag", () => {
    expect(found('<img src="unterminated.png')).toEqual([
      "src=unterminated.png",
    ]);
  });

  test("finds nothing in a tag that addresses nothing", () => {
    expect(found('<div class="x">text</div>')).toEqual([]);
  });
});

describe("srcsetUrlRanges", () => {
  const urls = (value: string): string[] =>
    srcsetUrlRanges(value).map((r) => value.slice(r.start, r.end));

  /**
   * The bug this replaced. Splitting on every comma is the obvious reading and
   * the wrong one — it treated the base64 payload as a separate relative path
   * and absolutized it, destroying the image rather than failing to fix it.
   */
  test("a data URL is one candidate, commas and all", () => {
    expect(urls("data:image/png;base64,AAAA 1x, logo.png 2x")).toEqual([
      "data:image/png;base64,AAAA",
      "logo.png",
    ]);
  });

  test("a query string may hold commas too", () => {
    expect(urls("a.png?w=1,2 1x")).toEqual(["a.png?w=1,2"]);
  });

  test.each([
    ["a.png, b.png", ["a.png", "b.png"]],
    ["a.png 1x,b.png 2x", ["a.png", "b.png"]],
    ["  logo.png  ", ["logo.png"]],
    ["only.png", ["only.png"]],
    ["", []],
  ])("splits %s", (value, expected) => {
    expect(urls(value)).toEqual(expected);
  });

  // Only a *trailing* comma ends a candidate, so this is one URL — which is
  // what a browser reads too.
  test("commas inside a token do not split it", () => {
    expect(urls("a.png,,b.png")).toEqual(["a.png,,b.png"]);
  });
});
