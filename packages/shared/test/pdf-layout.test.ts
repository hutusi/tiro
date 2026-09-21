import { describe, expect, test } from "bun:test";
import {
  bodySize,
  fontFamily,
  headingSizes,
  isMonospaceFontName,
  monospaceFonts,
  type PdfTextItem,
  readPdfLayout,
} from "../src/pdf-layout.ts";
import { makePdf, makeStyledPdf } from "./pdf-fixture.ts";

/** A run, with only the fields the function under test reads. */
function item(over: Partial<PdfTextItem>): PdfTextItem {
  return {
    text: "text",
    font: "Helvetica",
    size: 11,
    x: 72,
    y: 700,
    page: 1,
    width: 40,
    endsLine: true,
    mono: false,
    ...over,
  };
}

describe("fontFamily", () => {
  test("strips the subset tag an embedded font arrives with", () => {
    // Every name test would otherwise be run against six random letters.
    expect(fontFamily("PNNOIE+NimbusRomNo9L-Regu")).toBe("NimbusRomNo9L-Regu");
  });

  test("leaves a standard font alone", () => {
    expect(fontFamily("Times-Roman")).toBe("Times-Roman");
  });

  test("does not mistake a lowercase prefix for a tag", () => {
    expect(fontFamily("abcdef+Foo")).toBe("abcdef+Foo");
  });
});

describe("isMonospaceFontName", () => {
  test("catches the obvious families", () => {
    for (const name of ["Courier", "DejaVuSansMono", "Consolas", "Menlo"]) {
      expect(isMonospaceFontName(name)).toBe(true);
    }
  });

  test("catches NimbusMonL, which contains no 'mono'", () => {
    // The miss that showed names are whack-a-mole and sent this to measurement.
    expect(isMonospaceFontName("SCLPKW+NimbusMonL-Regu")).toBe(true);
  });

  test("catches TeX typewriter faces by their TT convention", () => {
    expect(isMonospaceFontName("XEXHSJ+SFTT1000")).toBe(true);
    expect(isMonospaceFontName("CMTT10")).toBe(true);
  });

  test("leaves proportional faces alone", () => {
    for (const name of [
      "NimbusRomNo9L-Regu",
      "Helvetica-Bold",
      "Arial-BoldMT",
    ]) {
      expect(isMonospaceFontName(name)).toBe(false);
    }
  });
});

describe("bodySize", () => {
  test("weighs characters, not runs", () => {
    // Measured on a real document: a median over *items* returned 8pt for a
    // body set in 11, because short code fragments outnumber long prose lines,
    // and then every body line classified as a heading.
    const items = [
      ...Array.from({ length: 20 }, () => item({ size: 8, text: "x)" })),
      ...Array.from({ length: 5 }, () =>
        item({ size: 11, text: "a".repeat(200) }),
      ),
    ];
    expect(bodySize(items)).toBe(11);
  });

  test("treats sizes within a tolerance as one size", () => {
    // LaTeX bodies measure 9.7, 10 and 10.9 across three papers, and
    // neighbours inside one document differ by tenths.
    const items = [
      ...Array.from({ length: 10 }, () =>
        item({ size: 9.7, text: "aaaaaaaa" }),
      ),
      ...Array.from({ length: 10 }, () =>
        item({ size: 9.8, text: "aaaaaaaa" }),
      ),
      ...Array.from({ length: 15 }, () => item({ size: 12, text: "aaaaaaa" })),
    ];
    // The split pair outweighs the uniform size once merged.
    expect(bodySize(items)).toBeCloseTo(9.7, 1);
  });

  test("is zero for a document with no text", () => {
    expect(bodySize([])).toBe(0);
  });
});

describe("headingSizes", () => {
  test("returns sizes above the body, largest first", () => {
    const items = [
      item({ size: 11 }),
      item({ size: 16 }),
      item({ size: 20 }),
      item({ size: 13 }),
    ];
    expect(headingSizes(items, 11)).toEqual([20, 16, 13]);
  });

  test("ignores how little text a heading holds", () => {
    // In the measured papers a heading is a rounding error beside the body —
    // 241 characters at 12pt in a 16,000-character paper. A volume threshold
    // would discard exactly what is being looked for.
    const items = [
      ...Array.from({ length: 500 }, () =>
        item({ size: 10, text: "a".repeat(80) }),
      ),
      item({ size: 14, text: "A Heading" }),
    ];
    expect(headingSizes(items, 10)).toEqual([14]);
  });

  test("does not report a size that is merely a rounding away", () => {
    expect(headingSizes([item({ size: 11.2 })], 11)).toEqual([]);
  });

  test("collapses near-identical heading sizes", () => {
    expect(
      headingSizes([item({ size: 16 }), item({ size: 16.2 })], 11),
    ).toEqual([16]);
  });
});

