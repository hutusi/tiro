import { describe, expect, test } from "bun:test";
import { extractPdfText, stripRunningFurniture } from "../src/pdf.ts";
import { makePdf } from "./pdf-fixture.ts";

const PROSE =
  "The method is straightforward to implement, is computationally efficient, has little memory requirements, and is invariant to diagonal rescaling of the gradients.";
const limits = { maxPages: 200, minCharsPerPage: 100, minPageCoverage: 0.5 };

describe("extractPdfText", () => {
  test("reads a page's text layer in order", async () => {
    const result = await extractPdfText(
      makePdf([`${PROSE} One.`, `${PROSE} Two.`]),
      limits,
    );
    expect(result.totalPages).toBe(2);
    expect(result.pages[0]).toContain("One.");
    expect(result.pages[1]).toContain("Two.");
  });

  test("refuses a document longer than the page cap", async () => {
    // Refused rather than truncated: half a document filed as the whole one is
    // the silent kind of wrong, and nothing downstream could tell.
    await expect(
      extractPdfText(makePdf([PROSE, PROSE, PROSE]), {
        ...limits,
        maxPages: 2,
      }),
    ).rejects.toThrow(/too many pages: 3/);
  });

  test("refuses a PDF with no usable text layer", async () => {
    // What a scan extracts to. OCR is out of scope (ADR 0026), so letting this
    // through would file the empty article the clipper already refuses.
    await expect(extractPdfText(makePdf(["", "", ""]), limits)).rejects.toThrow(
      /no usable text layer/,
    );
  });

  test("names OCR in the refusal, since that is the missing capability", async () => {
    await expect(extractPdfText(makePdf([".", "."]), limits)).rejects.toThrow(
      /OCR/,
    );
  });

  test("averages density across pages rather than demanding it of each", async () => {
    // A paper carrying a full-page figure must not be refused for it. One empty
    // page beside one dense page averages above the gate, and passes.
    const dense = PROSE.repeat(4);
    const result = await extractPdfText(makePdf([dense, ""]), limits);
    expect(result.totalPages).toBe(2);
  });

  test("refuses a document that is mostly scanned", async () => {
    // The hole an average alone leaves: one dense page among nine blank ones
    // gives 300 chars/page and sails past min_chars_per_page, and the article
    // would be filed as a whole document while holding a tenth of one.
    // Dense enough that the average gate passes cleanly; only coverage can
    // refuse this, which is the whole point of the case.
    const pages = [PROSE.repeat(20), ...Array<string>(9).fill("")];
    await expect(extractPdfText(makePdf(pages), limits)).rejects.toThrow(
      /text layer covers only 1 of 10/,
    );
  });

  test("still admits a paper carrying full-page figures", async () => {
    // The case the average exists for, and which a coverage test alone would
    // refuse: text on most pages, nothing on the plates.
    const pages = [PROSE, PROSE, PROSE, "", PROSE, PROSE, ""];
    const result = await extractPdfText(makePdf(pages), limits);
    expect(result.totalPages).toBe(7);
  });

  test("does not count a page holding only a stray number as covered", async () => {
    // A page whose text layer is debris is not a page with words on it.
    const pages = [PROSE.repeat(3), "7", "8", "9"];
    await expect(extractPdfText(makePdf(pages), limits)).rejects.toThrow(
      /covers only 1 of 4/,
    );
  });

  test("counts content rather than whitespace", async () => {
    // A page of blanks must not satisfy a gate meant to measure text.
    await expect(
      extractPdfText(makePdf(["          ", "          "]), limits),
    ).rejects.toThrow(/no usable text layer/);
  });

  test("reports a corrupt file as unreadable rather than throwing from pdf.js", async () => {
    const junk = new TextEncoder().encode("%PDF-1.4\nnot actually a pdf\n");
    await expect(extractPdfText(junk, limits)).rejects.toThrow(
      /cannot read the PDF/,
    );
  });
});

