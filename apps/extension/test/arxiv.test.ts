import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  clipArxivPaper,
  needsFullTextFetch,
  prepareFetchedDocument,
} from "../src/arxiv.ts";
import { clipPage } from "../src/clip-page.ts";
import type { FetchLike } from "../src/github.ts";

/** Parse a whole document, the way DOMParser does in the popup — `<head>` and
 * all, since prepareFetchedDocument inserts a `<base>` into it. */
function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

const deps = (pages: Record<string, string | number>) => ({
  parse,
  fetch: (async (input) => {
    const url = String(input);
    const page = pages[url];
    if (page === undefined) return new Response("nope", { status: 404 });
    if (typeof page === "number") return new Response("", { status: page });
    return new Response(page, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as FetchLike,
});

/** arxiv.org/html/<id> as LaTeXML serves it, cut to the parts that matter.
 * The image src is verbatim from 2404.19756v1 — relative, and relative in a
 * way that only resolves correctly against the /html/ URL. */
const paperHtml = (id = "2404.19756", version = 1) => `<!doctype html>
<html><head><title>KAN: Kolmogorov–Arnold Networks</title></head><body>
<div class="ltx_page_logo">arXiv:${id}v${version} [cs.LG] 30 Apr 2024</div>
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">KAN: Kolmogorov–Arnold Networks</h1>
<div class="ltx_authors"><span class="ltx_personname">Ziming Liu</span></div>
<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">Inspired by the representation theorem.</p></div>
<section class="ltx_section"><p class="ltx_p">${"Body sentence. ".repeat(40)}</p>
<figure><img src="${id}v${version}/figs/sr.png" alt="Refer to caption"></figure>
<p><a href="#S2">Section 2</a> and <a href="../abs/2101.00001">a paper</a>.</p>
</section></article></body></html>`;

/** The abstract page: the one arXiv surface that carries real metadata. */
const absHtml = `<!doctype html>
<html><head>
<meta name="citation_title" content="KAN: Kolmogorov-Arnold Networks">
<meta name="citation_author" content="Liu, Ziming">
<meta name="citation_author" content="Wang, Yixuan">
<meta name="citation_abstract" content="Inspired by the representation theorem.">
</head><body><div id="abs">
<blockquote class="abstract">${"Abstract sentence. ".repeat(30)}</blockquote>
</div></body></html>`;

describe("prepareFetchedDocument", () => {
  /**
   * The whole reason this function exists. arXiv writes
   * `src="2404.19756v1/figs/sr.png"`; a live clip survives it because
   * Readability absolutizes against `doc.baseURI`, which for a DOMParser
   * document is the *popup's* URL. The processor downloads only `https?://`
   * URLs and ignores the rest without erroring, so getting this wrong loses
   * every figure silently.
   */
  test("resolves a relative image against the page it was fetched from", () => {
    const doc = parse(
      '<html><head></head><body><img src="2404.19756v1/f.png"></body></html>',
    );
    prepareFetchedDocument(doc, "https://arxiv.org/html/2404.19756v1");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe(
      "https://arxiv.org/html/2404.19756v1/f.png",
    );
  });

  test("resolves relative links too", () => {
    const doc = parse(
      '<html><head></head><body><a href="../abs/2101.1">x</a></body></html>',
    );
    prepareFetchedDocument(doc, "https://arxiv.org/html/2404.19756v1");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(
      "https://arxiv.org/abs/2101.1",
    );
  });

  // An in-page anchor is meaningful relative to the article, and rewriting a
  // data: or javascript: URL into a page URL would be worse than leaving it.
  test("leaves anchors and non-http schemes alone", () => {
    const doc = parse(
      '<html><head></head><body><a href="#S2">a</a><img src="data:image/png;base64,AA"></body></html>',
    );
    prepareFetchedDocument(doc, "https://arxiv.org/html/2404.19756v1");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("#S2");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA",
    );
  });

  // Resolution is against the fetched URL as a *document*, so the last segment
  // is replaced — which is exactly why arXiv writes its own image paths with
  // the id prefix (`2404.19756v1/figs/sr.png`) rather than bare filenames.
  test("resolves each candidate in a srcset separately", () => {
    const doc = parse(
      '<html><head></head><body><img srcset="a.png 1x, 2404.19756v1/b.png 2x"></body></html>',
    );
    prepareFetchedDocument(doc, "https://arxiv.org/html/2404.19756v1");
    expect(doc.querySelector("img")?.getAttribute("srcset")).toBe(
      "https://arxiv.org/html/a.png 1x, https://arxiv.org/html/2404.19756v1/b.png 2x",
    );
  });

  // The other half: Readability reads `doc.baseURI`, which covers attributes
  // the explicit pass does not enumerate.
  test("gives the document the base its markup was written against", () => {
    const doc = parse("<html><head></head><body></body></html>");
    prepareFetchedDocument(doc, "https://arxiv.org/html/2404.19756v1");
    expect(doc.querySelector("base")?.getAttribute("href")).toBe(
      "https://arxiv.org/html/2404.19756v1",
    );
  });
});

describe("clipArxivPaper", () => {
  test("reads the full text, and files it under the abstract URL", async () => {
    const clip = await clipArxivPaper(
      { id: "2404.19756", version: 1 },
      deps({ "https://arxiv.org/html/2404.19756v1": paperHtml() }),
    );
    expect(clip.payload.url).toBe("https://arxiv.org/abs/2404.19756");
    expect(clip.sourceUrl).toBe("https://arxiv.org/html/2404.19756v1");
    expect(clip.payload.author).toBe("Ziming Liu");
    expect(clip.payload.markdown).toContain("Body sentence.");
  });

  // The test that guards the processor's download regex.
  test("the markdown carries absolute image URLs", async () => {
    const clip = await clipArxivPaper(
      { id: "2404.19756", version: 1 },
      deps({ "https://arxiv.org/html/2404.19756v1": paperHtml() }),
    );
    expect(clip.payload.markdown).toContain(
      "https://arxiv.org/html/2404.19756v1/figs/sr.png",
    );
    expect(clip.payload.markdown).not.toContain("](2404.19756v1/figs");
  });

  test("records the version arXiv served when the URL named none", async () => {
    const clip = await clipArxivPaper(
      { id: "2404.19756" },
      deps({ "https://arxiv.org/html/2404.19756": paperHtml("2404.19756", 5) }),
    );
    expect(clip.sourceUrl).toBe("https://arxiv.org/html/2404.19756v5");
  });

  /**
   * arxiv.org/html/1412.6980 — the Adam paper — is HTTP 200 with a valid
   * `.ltx_document` whose whole body is this sentence, because the submission
   * is a `\includepdf` wrapper. Falling through to the abstract page is the
   * only way to get anything real, and its citation_* tags are better metadata
   * than anything the HTML would have given.
   */
  test("falls back to the abstract page for a \\includepdf stub", async () => {
    const stub = `<!doctype html><html><head><title>Untitled Document</title>
      </head><body><div class="ltx_document">
      <p>See pages 1-last of 0_adam_main.pdf</p></div></body></html>`;
    const clip = await clipArxivPaper(
      { id: "1412.6980" },
      deps({
        "https://arxiv.org/html/1412.6980": stub,
        "https://arxiv.org/abs/1412.6980": absHtml,
      }),
    );
    expect(clip.sourceUrl).toBeUndefined();
    expect(clip.payload.url).toBe("https://arxiv.org/abs/1412.6980");
    expect(clip.payload.title).toBe("KAN: Kolmogorov-Arnold Networks");
  });

  test("falls back when arXiv has no HTML at all", async () => {
    const clip = await clipArxivPaper(
      { id: "1412.6980" },
      deps({ "https://arxiv.org/abs/1412.6980": absHtml }),
    );
    expect(clip.sourceUrl).toBeUndefined();
  });

  // arXiv writes authors surname-first, so a comma between them would read as
  // part of a name.
  test("joins citation authors with a separator that survives Last, First", async () => {
    const clip = await clipArxivPaper(
      { id: "1412.6980" },
      deps({ "https://arxiv.org/abs/1412.6980": absHtml }),
    );
    expect(clip.payload.author).toBe("Liu, Ziming; Wang, Yixuan");
  });

  test("throws when neither page can be had, so the caller can use the tab", () => {
    expect(clipArxivPaper({ id: "2404.19756" }, deps({}))).rejects.toThrow(
      "2404.19756",
    );
  });
});

describe("needsFullTextFetch", () => {
  /**
   * The gate that stops the abstract page overwriting a full-text clip. With
   * `/abs/`, `/pdf/` and `/html/` collapsed onto one slug, committing the tab
   * while a better body is a click away replaces the article and costs a full
   * re-translation to undo.
   */
  test("gates a paper's page that is not the paper", () => {
    expect(needsFullTextFetch({ latexmlFullText: false }, true)).toBe(true);
  });

  // The reason this is keyed on the document and not the URL: a reader already
  // looking at /html/ has the full text in the tab, and must not be made to
  // grant a permission to clip the page in front of them.
  test("leaves a tab that already holds the full text alone", () => {
    expect(needsFullTextFetch({ latexmlFullText: true }, true)).toBe(false);
  });

  test("never gates a page that is not a paper", () => {
    expect(needsFullTextFetch({ latexmlFullText: false }, false)).toBe(false);
  });
});

describe("clipPage reports whether the tab holds the paper", () => {
  const clipTab = (html: string, url: string) => {
    const window = new Window();
    window.document.body.innerHTML = html;
    return clipPage(window.document as unknown as Document, url);
  };

  test("true for a real LaTeXML paper", () => {
    const payload = clipTab(
      `<article class="ltx_document">
         <h1 class="ltx_title ltx_title_document">A Paper</h1>
         <section class="ltx_section"><p>${"Body sentence. ".repeat(40)}</p></section>
       </article>`,
      "https://arxiv.org/html/2404.19756v1",
    );
    expect(payload.latexmlFullText).toBe(true);
    expect(needsFullTextFetch(payload, true)).toBe(false);
  });

  // The case a URL-based gate would wave straight through.
  test("false for the \\includepdf stub served at an /html/ URL", () => {
    const payload = clipTab(
      '<div class="ltx_document"><p>See pages 1-last of 0_adam_main.pdf</p></div>',
      "https://arxiv.org/html/1412.6980",
    );
    expect(payload.latexmlFullText).toBe(false);
    expect(needsFullTextFetch(payload, true)).toBe(true);
  });

  test("false for an abstract page", () => {
    const payload = clipTab(
      `<div id="abs"><blockquote class="abstract">${"Abstract sentence. ".repeat(20)}</blockquote></div>`,
      "https://arxiv.org/abs/2404.19756",
    );
    expect(payload.latexmlFullText).toBe(false);
  });

  // The abstract page is a legitimate body when a paper has no HTML at all, so
  // the popup must not gate on the predicate alone — it settles the gate once
  // the fetch has had its turn.
  test("the abstract-page fallback would gate itself without that settling", async () => {
    const clip = await clipArxivPaper(
      { id: "1412.6980" },
      deps({ "https://arxiv.org/abs/1412.6980": absHtml }),
    );
    expect(needsFullTextFetch(clip.payload, true)).toBe(true);
  });
});
