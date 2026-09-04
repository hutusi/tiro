import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage, isPdfViewerDocument } from "../src/clip-page.ts";

function docFrom(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

describe("isPdfViewerDocument", () => {
  /**
   * What Chrome actually serves for `https://arxiv.org/pdf/2404.19756v1`: an
   * HTML shell whose body is one embed. The bytes are drawn by a plugin no
   * DOM API can reach, so there is nothing to extract — and the popup's only
   * guard was a `^https?:` test, which this passes.
   */
  test("recognises Chrome's PDF viewer shell", () => {
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
