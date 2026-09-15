import { describe, expect, test } from "bun:test";
import { fetchableSource } from "../src/fetch-source.ts";
import { messages } from "../src/i18n.ts";

const m = messages("en");

const BLOB = "https://github.com/o/r/blob/main/docs/GUIDE.md";
const RAW = "https://raw.githubusercontent.com/o/r/main/docs/GUIDE.md";

describe("fetchableSource", () => {
  /**
   * The test that would have caught the bug at source. A blob page's markdown
   * is GitHub's rendering of the file run back through Turndown, and it is
   * filed under the file's own slug — so there is no body here worth
   * committing, and saying so is what keeps the Clip button shut.
   */
  test("a GitHub blob page offers a fetch and refuses to degrade", () => {
    const source = fetchableSource(BLOB, m);
    expect(source?.kind).toBe("github");
    expect(source?.origin).toBe("https://raw.githubusercontent.com/*");
    expect(source?.degradesToTab).toBe(false);
  });

  // Refusing is only honest beside a way through, and the raw URL is one that
  // needs no permission at all.
  test("its refusal names the raw URL to open instead", () => {
    const source = fetchableSource(BLOB, m);
    expect(source?.degradesToTab === false && source.instead).toContain(RAW);
  });

  test("the Chinese refusal names the same URL", () => {
    const source = fetchableSource(BLOB, messages("zh"));
    expect(source?.degradesToTab === false && source.instead).toContain(RAW);
  });

  // An abstract page is the paper's canonical URL and a real article, so a
  // fetch that cannot happen costs a fuller body rather than the article.
  test("an arXiv paper offers a fetch and does degrade", () => {
    const source = fetchableSource("https://arxiv.org/abs/2404.19756", m);
    expect(source?.kind).toBe("arxiv");
    expect(source?.origin).toBe("https://arxiv.org/*");
    expect(source?.degradesToTab).toBe(true);
  });

  // The tab holds the file already; asking for a host permission to fetch what
  // is on screen would be absurd.
  test("a raw URL needs no fetch at all", () => {
    expect(fetchableSource(RAW, m)).toBeNull();
    expect(
      fetchableSource(
        "https://raw.githubusercontent.com/o/r/refs/heads/main/F.md",
        m,
      ),
    ).toBeNull();
  });

  /**
   * The invariant that makes the gate airtight: the descriptor and the slug are
   * driven by the same parser. A GitHub URL with no source is one
   * `canonicalizeUrl` also declines to collapse, so clipping it overwrites
   * nothing.
   */
  test.each([
    "https://github.com/o/r",
    "https://github.com/o/r/blob/main/setup.py",
    "https://github.com/o/r/tree/main/docs",
    "https://example.test/post",
    "not a url",
  ])("no publisher rule claims %s", (url) => {
    expect(fetchableSource(url, m)).toBeNull();
  });
});
