import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/llm/client.ts";
import { extractPdfText, fetchPdf, stripRunningFurniture } from "../src/pdf.ts";

/**
 * Build a structurally valid PDF with one text run per page.
 *
 * Written rather than committed because this repo holds no content (AGENTS.md)
 * and a PDF is a binary besides. A hand-built file also makes the gates
 * testable at their edges — a page count and a text density are exactly what a
 * fixture would have fixed in place.
 */
function wrap(text: string, width: number): string[] {
  if (text === "") return [""];
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    lines.push(text.slice(i, i + width));
  }
  return lines;
}

function makePdf(pageTexts: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objs[2] = `<</Type/Pages/Kids[${kids}]/Count ${pageTexts.length}>>`;
  objs[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  pageTexts.forEach((text, i) => {
    const pageNo = 4 + i * 2;
    const contentNo = pageNo + 1;
    objs[pageNo] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentNo} 0 R>>`;
    // Wrapped into lines rather than emitted as one run: pdf.js positions
    // glyphs and drops those past the MediaBox edge, so a long single run is
    // silently clipped at the page width — which made a 292-character page
    // extract as 101 and a density test fail for the wrong reason.
    const lines = wrap(text, 70);
    const runs = lines
      .map(
        (line, n) =>
          `${n === 0 ? "" : "0 -14 Td "}(${line.replace(/([()\\])/g, "\\$1")}) Tj `,
      )
      .join("");
    const stream = `BT /F1 12 Tf 72 720 Td ${runs}ET`;
    objs[contentNo] =
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) {
    out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const PROSE =
  "The method is straightforward to implement, is computationally efficient, has little memory requirements, and is invariant to diagonal rescaling of the gradients.";
const limits = { maxPages: 200, minCharsPerPage: 100 };

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

const fetchOptions = {
  url: "https://example.com/paper.pdf",
  maxBytes: 25 * 1024 * 1024,
  timeoutMs: 60_000,
  stageTimeoutMs: 300_000,
  allowPrivateHosts: true,
};

const pdfResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(bytes, {
    headers: { "content-type": "application/pdf", ...headers },
  });

describe("fetchPdf", () => {
  test("returns the bytes of a PDF", async () => {
    const bytes = makePdf([PROSE]);
    const fetchImpl: FetchLike = async () => pdfResponse(bytes);
    const got = await fetchPdf({ ...fetchOptions, fetchImpl });
    expect(got.byteLength).toBe(bytes.byteLength);
  });

  test("accepts octet-stream, which is how a file download is often served", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(makePdf([PROSE]), {
        headers: { "content-type": "application/octet-stream" },
      });
    await expect(
      fetchPdf({ ...fetchOptions, fetchImpl }),
    ).resolves.toBeDefined();
  });

  test("rejects a content type that is not a PDF at all", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("<html>login</html>", {
        headers: { "content-type": "text/html" },
      });
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /not a PDF: text\/html/,
    );
  });

  test("rejects bytes that are not a PDF however they were labelled", async () => {
    // The content type is the server's claim; the magic bytes are the fact.
    // This is what stops an interstitial served as application/pdf, or a
    // rebound DNS answer, from being read as a document.
    const fetchImpl: FetchLike = async () =>
      pdfResponse(new TextEncoder().encode("<html>rate limited</html>"));
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /not a PDF: begins/,
    );
  });

  test("refuses an oversized document before downloading it", async () => {
    let read = false;
    const fetchImpl: FetchLike = async () => {
      const res = pdfResponse(makePdf([PROSE]), {
        "content-length": String(40 * 1024 * 1024),
      });
      Object.defineProperty(res, "body", {
        get() {
          read = true;
          return null;
        },
      });
      return res;
    };
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /too large/,
    );
    expect(read).toBe(false);
  });

  test("stops mid-stream when the server understated the size", async () => {
    const fetchImpl: FetchLike = async () =>
      pdfResponse(new Uint8Array(4096).fill(0x25));
    await expect(
      fetchPdf({ ...fetchOptions, fetchImpl, maxBytes: 512 }),
    ).rejects.toThrow(/too large: exceeded 512 bytes/);
  });

  test("surfaces a failed request rather than treating it as a document", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("nope", { status: 404 });
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  test("applies the non-public host guard", async () => {
    // Not redundant with the image stage's own test: the guard is shared now,
    // and this is the assertion that this stage actually opted into it.
    const fetchImpl: FetchLike = async () => pdfResponse(makePdf([PROSE]));
    await expect(
      fetchPdf({
        ...fetchOptions,
        url: "http://169.254.169.254/latest/meta-data/",
        allowPrivateHosts: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/non-public host/);
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

  test("does not empty a one-line page by counting it twice", () => {
    // Its only line is both the first and the last non-empty one, so an
    // unguarded rule would drop it as a header and again as a footer.
    const pages = ["Header", "Header", "Header", `Header\n${body(4)}`];
    const out = stripRunningFurniture(pages);
    expect(out[3]).toContain("Discussion of");
  });
});
