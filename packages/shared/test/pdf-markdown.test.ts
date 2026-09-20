import { describe, expect, test } from "bun:test";
import type { PdfLayout, PdfTextItem } from "../src/pdf-layout.ts";
import { pdfMarkdown } from "../src/pdf-markdown.ts";

/** A line of a synthetic page. Positions are chosen, not measured, so each
 * rule can be exercised on its own. */
function line(
  text: string,
  y: number,
  over: Partial<PdfTextItem> = {},
): PdfTextItem {
  return {
    text,
    font: "Helvetica",
    size: 11,
    x: 72,
    y,
    page: 1,
    width: text.length * 5,
    endsLine: true,
    mono: false,
    ...over,
  };
}

function layout(items: PdfTextItem[], headings: number[] = []): PdfLayout {
  return {
    items,
    totalPages: 1,
    bodySize: 11,
    headingSizes: headings,
    monospaceFonts: new Set(items.filter((i) => i.mono).map((i) => i.font)),
    legible: true,
  };
}

/** 20pt apart is one paragraph; 28 starts the next — the spacing measured off
 * the document that prompted all of this. */
const LINE = 20;
const PARA = 28;

describe("pdfMarkdown headings", () => {
  test("takes the level from the size's rank, not its value", () => {
    const md = pdfMarkdown(
      layout(
        [
          line("The Title", 700, { size: 20 }),
          line("A Chapter", 640, { size: 16 }),
          line("A Subsection", 580, { size: 13 }),
          line("Body text here.", 520),
        ],
        [20, 16, 13],
      ),
    );
    expect(md).toContain("# The Title");
    expect(md).toContain("## A Chapter");
    expect(md).toContain("### A Subsection");
  });

  test("caps at three levels", () => {
    const md = pdfMarkdown(
      layout([line("Deep", 700, { size: 12 })], [20, 16, 13, 12]),
    );
    expect(md.trim()).toBe("### Deep");
  });

  test("joins a heading the page wrapped", () => {
    // The page broke the line, not the author.
    const md = pdfMarkdown(
      layout(
        [
          line("Unblock your team: the engineering", 700, { size: 20 }),
          line("guide to stacked pull requests", 700 - LINE, { size: 20 }),
        ],
        [20],
      ),
    );
    expect(md.trim()).toBe(
      "# Unblock your team: the engineering guide to stacked pull requests",
    );
  });

  test("leaves body text alone", () => {
    const md = pdfMarkdown(layout([line("Just a sentence.", 700)], [20]));
    expect(md.trim()).toBe("Just a sentence.");
  });
});

describe("pdfMarkdown paragraphs", () => {
  test("joins wrapped lines and splits on the wider gap", () => {
    const md = pdfMarkdown(
      layout([
        line("Picture this morning's standup:", 700),
        line("what is blocking you?", 700 - LINE),
        line("Sound familiar? The board tells", 700 - LINE - PARA),
        line("the story.", 700 - LINE - PARA - LINE),
      ]),
    );
    expect(md.trim()).toBe(
      "Picture this morning's standup: what is blocking you?\n\n" +
        "Sound familiar? The board tells the story.",
    );
  });

  test("rejoins a word the page hyphenated", () => {
    const md = pdfMarkdown(
      layout([
        line("is straightforward to imple-", 700),
        line("ment and efficient.", 680),
      ]),
    );
    expect(md).toContain("implement and efficient.");
    expect(md).not.toContain("imple- ment");
  });

  test("keeps a real hyphen before a capital or a digit", () => {
    const md = pdfMarkdown(
      layout([line("the Smith-", 700), line("Waterman algorithm", 680)]),
    );
    expect(md).toContain("Smith- Waterman");
  });
});

describe("pdfMarkdown code", () => {
  test("fences a run set entirely in a fixed-width face", () => {
    const md = pdfMarkdown(
      layout([
        line("SELECT id FROM users", 700, { font: "Courier", mono: true }),
        line("ORDER BY created_at", 700 - LINE, {
          font: "Courier",
          mono: true,
        }),
      ]),
    );
    expect(md.trim()).toBe(
      "```\nSELECT id FROM users\nORDER BY created_at\n```",
    );
  });

  test("does not fence a monospace word inside a sentence", () => {
    // A line counts as code only if all of it is.
    const items = [
      line("Run the ", 700),
      { ...line("git rebase", 700), x: 120, font: "Courier", mono: true },
      { ...line(" command now.", 700), x: 200 },
    ];
    const md = pdfMarkdown(layout(items));
    expect(md).not.toContain("```");
    expect(md).toContain("git rebase");
  });

  test("separates code from the prose around it", () => {
    const md = pdfMarkdown(
      layout([
        line("Then run:", 700),
        line("npm install", 700 - LINE, { font: "Courier", mono: true }),
        line("and wait.", 700 - LINE * 2),
      ]),
    );
    expect(md.trim()).toBe("Then run:\n\n```\nnpm install\n```\n\nand wait.");
  });
});

describe("pdfMarkdown lists and tables", () => {
  test("turns a bulleted block into a markdown list", () => {
    const md = pdfMarkdown(
      layout([
        line("• First point", 700),
        line("• Second point", 700 - LINE),
        line("• Third point", 700 - LINE * 2),
      ]),
    );
    expect(md.trim()).toBe("- First point\n- Second point\n- Third point");
  });

  test("accepts numbered items", () => {
    const md = pdfMarkdown(
      layout([line("1. First", 700), line("2. Second", 700 - LINE)]),
    );
    expect(md.trim()).toBe("- First\n- Second");
  });

  test("fences a block whose lines share columns rather than rebuilding it", () => {
    // ADR 0028 clause 7: a mis-read column corrupts data, a fenced block only
    // looks plain.
    const row = (y: number, a: string, b: string): PdfTextItem[] => [
      { ...line(a, y), x: 72, width: 40 },
      { ...line(b, y), x: 300, width: 40 },
    ];
    const md = pdfMarkdown(
      layout([
        ...row(700, "Model", "BLEU"),
        ...row(700 - LINE, "GNMT", "24.6"),
        ...row(700 - LINE * 2, "ConvS2S", "25.2"),
      ]),
    );
    expect(md).toContain("```");
    expect(md).not.toContain("|");
  });
});