describe("stripRunningFurniture", () => {
  // Genuinely distinct per page, not just differing by a number: digit runs are
  // normalised, so "Body text for page 1/2/3" would itself tally as one
  // repeated line and be dropped as a footer. That is the rule working — it is
  // how "Page 3 of 15" is matched — but it makes uniform test bodies useless.
  const WORDS = [
    "gradients",
    "estimates",
    "objectives",
    "parameters",
    "moments",
  ];
  const body = (n: number) =>
    `Discussion of ${WORDS[n % WORDS.length]} in a sentence with enough substance.`;

  test("drops a header repeated across the document", () => {
    const pages = [1, 2, 3, 4].map(
      (n) => `Published as a conference paper at ICLR 2015\n${body(n)}`,
    );
    const out = stripRunningFurniture(pages);
    expect(out.every((p) => !p.includes("ICLR 2015"))).toBe(true);
    expect(out[0]).toContain("Discussion of");
  });

  test("treats page numbers as one footer, not four different ones", () => {
    // The whole reason digit runs are normalised: "2", "3", "4" are the same
    // piece of furniture and only reach the threshold when counted together.
    const pages = [2, 3, 4, 5].map((n) => `${body(n)}\n${n}`);
    const out = stripRunningFurniture(pages);
    expect(out.every((p) => /\n\d+$/.test(p))).toBe(false);
  });

  test("matches a numbered footer across its varying number", () => {
    const pages = [1, 2, 3, 4].map((n) => `${body(n)}\nPage ${n} of 4`);
    const out = stripRunningFurniture(pages);
    expect(out.every((p) => !p.includes("Page "))).toBe(true);
  });

  test("leaves a line that recurs on only some pages", () => {
    // Below the share this is a section label that happens to repeat, and a
    // false positive costs real content.
    const pages = [
      `Methods\n${body(1)}`,
      `Methods\n${body(2)}`,
      body(3),
      body(4),
      body(5),
    ];
    expect(stripRunningFurniture(pages)[0]).toContain("Methods");
  });

  test("leaves a short document alone", () => {
    // Two pages sharing a line is a coincidence, not furniture.
    const pages = [`Header\n${body(1)}`, `Header\n${body(2)}`];
    expect(stripRunningFurniture(pages)).toEqual(pages);
  });

  test("leaves a long repeated line alone", () => {
    // A repeated sentence is content; only short lines are furniture.
    const long = `A sentence far too long to be a running head, repeated on every page of this document because the layout put it there.`;
    const pages = [1, 2, 3, 4].map((n) => `${long}\n${body(n)}`);
    expect(stripRunningFurniture(pages)[0]).toContain(long);
  });

  test("leaves a running head that extraction merged with figure text", () => {
    // Measured on a real paper: on three of Adam's fifteen pages the ICLR
    // running head comes out fused to a chart's axis ticks
    // ("...at ICLR 20150 5 10 15 20 25"), so its key differs and it survives
    // while the other twelve are dropped.
    //
    // Pinned rather than fixed. Matching on a prefix would catch these three
    // and would also license deleting the start of any line that happens to
    // begin like a header — real content, across the whole corpus, silently.
    // Three noise lines in one document is the cheaper side of that trade
    // (ADR 0023's asymmetry), and the model pass is not given deletion either.
    const head = "Published as a conference paper at ICLR 2015";
    const pages = [
      `${head}\n${body(1)}`,
      `${head}\n${body(2)}`,
      `${head}\n${body(3)}`,
      `${head}0 5 10 15 20 25\n${body(4)}`,
    ];
    const out = stripRunningFurniture(pages);
    expect(out[0]).not.toContain(head);
    expect(out[3]).toContain(head);
  });

  test("does not empty a one-line page by counting it twice", () => {
    // Its only line is both the first and the last non-empty one, so an
    // unguarded rule would drop it as a header and again as a footer.
    const pages = ["Header", "Header", "Header", `Header\n${body(4)}`];
    const out = stripRunningFurniture(pages);
    expect(out[3]).toContain("Discussion of");
  });
});
