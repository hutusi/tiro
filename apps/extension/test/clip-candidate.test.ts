import { describe, expect, test } from "bun:test";
import {
  clipReady,
  clipRefused,
  hasNothingToClip,
  isSourceBody,
  NO_FETCH,
  needsFetch,
  prefersCandidate,
  refusesAsEmpty,
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

/** arXiv: the tab's own body is a fair article under the shared slug. */
const DEGRADES = { available: true, degradesToTab: true };
/** GitHub: the tab's body is a rendering of the file, filed under the file's
 * own slug. */
const REFUSES = { available: true, degradesToTab: false };

describe("needsFetch", () => {
  test.each([
    ["a body that is the document owes nothing", true, DEGRADES, false],
    ["a lesser body owes a fetch", false, DEGRADES, true],
    ["an ordinary page owes nothing", false, NO_FETCH, false],
  ])("%s", (_name, isSource, policy, expected) => {
    expect(needsFetch({ isSource, fromFetch: false }, policy)).toBe(expected);
  });
});

describe("clipReady", () => {
  const fullText = { isSource: true, fromFetch: true };
  const abstract = { isSource: false, fromFetch: true };

  test("nothing in hand is never ready", () => {
    expect(clipReady(null, DEGRADES, true, true)).toBe(false);
  });

  test("a body that is the paper is ready whatever is outstanding", () => {
    expect(clipReady(fullText, DEGRADES, false, false)).toBe(true);
    expect(clipReady(fullText, REFUSES, false, false)).toBe(true);
  });

  // Committing here would replace the paper's article with a page about it.
  test("waits while a source that could do better has not reported", () => {
    expect(clipReady(abstract, DEGRADES, true, false)).toBe(false);
    expect(clipReady(abstract, DEGRADES, false, true)).toBe(false);
  });

  // Including when the answer was "I cannot be read" — a tab that never
  // reports must not gate the button forever, which is likeliest on the PDF
  // tab where script injection is least dependable.
  test("opens once both sources have had their turn", () => {
    expect(clipReady(abstract, DEGRADES, true, true)).toBe(true);
  });

  /**
   * The bug this policy exists for. "Both sources have had their turn" is only
   * an argument for committing the lesser body where that body is an article.
   * A GitHub rate-limit interstitial clips with `readabilityFailed: false` and
   * would land under the file's own slug.
   */
  test("never opens on a body the publisher's rule refuses, however settled", () => {
    expect(clipReady(abstract, REFUSES, true, true)).toBe(false);
  });

  test("never gates a page that is not a paper", () => {
    expect(clipReady(abstract, NO_FETCH, false, false)).toBe(true);
  });
});

describe("clipRefused", () => {
  const rendering = { isSource: false, fromFetch: false };
  const file = { isSource: true, fromFetch: true };

  test("nothing is refused while the fetch may still answer", () => {
    expect(clipRefused(rendering, REFUSES, false)).toBe(false);
  });

  // An abstract page in hand is an answer, not a dead end.
  test("a publisher whose tab body is a fair article never refuses", () => {
    expect(clipRefused(rendering, DEGRADES, true)).toBe(false);
    expect(clipRefused(null, DEGRADES, true)).toBe(false);
  });

  test("a rendering left after the fetch answered is a dead end", () => {
    expect(clipRefused(rendering, REFUSES, true)).toBe(true);
  });

  // The fetch failed before the tab reported. Answering "not refused" here and
  // "refused" a moment later would flicker the screen.
  test("is already a dead end before the tab reports at all", () => {
    expect(clipRefused(null, REFUSES, true)).toBe(true);
  });

  test("stops being one the moment a body that is the file arrives", () => {
    expect(clipRefused(file, REFUSES, true)).toBe(false);
  });

  test("never applies to an ordinary page", () => {
    expect(clipRefused(rendering, NO_FETCH, true)).toBe(false);
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

describe("hasNothingToClip", () => {
  const payload = (over: Partial<ClipPayload>): ClipPayload => ({
    url: "https://example.test/a.pdf",
    title: "",
    excerpt: "",
    author: "",
    markdown: "",
    readabilityFailed: true,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: false,
    ...over,
  });

  // What every web PDF was committed as while the viewer went unrecognised:
  // no body, Readability failed, and nothing saying it was a PDF.
  test("an empty body that is not a PDF stub", () => {
    expect(hasNothingToClip(payload({}))).toBe(true);
    expect(hasNothingToClip(payload({ markdown: " \n\n " }))).toBe(true);
  });

  // Empty on purpose: the processor builds the body (ADR 0026).
  test("not a PDF stub", () => {
    expect(hasNothingToClip(payload({ pdfViewer: true }))).toBe(false);
  });

  // However thin, a body is something to read — and an image-only page
  // reaches here as Markdown image syntax, not as nothing.
  test("not a body with anything in it", () => {
    expect(hasNothingToClip(payload({ markdown: "![Plate I](p.png)" }))).toBe(
      false,
    );
  });
});

describe("refusesAsEmpty", () => {
  const payload = (over: Partial<ClipPayload>): ClipPayload => ({
    url: "https://github.com/o/r/blob/main/NOTES.md",
    title: "o/r: NOTES",
    excerpt: "",
    author: "",
    markdown: "",
    readabilityFailed: false,
    hasMath: false,
    pdfViewer: false,
    latexmlFullText: false,
    markdownSource: false,
    ...over,
  });
  const GITHUB = { available: true, degradesToTab: false };
  const ARXIV = { available: true, degradesToTab: true };

  test("an empty body on an ordinary page", () => {
    expect(refusesAsEmpty(payload({}), NO_FETCH, false)).toBe(true);
  });

  /**
   * Found in review: a markdown file holding only whitespace comes back from
   * the fetch as the document itself, which `clipReady` opens the button for —
   * and committing it would replace the file's clip with nothing. Refusing it
   * once arbitration has settled is what the per-arrival check could not do.
   */
  test("an empty document fetched from a publisher", () => {
    const empty = payload({ markdownSource: true, markdown: " \n\n" });
    const best = { isSource: true, fromFetch: true };
    expect(clipReady(best, GITHUB, true, true)).toBe(true);
    expect(refusesAsEmpty(empty, GITHUB, true)).toBe(true);
  });

  // While a fetch can still replace an empty tab body, the offer is what to
  // show; the button is shut by the gate meanwhile.
  test("not while a fetch can still replace an empty tab body", () => {
    expect(refusesAsEmpty(payload({}), ARXIV, false)).toBe(false);
    expect(refusesAsEmpty(payload({}), GITHUB, false)).toBe(false);
  });

  test("an empty tab body once the fetch has had its turn", () => {
    expect(refusesAsEmpty(payload({}), ARXIV, true)).toBe(true);
  });

  test("not a PDF stub, a body with something in it, or nothing yet", () => {
    expect(refusesAsEmpty(payload({ pdfViewer: true }), NO_FETCH, false)).toBe(
      false,
    );
    expect(
      refusesAsEmpty(payload({ markdown: "Hello." }), NO_FETCH, false),
    ).toBe(false);
    expect(refusesAsEmpty(null, NO_FETCH, true)).toBe(false);
  });
});
