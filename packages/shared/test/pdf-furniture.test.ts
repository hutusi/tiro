import { describe, expect, test } from "bun:test";
import { furnitureLines } from "../src/pdf-furniture.ts";

// Distinct beyond their digits: digit runs fold to `#`, so "Body 1", "Body 2"
// would tally as one repeated line and be dropped, which is the rule working.
const WORDS = [
  "gradients",
  "estimates",
  "objectives",
  "parameters",
  "moments",
  "kernels",
  "samples",
  "tensors",
];
const body = (n: number) =>
  `Discussion of ${WORDS[n % WORDS.length]} in a sentence with enough substance.`;

/** The dropped lines of each page, as text, so a case reads as what goes. */
function dropped(pages: string[][]): string[][] {
  const drop = furnitureLines(pages);
  return pages.map((lines, page) =>
    lines.filter((_, i) => drop[page]?.has(i) === true),
  );
}

describe("furnitureLines", () => {
  test("peels a footer stacked two lines deep", () => {
    // JSTOR's stamp on every page of a scan: the outer line was dropped and
    // the one above it survived on all thirteen pages.
    const stamp = [
      "This content downloaded from 205.133.226.104 on Wed, 18 Sep 2013",
      "All use subject to JSTOR Terms and Conditions",
    ];
    const pages = [1, 2, 3, 4].map((n) => [body(n), ...stamp]);
    expect(dropped(pages)).toEqual(pages.map(() => stamp));
  });

  test("looks further in only past a line it dropped", () => {
    // The second line repeats, but the first does not: nothing outside it
    // was furniture, so it is not at the edge and is kept.
    const pages = [1, 2, 3, 4].map((n) => [
      `Chapter about ${WORDS[n]}`,
      "A subtitle that repeats",
      body(n),
    ]);
    expect(dropped(pages)).toEqual(pages.map(() => []));
  });

  test("drops heads that alternate between left and right pages", () => {
    // Each is on half the pages, under the share for the whole document.
    const pages = [1, 2, 3, 4, 5, 6].map((n) => [
      n % 2 === 1
        ? `${382 + n} P. R. HALMOS [April`
        : `1973] THE LEGEND OF JOHN VON NEUMANN ${382 + n}`,
      body(n),
    ]);
    expect(dropped(pages)).toEqual(pages.map((lines) => [lines[0] ?? ""]));
  });

  test("keeps a label that tops two pages of a short document", () => {
    // One parity of a four-page document is two pages, and two pages sharing
    // a line is still a coincidence.
    const pages = [
      ["Methods", body(1)],
      [body(2)],
      ["Methods", body(3)],
      [body(4)],
    ];
    expect(dropped(pages)).toEqual(pages.map(() => []));
  });

  test("matches a head that OCR read with different punctuation", () => {
    const heads = [
      "384 P. R. HALMOS [April",
      "386 P, R. HALMOS [April",
      "388 P. R. HALMOS [April",
      "390 P. R. HALMOS (April",
    ];
    const pages = heads.map((head, n) => [head, body(n)]);
    expect(dropped(pages)).toEqual(heads.map((head) => [head]));
  });

  test("keeps a head fused to other text, since letters are never folded", () => {
    const head = "Published as a conference paper at ICLR 2015";
    const pages = [
      [head, body(1)],
      [head, body(2)],
      [head, body(3)],
      [`${head} Figure axis label`, body(4)],
    ];
    expect(dropped(pages)[3]).toEqual([]);
  });

  test("never drops a line twice from both edges", () => {
    const pages = [["Header"], ["Header"], ["Header"], ["Header", body(4)]];
    expect(dropped(pages)).toEqual([
      ["Header"],
      ["Header"],
      ["Header"],
      ["Header"],
    ]);
  });
});
