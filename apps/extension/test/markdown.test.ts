import { describe, expect, test } from "bun:test";
import { splitBlocks } from "@tiro/shared";
import { Window } from "happy-dom";
import { prepareForClipping } from "../src/dom-prepare.ts";
import { htmlToMarkdown } from "../src/markdown.ts";

/** Scoped window, matching dom-prepare.test.ts — no global `document` leak. */
function clip(html: string): string {
  const window = new Window();
  window.document.body.innerHTML = html;
  prepareForClipping(window.document as unknown as Document);
  return htmlToMarkdown(window.document.body.innerHTML).markdown;
}

describe("unwrapPictures", () => {
  /**
   * The real shape from unsung.aresluna.org: the page pretty-prints
   * `<picture>`, so every child sits on its own indented line.
   */
  const prettyPrinted = `<figure id="fig"><picture>
        <source media="(resolution >= 2x) and (width >= 700px)" srcset="_media/1.2096w.avif" type="image/avif">
        <source srcset="_media/1.1088w.avif" type="image/avif">
        <source srcset="_media/1.1088w.jpg" type="image/jpeg">
        <img src="_media/1.1088w.avif" alt="">
      </picture></figure>`;

  test("keeps the image out of an indented code block", () => {
    const markdown = clip(prettyPrinted);
    // Four leading spaces would make markdown read this as code, and the site
    // would render the literal `![](…)` in a highlighted box instead.
    expect(markdown).not.toMatch(/^ {4,}!\[/m);
    expect(markdown.trim()).toBe("![](_media/1.1088w.avif)");
    expect(splitBlocks(markdown.trim()).map((b) => b.type)).toEqual([
      "paragraph",
    ]);
  });

  test("drops the <source> candidates, keeping the nominated fallback", () => {
    const markdown = clip(prettyPrinted);
    expect(markdown).not.toContain("2096w");
    expect(markdown).not.toContain("srcset");
  });

  test("preserves alt text", () => {
    const markdown = clip(
      '<p><picture>\n  <source srcset="s.avif">\n  <img src="a.png" alt="a caption">\n</picture></p>',
    );
    expect(markdown.trim()).toBe("![a caption](a.png)");
  });

  test("leaves a picture with no <img> for Readability to discard", () => {
    const markdown = clip('<p><picture><source srcset="s.avif"></picture></p>');
    expect(markdown.trim()).toBe("");
  });

  test("keeps a bare image working", () => {
    expect(clip('<p><img src="a.png" alt="cap"></p>').trim()).toBe(
      "![cap](a.png)",
    );
  });
});
