import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage, isPdfViewerDocument } from "../src/clip-page.ts";

function docFrom(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

/**
 * Chrome's out-of-process PDF viewer as the clipper meets it — measured in
 * Chrome 154 on 2026-10-03, on a tab showing `gwern.net/doc/math/1973-halmos.pdf`.
 * No `<embed>` anywhere: the head links the viewer's stylesheet, and the body
 * holds only what other extensions injected into it.
 *
 * The type is set on the instance rather than through happy-dom's internal
 * symbol: a non-HTML internal type also switches off its tag-name and
 * attribute case folding, which the real document never does.
 */
function oopifViewer(contentType = "application/pdf"): Document {
  const window = new Window();
  const doc = window.document;
  doc.head.innerHTML =
    '<link rel="stylesheet" href="chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css">';
  doc.body.innerHTML =
    "\n    <deepl-input-controller></deepl-input-controller>\n  \n\n";
  Object.defineProperty(doc, "contentType", { value: contentType });
  return doc as unknown as Document;
}

describe("isPdfViewerDocument", () => {
  /**
   * The viewer every web PDF met before this was caught: the shape test below
   * never matched it, so each one was committed as an empty article.
   */
  test("recognises the out-of-process viewer, which has no embed", () => {
    expect(isPdfViewerDocument(oopifViewer())).toBe(true);
  });

  test("recognises the viewer's other type", () => {
    expect(isPdfViewerDocument(oopifViewer("text/pdf"))).toBe(true);
  });

  // The same body served as HTML is an empty page, not a PDF: the type is
  // what decides, not the emptiness.
  test("leaves the same body alone when it is an HTML page", () => {
    expect(isPdfViewerDocument(oopifViewer("text/html"))).toBe(false);
  });

  /**
   * What Chrome's earlier viewer served for `https://arxiv.org/pdf/2404.19756v1`:
   * an HTML shell, typed `text/html`, whose body is one embed. The bytes are
   * drawn by a plugin no DOM API can reach, so there is nothing to extract — and
   * the popup's only guard was a `^https?:` test, which this passes.
   */
  test("recognises the earlier viewer's embed shell", () => {
    const doc = docFrom(
      '<embed name="A" type="application/pdf" src="about:blank">',
    );
    expect(isPdfViewerDocument(doc)).toBe(true);
  });

  test("recognises the object form", () => {
    expect(
      isPdfViewerDocument(docFrom('<object type="application/pdf"></object>')),
    ).toBe(true);
  });

  // The reason for the text test: an article that embeds a PDF alongside its
  // prose is still an article, and refusing it would lose a real clip.
  test("leaves an article that merely embeds a PDF alone", () => {
    const prose = "Word ".repeat(80);
    const doc = docFrom(
      `<article><p>${prose}</p><embed type="application/pdf"></article>`,
    );
    expect(isPdfViewerDocument(doc)).toBe(false);
  });

  /**
   * The case text length alone gets wrong. A poster or a figure gallery can
   * carry a PDF attachment and almost no prose, and it clips perfectly well —
   * the images are the article. Refusing it would lose real content.
   */
  test("leaves a near-textless page whose content is images", () => {
    const images = Array.from(
      { length: 8 },
      (_, i) => `<img src="https://example.com/plate-${i}.png" alt="Plate">`,
    ).join("");
    const doc = docFrom(
      `<article>${images}<p>Plates I-VIII.</p><embed type="application/pdf"></article>`,
    );
    expect(isPdfViewerDocument(doc)).toBe(false);
  });

  /**
   * Same fragility as the markdown predicate's, hardened for the same reason:
   * another extension's injected element is a sibling this never sees coming,
   * and demanding the embed be the body's only child would call a PDF an
   * article — committing it empty, with `readability_failed` set, which is the
   * outcome this guard exists to prevent.
   */
  test("survives another extension injecting into the body", () => {
    const doc = docFrom(
      '<embed type="application/pdf"><deepl-input-controller></deepl-input-controller>',
    );
    expect(isPdfViewerDocument(doc)).toBe(true);
  });

  test("leaves a page that wraps the embed beside other content", () => {
    const doc = docFrom('<h1>Report</h1><embed type="application/pdf">');
    expect(isPdfViewerDocument(doc)).toBe(false);
  });

  test("leaves an ordinary page alone", () => {
    expect(isPdfViewerDocument(docFrom("<p>Hello.</p>"))).toBe(false);
  });
});

describe("clipPage", () => {
  test("reports the PDF viewer on the payload so the popup can refuse", () => {
    const window = new Window();
    window.document.body.innerHTML = '<embed type="application/pdf">';
    const payload = clipPage(
      window.document as unknown as Document,
      "https://example.com/paper.pdf",
    );
    expect(payload.pdfViewer).toBe(true);
  });

  test("reports the out-of-process viewer, so the popup commits a stub", () => {
    const payload = clipPage(
      oopifViewer(),
      "https://gwern.net/doc/math/1973-halmos.pdf",
    );
    expect(payload.pdfViewer).toBe(true);
  });

  test("reports false for a page with an article in it", () => {
    const window = new Window();
    window.document.body.innerHTML = `<article><h1>T</h1><p>${"Word ".repeat(80)}</p></article>`;
    const payload = clipPage(
      window.document as unknown as Document,
      "https://example.com/post",
    );
    expect(payload.pdfViewer).toBe(false);
  });
});
