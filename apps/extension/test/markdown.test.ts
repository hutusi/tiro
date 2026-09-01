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

describe("figureRule", () => {
  const captioned = `<figure>
      <img src="/img/a.png" alt="A diagram" class="rounded" srcset="/img/a@2x.png 2x">
      <figcaption>
        Autoregressive LLMs generate one token at a time.
        Figure credit: <a href="https://ex.com">M. Grootendorst</a>.
      </figcaption>
    </figure>`;

  test("emits one html block, so alignment is unaffected", () => {
    const markdown = clip(captioned).trim();
    const blocks = splitBlocks(markdown);
    expect(blocks.map((b) => b.type)).toEqual(["html"]);
  });

  test("keeps the caption with the image and preserves its links", () => {
    const markdown = clip(captioned).trim();
    expect(markdown).toContain("<figcaption>");
    expect(markdown).toContain('<a href="https://ex.com">M. Grootendorst</a>');
    expect(markdown).toContain('<img src="/img/a.png" alt="A diagram">');
  });

  test("drops attributes the site's sanitize schema would strip anyway", () => {
    const markdown = clip(captioned);
    expect(markdown).not.toContain("srcset");
    expect(markdown).not.toContain("rounded");
  });

  test("contains no blank line, which would split the html block", () => {
    // A blank line ends a CommonMark type-6 HTML block.
    expect(clip(captioned).trim()).not.toMatch(/\n[ \t]*\n/);
  });

  test("leaves an uncaptioned figure as a plain markdown image", () => {
    const markdown = clip(
      '<figure><img src="/img/a.png" alt="cap"></figure>',
    ).trim();
    expect(markdown).toBe("![cap](/img/a.png)");
  });

  test("escapes quotes in attributes", () => {
    const markdown = clip(
      '<figure><img src="/a.png" alt=\'He said "hi"\'><figcaption>C</figcaption></figure>',
    );
    expect(markdown).toContain('alt="He said &quot;hi&quot;"');
  });

  test("survives a figure wrapping a picture", () => {
    const markdown = clip(
      '<figure><picture>\n  <source srcset="s.avif">\n  <img src="/a.png" alt="x">\n</picture><figcaption>Cap</figcaption></figure>',
    ).trim();
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["html"]);
    expect(markdown).toContain('<img src="/a.png" alt="x">');
  });
});

describe("figureRule inside a link", () => {
  test("falls back to markdown, so the link is not filled with raw HTML", () => {
    // inlineLinkRule flattens a link's content, which would otherwise produce
    // `[<figure>…</figure>](href)` — a paragraph, not an html block.
    const markdown = clip(
      '<a href="https://ex.com/full"><figure><img src="/a.png" alt="x"><figcaption>Cap</figcaption></figure></a>',
    ).trim();
    expect(markdown).not.toContain("<figure>");
    expect(markdown).toContain("![x](/a.png)");
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["paragraph"]);
  });
});

describe("figureRule limits", () => {
  test("falls back to markdown when the caption holds a formula", () => {
    // Markdown is not parsed inside an HTML block, so `$…$` would publish as
    // literal dollars, and the marker span loses its attribute to the site's
    // sanitize schema and renders as bare glyphs. The formula is worth more
    // than the figure semantics.
    const markdown = clip(
      '<figure><img src="/a.png" alt="x"><figcaption>Loss <span class="katex"><annotation encoding="application/x-tex">L(x)</annotation></span> curve</figcaption></figure>',
    ).trim();
    expect(markdown).not.toContain("<figure>");
    expect(markdown).toContain("$L(x)$");
  });

  test("keeps a link wrapping the image inside the figure", () => {
    // The common lightbox shape. Rebuilding from the image alone dropped the
    // link to the full-size version entirely.
    const markdown = clip(
      '<figure><a href="https://ex.com/full.png"><img src="/thumb.png" alt="x"></a><figcaption>Cap</figcaption></figure>',
    ).trim();
    expect(markdown).toContain('<a href="https://ex.com/full.png">');
    expect(markdown).toContain('<img src="/thumb.png" alt="x">');
    expect(splitBlocks(markdown).map((b) => b.type)).toEqual(["html"]);
  });
});
