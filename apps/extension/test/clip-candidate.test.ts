import { describe, expect, test } from "bun:test";
import {
  clipReady,
  isSourceBody,
  needsFetch,
  prefersCandidate,
} from "../src/clip-candidate.ts";
import type { ClipPayload } from "../src/messages.ts";

/**
 * The arbitration both publisher rules need, tested once. These cases were
 * written for arXiv — the names still say abstract and full text, because that
 * is where each was found — and they are the same cases for a GitHub blob
 * page, whose rendering displaces the file exactly as an abstract displaces a
 * paper.
 */

describe("prefersCandidate", () => {
  const tabAbstract = { isSource: false, fromFetch: false };
  const tabFullText = { isSource: true, fromFetch: false };
  const fetchedAbstract = { isSource: false, fromFetch: true };
  const fetchedFullText = { isSource: true, fromFetch: true };

  test("anything beats nothing", () => {
    expect(prefersCandidate(null, tabAbstract)).toBe(true);
  });

  test("the paper beats a page about the paper", () => {
    expect(prefersCandidate(tabAbstract, fetchedFullText)).toBe(true);
  });

  /**
   * The finding, as a test. arxiv.org can answer with only an abstract for a
   * paper another renderer of the same corpus managed to convert — ar5iv is a
   * separate deployment — and the fetched body must not displace a full text
   * the reader is looking at just because it arrived second.
   */
  test("a fetched abstract does not displace a tab holding the paper", () => {
    expect(prefersCandidate(tabFullText, fetchedAbstract)).toBe(false);
  });

  // On a tie the fetched body is the canonical one, and the only one that
  // knows which version it came from.
  test("the fetched body wins a tie, from either side", () => {
    expect(prefersCandidate(tabFullText, fetchedFullText)).toBe(true);
    expect(prefersCandidate(fetchedFullText, tabFullText)).toBe(false);
    expect(prefersCandidate(tabAbstract, fetchedAbstract)).toBe(true);
    expect(prefersCandidate(fetchedAbstract, tabAbstract)).toBe(false);
  });
});

describe("clipReady", () => {
  const fullText = { isSource: true, fromFetch: true };
  const abstract = { isSource: false, fromFetch: true };

  test("nothing in hand is never ready", () => {
    expect(clipReady(null, true, true, true)).toBe(false);
  });

  test("a body that is the paper is ready whatever is outstanding", () => {
    expect(clipReady(fullText, true, false, false)).toBe(true);
  });

  // Committing here would replace the paper's article with a page about it.
  test("waits while a source that could do better has not reported", () => {
    expect(clipReady(abstract, true, true, false)).toBe(false);
    expect(clipReady(abstract, true, false, true)).toBe(false);
  });

  // Including when the answer was "I cannot be read" — a tab that never
  // reports must not gate the button forever, which is likeliest on the PDF
  // tab where script injection is least dependable.
  test("opens once both sources have had their turn", () => {
    expect(clipReady(abstract, true, true, true)).toBe(true);
  });

  test("never gates a page that is not a paper", () => {
    expect(clipReady(abstract, false, false, false)).toBe(true);
  });
});

describe("isSourceBody", () => {
  const payload = (over: Partial<ClipPayload>): ClipPayload => ({
    url: "https://example.test/a",
    title: "T",
    excerpt: "",
    author: "",
    markdown: "body",
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: false,
    ...over,
  });

  // One mapping, so a third publisher adds a field here rather than a second
  // arbitration beside this one.
  test.each([
    ["a LaTeXML full text", { latexmlFullText: true }, true],
    ["a markdown file", { markdownSource: true }, true],
    ["an abstract page", {}, false],
  ])("%s", (_name, over, expected) => {
    expect(isSourceBody(payload(over))).toBe(expected);
  });
});
