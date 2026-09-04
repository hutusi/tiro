import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import { hasLatexmlFullText, readLatexmlMetadata } from "../src/dom-prepare.ts";

/**
 * A scoped window rather than happy-dom's global registrator, for the reason
 * given in dom-prepare.test.ts: bun runs every test file in one process.
 */
function docFrom(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

/**
 * The author block as arxiv.org/html/2404.19756v1 actually serves it, trimmed
 * to two of its eight authors. The nesting is the point: the `†thanks:` note
 * and the affiliation list live *inside* `.ltx_personname`'s sibling, which is
 * why Readability's byline came out as prose.
 */
const KAN_AUTHORS = `
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">KAN: Kolmogorov–Arnold Networks</h1>
<div class="ltx_authors">
<span class="ltx_creator ltx_role_author">
<span class="ltx_personname">Ziming Liu
</span><span id="id1" class="ltx_note ltx_note_frontmatter ltx_thanks_note ltx_role_thanks"><sup class="ltx_note_mark">†</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">†</sup><span class="ltx_note_type">thanks: </span>zmliu@mit.edu</span></span></span><span class="ltx_author_notes"><span class="ltx_author_notes_content">
<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span> Massachusetts Institute of Technology
</span></span></span></span>
<span class="ltx_author_before">  </span><span class="ltx_creator ltx_role_author">
<span class="ltx_personname">Yixuan Wang
</span><span class="ltx_author_notes"><span class="ltx_author_notes_content">
<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation: </span> California Institute of Technology
</span></span></span></span>
</div>
<div class="ltx_abstract">
<h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">Inspired by the Kolmogorov-Arnold representation theorem, we
propose Kolmogorov-Arnold Networks (KANs).</p>
</div>
<section class="ltx_section"><p class="ltx_p">Body text.</p></section>
</article>`;

describe("readLatexmlMetadata", () => {
  test("reads the names and leaves the notes behind", () => {
    const metadata = readLatexmlMetadata(docFrom(KAN_AUTHORS));
    expect(metadata?.author).toBe("Ziming Liu, Yixuan Wang");
  });

  test("takes the title from the document, not the tab", () => {
    expect(readLatexmlMetadata(docFrom(KAN_AUTHORS))?.title).toBe(
      "KAN: Kolmogorov–Arnold Networks",
    );
  });

  // "Abstract" is a heading inside the block, so keeping it would prefix every
  // arXiv excerpt on the site with the word.
  test("takes the abstract without its own heading", () => {
    expect(readLatexmlMetadata(docFrom(KAN_AUTHORS))?.excerpt).toBe(
      "Inspired by the Kolmogorov-Arnold representation theorem, we propose Kolmogorov-Arnold Networks (KANs).",
    );
  });

  test("declines a page that is not LaTeXML at all", () => {
    expect(readLatexmlMetadata(docFrom("<h1>A blog post</h1>"))).toBeNull();
  });

  // Some papers set the author line as plain text rather than marking up each
  // person. A collapsed line beats no author.
  test("falls back to the block's text when no person is marked up", () => {
    const doc = docFrom(
      `<article class="ltx_document">
         <div class="ltx_authors">  Anonymous
         Author </div>
         <section class="ltx_section"><p>Body.</p></section>
       </article>`,
    );
    expect(readLatexmlMetadata(doc)?.author).toBe("Anonymous Author");
  });

  test("omits what the page does not carry rather than reporting empty", () => {
    const doc = docFrom(
      `<article class="ltx_document">
         <section class="ltx_section"><p>Body.</p></section>
       </article>`,
    );
    const metadata = readLatexmlMetadata(doc);
    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBeUndefined();
    expect(metadata?.author).toBeUndefined();
    expect(metadata?.excerpt).toBeUndefined();
  });
});

describe("hasLatexmlFullText", () => {
  test("accepts a real paper", () => {
    expect(hasLatexmlFullText(docFrom(KAN_AUTHORS))).toBe(true);
  });

  /**
   * arxiv.org/html/1412.6980 — the Adam paper — is served as HTTP 200 with a
   * valid `.ltx_document` whose entire body is this sentence, because the
   * submission is a `\includepdf` wrapper LaTeXML cannot convert. Status codes
   * do not separate it from a real paper; the missing title and sections do.
   */
  test("rejects the \\includepdf stub arXiv serves with HTTP 200", () => {
    const doc = docFrom(
      `<div class="ltx_page_main"><div class="ltx_document">
         <p class="ltx_p">See pages 1-last of 0_adam_main.pdf</p>
       </div></div>`,
    );
    expect(hasLatexmlFullText(doc)).toBe(false);
  });

  test("rejects a page with no LaTeXML root", () => {
    expect(hasLatexmlFullText(docFrom("<h1>A blog post</h1>"))).toBe(false);
  });
});

describe("clipPage on a LaTeXML page", () => {
  // The end-to-end shape of the defect: before this, the vault recorded
  // `author: "Stephen Chung\nThanks: DualverseAI; University of Cambridge"`.
  test("frontmatter carries names and an abstract, not affiliations", () => {
    const window = new Window();
    window.document.body.innerHTML = KAN_AUTHORS;
    const payload = clipPage(
      window.document as unknown as Document,
      "https://arxiv.org/abs/2404.19756",
    );
    expect(payload.author).toBe("Ziming Liu, Yixuan Wang");
    expect(payload.author).not.toContain("thanks");
    expect(payload.author).not.toContain("Affiliation");
    expect(payload.excerpt).toStartWith("Inspired by the Kolmogorov-Arnold");
    expect(payload.title).toBe("KAN: Kolmogorov–Arnold Networks");
  });
});