describe("monospaceFonts", () => {
  /** n runs of distinct text, all advancing identically. */
  function fixedWidth(font: string, n: number): PdfTextItem[] {
    return Array.from({ length: n }, (_, i) => {
      const text = `run number ${i} of the sample`;
      return item({ font, text, width: text.length * 6, size: 10 });
    });
  }

  test("measures a fixed-width face whatever it is called", () => {
    expect([...monospaceFonts(fixedWidth("SomeUnknownFace", 10))]).toEqual([
      "SomeUnknownFace",
    ]);
  });

  test("leaves a proportional face alone", () => {
    const items = Array.from({ length: 10 }, (_, i) => {
      const text = `run number ${i} of the sample`;
      // Width that does not scale with length: a proportional advance.
      return item({ font: "Helvetica", text, width: 30 + i * 9, size: 10 });
    });
    expect([...monospaceFonts(items)]).toEqual([]);
  });

  test("refuses to be convinced by the same string repeated", () => {
    // Arial-BoldMT measured a coefficient of variation of exactly zero across
    // five runs, because they were five copies of one string — which advances
    // identically in any face whatsoever.
    const items = Array.from({ length: 12 }, () =>
      item({ font: "Arial-BoldMT", text: "Figure 1", width: 48, size: 10 }),
    );
    expect([...monospaceFonts(items)]).toEqual([]);
  });

  test("falls back to the name where there is too little to measure", () => {
    // NimbusMonL appears twice in one of the papers — real, and unmeasurable.
    const items = [
      item({ font: "NimbusMonL-Regu", text: "code()", width: 36, size: 10 }),
      item({ font: "NimbusMonL-Regu", text: "more()", width: 36, size: 10 }),
    ];
    expect([...monospaceFonts(items)]).toEqual(["NimbusMonL-Regu"]);
  });

  test("does not rescue an unmeasurable proportional face", () => {
    const items = [item({ font: "CMMI9", text: "abcd", width: 20, size: 10 })];
    expect([...monospaceFonts(items)]).toEqual([]);
  });
});

describe("readPdfLayout", () => {
  const body = "The method is straightforward to implement and efficient here.";

  test("reads a hierarchy and a fixed-width run out of a document", async () => {
    const layout = await readPdfLayout(
      makeStyledPdf([
        [
          { text: "A Document Title", size: 20, face: "bold" },
          { text: "Chapter One", size: 16, face: "bold" },
          { text: body },
          { text: body },
          { text: body },
          { text: "Subsection", size: 13, face: "bold" },
          { text: body },
          { text: "SELECT id FROM users", face: "courier" },
        ],
      ]),
      { maxPages: 200 },
    );
    expect(layout.bodySize).toBe(11);
    expect(layout.headingSizes).toEqual([20, 16, 13]);
    expect([...layout.monospaceFonts]).toEqual(["Courier"]);
    expect(layout.legible).toBe(true);
  });

  test("says so when a document is set in one size and one face", async () => {
    // Nothing here to read, and saying so is what routes it to the model pass
    // of ADR 0026 rather than producing confident nonsense.
    const layout = await readPdfLayout(makePdf([body, body, body]), {
      maxPages: 200,
    });
    expect(layout.headingSizes).toEqual([]);
    expect([...layout.monospaceFonts]).toEqual([]);
    expect(layout.legible).toBe(false);
  });

  test("refuses a document past the page cap", async () => {
    await expect(
      readPdfLayout(makePdf([body, body, body]), { maxPages: 2 }),
    ).rejects.toThrow(/too many pages/);
  });

  test("reports a corrupt file as unreadable", async () => {
    const junk = new TextEncoder().encode("%PDF-1.4\nnot actually a pdf\n");
    await expect(readPdfLayout(junk, { maxPages: 200 })).rejects.toThrow(
      /cannot read the PDF/,
    );
  });

  test("carries the page each run came from", async () => {
    const layout = await readPdfLayout(
      makeStyledPdf([[{ text: body }], [{ text: body }]]),
      { maxPages: 200 },
    );
    expect(new Set(layout.items.map((i) => i.page))).toEqual(new Set([1, 2]));
  });
});
