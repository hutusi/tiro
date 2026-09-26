import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipMarkdownFile, clipPage } from "../src/clip-page.ts";

/**
 * A scoped window rather than happy-dom's global registrator: bun runs every
 * test file in one process, and installing `document` globally would leak into
 * suites that deliberately have no DOM.
 */
function viewerFor(text: string): Document {
  const window = new Window();
  // What Chrome builds for text/plain: the file, in one <pre>, and nothing
  // else in the body.
  window.document.body.innerHTML = "<pre></pre>";
  const pre = window.document.body.firstElementChild;
  if (pre !== null) pre.textContent = text;
  return window.document as unknown as Document;
}

const RAW =
  "https://raw.githubusercontent.com/o/r/refs/heads/main/docs/GUIDE.md";

describe("clipPage over a markdown file", () => {
  const FILE = [
    "# The Guide",
    "",
    "First paragraph of the guide.",
    "",
    "![shot](shots/01.png)",
    "",
    "```ts",
    "const x: number = 1;",
    "```",
    "",
    "See [the notes](NOTES.md) and [the site](https://example.test).",
  ].join("\n");

  /**
   * The defect this path exists for. Chrome hands the clipper a bare `<pre>`,
   * `recoverCodeBlocks` synthesizes a `<code>` inside it, and Turndown fences
   * the whole document — which then cannot be translated either, because code
   * is verbatim by contract and the processor never sends it to the model.
   */
  test("stores the file as markdown, not as one fence around it", () => {
    const payload = clipPage(viewerFor(FILE), RAW);
    expect(payload.markdown.startsWith("```")).toBe(false);
    expect(payload.markdown).toContain("# The Guide");
    // The fence the file actually wrote is still a fence, and still labelled.
    expect(payload.markdown).toContain("```ts\nconst x: number = 1;\n```");
  });

  test("takes the title from the file rather than from the host", () => {
    expect(clipPage(viewerFor(FILE), RAW).title).toBe("The Guide");
  });

  test("absolutizes what the file left relative", () => {
    const { markdown } = clipPage(viewerFor(FILE), RAW);
    expect(markdown).toContain(
      "![shot](https://raw.githubusercontent.com/o/r/refs/heads/main/docs/shots/01.png)",
    );
    expect(markdown).toContain(
      "[the notes](https://github.com/o/r/blob/main/docs/NOTES.md)",
    );
    expect(markdown).toContain("[the site](https://example.test)");
  });

  // Readability was never asked, and what the flag warns a reader about — a
  // raw body whose relative URLs were never absolutized — is exactly what this
  // path does absolutize.
  test("does not report a Readability failure it never had", () => {
    const payload = clipPage(viewerFor(FILE), RAW);
    expect(payload.readabilityFailed).toBe(false);
    expect(payload.pdfViewer).toBe(false);
    expect(payload.latexmlFullText).toBe(false);
  });

  /**
   * `has_math` promises that every literal `$` in prose was escaped, and the
   * promise is kept by a Turndown escape hook this path does not run. Claiming
   * it would let the site read "$5 to $10" as a formula.
   */
  test("never claims has_math, even over a file full of dollars", () => {
    const doc = viewerFor("# Prices\n\nIt costs $5 to $10, or $$20 in bulk.");
    expect(clipPage(doc, RAW).hasMath).toBe(false);
  });

  // The false positives. Each of these is a page, and clipping it as a file
  // would lose everything the HTML pipeline does for it. Asserted on the body
  // rather than the title, because which path ran is what is in question and a
  // body-only test document has no <title> either way.
  test("leaves an ordinary page on the ordinary path", () => {
    const window = new Window();
    window.document.body.innerHTML = `<article><h1>Post</h1><p>${"Word ".repeat(80)}</p></article>`;
    const payload = clipPage(
      window.document as unknown as Document,
      "https://example.test/post",
    );
    expect(payload.markdown).toContain("Word Word");
    expect(payload.markdown.startsWith("```")).toBe(false);
  });

  // The gate that the URL alone cannot hold: real HTML, served from a .md URL.
  // Only the document's shape separates this from the viewer.
  test("leaves a page served from a .md URL on the ordinary path", () => {
    const window = new Window();
    window.document.body.innerHTML = `<article><h1>Rendered</h1><p>${"Word ".repeat(80)}</p></article>`;
    const payload = clipPage(window.document as unknown as Document, RAW);
    expect(payload.markdown).toContain("Word Word");
    expect(payload.readabilityFailed).toBe(false);
  });

  test("still fences a plain-text file that is not markdown", () => {
    const doc = viewerFor("plain notes, hard wrapped\n  and indented");
    const payload = clipPage(doc, "https://example.test/notes.txt");
    expect(payload.markdown.startsWith("```")).toBe(true);
  });
});

describe("clipMarkdownFile", () => {
  // The blob case: filed under the page, read from the bytes. Resolving
  // against the blob page would point the image at an HTML page.
  test("files under one URL while resolving against another", () => {
    const payload = clipMarkdownFile(
      "# T\n\n![a](img/a.png)",
      "https://github.com/o/r/blob/main/docs/GUIDE.md",
      RAW,
    );
    expect(payload.url).toBe("https://github.com/o/r/blob/main/docs/GUIDE.md");
    expect(payload.markdown).toContain(
      "![a](https://raw.githubusercontent.com/o/r/refs/heads/main/docs/img/a.png)",
    );
  });

  test.each([
    ["https://github.com/o/r/blob/main/README.md", "o/r"],
    ["https://github.com/o/r/blob/main/docs/GUIDE.md", "o/r: GUIDE"],
    ["https://example.test/notes/Weekly%20Log.md", "Weekly Log"],
  ])("names a file with no heading: %s", (url, expected) => {
    expect(clipMarkdownFile("Just prose, no heading.", url).title).toBe(
      expected,
    );
  });

  test("reports no author, because a file carries no byline", () => {
    expect(clipMarkdownFile("# T\n\nProse.", RAW).author).toBe("");
  });
});
