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
    // Derived, not assumed: the furniture rule only applies to documents long
    // enough for repetition to mean something, and a hardcoded 1 silently
    // switched it off.
    totalPages: Math.max(1, ...items.map((i) => i.page)),
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

  test("joins a wrapped heading whose leading is bigger than the body's", () => {
    // Leading scales with type. A 20pt title set 28pt apart is tightly packed,
    // while an 11pt body 28pt apart has a paragraph break in it — measured
    // against the body's leading alone, this title came out as two headings.
    const md = pdfMarkdown(
      layout(
        [
          line("A Title That Runs", 785, { size: 20 }),
          line("Onto A Second Line", 757, { size: 20 }),
        ],
        [20],
      ),
    );
    expect(md.trim()).toBe("# A Title That Runs Onto A Second Line");
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

describe("pdfMarkdown code indentation", () => {
  test("keeps indentation inside a fence", () => {
    // Code without it is still code and markedly worse to read, and the
    // offsets are right there in the runs.
    const mono = { font: "Courier", mono: true };
    const md = pdfMarkdown(
      layout([
        { ...line("function f() {", 700), ...mono, x: 72 },
        { ...line("return 1;", 680), ...mono, x: 85 },
        { ...line("}", 660), ...mono, x: 72 },
      ]),
    );
    expect(md.trim()).toBe("```\nfunction f() {\n  return 1;\n}\n```");
  });

  test("measures indentation from the block's own left edge", () => {
    // A block set in from the margin must not arrive drowning in spaces.
    const mono = { font: "Courier", mono: true };
    const md = pdfMarkdown(
      layout([
        { ...line("a", 700), ...mono, x: 200 },
        { ...line("b", 680), ...mono, x: 200 },
      ]),
    );
    expect(md.trim()).toBe("```\na\nb\n```");
  });
});

describe("pdfMarkdown reading order", () => {
  test("keeps two columns apart instead of interleaving them", () => {
    // A PDF's content stream carries reading order — a two-column paper emits
    // the left column top to bottom and then the right. Sorting runs by height
    // interleaved them and produced "Left column first Right column first" on
    // one line, which is how a whole paper came out as nonsense.
    const md = pdfMarkdown(
      layout([
        { ...line("Left column first", 700), x: 72 },
        { ...line("left column second", 680), x: 72 },
        { ...line("Right column first", 700), x: 320 },
        { ...line("right column second", 680), x: 320 },
      ]),
    );
    expect(md).toContain("Left column first left column second");
    expect(md).toContain("Right column first right column second");
    expect(md).not.toContain("Left column first Right column first");
  });
});

describe("pdfMarkdown furniture", () => {
  test("drops a header the document repeats on every page", () => {
    // The flat-text path has done this since ADR 0026; this one put the same
    // journal header into the Markdown once per page.
    const head = "Journal of Irreproducible Results";
    // Genuinely different per page, not merely differing by a number: digit
    // runs are normalised, so "Body of page 1/2/3" would itself tally as one
    // repeated line and be dropped as a footer. That is the rule working — it
    // is how "Page 3 of 15" is matched — but it makes uniform bodies useless.
    const bodies = [
      "Gradients are estimated from the sampled minibatch.",
      "Momentum accumulates across successive update steps.",
      "Convergence follows from the bounded regret argument.",
    ];
    const items = [1, 2, 3].flatMap((page) => [
      { ...line(head, 760), page },
      { ...line(bodies[page - 1] ?? "", 700), page },
    ]);
    const md = pdfMarkdown(layout(items));
    expect(md).not.toContain(head);
    expect(md).toContain("Gradients are estimated");
    expect(md).toContain("Convergence follows");
  });

  test("leaves a short document alone", () => {
    const head = "A Heading Line";
    const bodies = ["Gradients are estimated here.", "Momentum accumulates."];
    const items = [1, 2].flatMap((page) => [
      { ...line(head, 760), page },
      { ...line(bodies[page - 1] ?? "", 700), page },
    ]);
    expect(pdfMarkdown(layout(items))).toContain(head);
  });
});

describe("pdfMarkdown fences", () => {
  test("uses a rail nothing inside can close", () => {
    // A code block containing three backticks otherwise parsed as code, then a
    // paragraph, then more code.
    const mono = { font: "Courier", mono: true };
    const md = pdfMarkdown(
      layout([
        { ...line("before", 700), ...mono },
        { ...line("```", 680), ...mono },
        { ...line("after", 660), ...mono },
      ]),
    );
    expect(md.trim().startsWith("````")).toBe(true);
    expect(md).toContain("```\n");
    // One block, not three.
    expect(md.split("````").length - 1).toBe(2);
  });

  test("keeps column alignment inside a fenced table", () => {
    // Collapsing each gap to one space is what a fenced table loses everything
    // to — the alignment is the only thing it had.
    const row = (y: number, a: string, b: string): PdfTextItem[] => [
      { ...line(a, y), x: 72, width: 40 },
      { ...line(b, y), x: 300, width: 40 },
    ];
    const md = pdfMarkdown(
      layout([...row(700, "Name", "Value"), ...row(680, "Longer name", "2")]),
    );
    const rows = md
      .split("\n")
      .filter((l) => l.includes("Value") || l.includes("2"));
    // The second column starts at the same offset on both rows.
    expect(rows[0]?.indexOf("Value")).toBe(rows[1]?.indexOf("2") ?? -1);
  });
});

describe("pdfMarkdown lists that wrap", () => {
  test("keeps a list whose item runs onto a second line", () => {
    // A wrapped item hangs: its continuation aligns with the item's text, not
    // with the bullet. That indent is what tells it from a new paragraph.
    const md = pdfMarkdown(
      layout([
        line("• First item that is long enough to", 700),
        { ...line("wrap onto a second line", 680), x: 86 },
        line("• Second item", 660),
      ]),
    );
    expect(md).toContain(
      "- First item that is long enough to wrap onto a second line",
    );
    expect(md).toContain("- Second item");
  });

  test("keeps a list that follows a sentence introducing it", () => {
    const md = pdfMarkdown(
      layout([
        line("Each PR does one thing well:", 700),
        line("• First", 680),
        line("• Second", 660),
      ]),
    );
    expect(md).toContain("Each PR does one thing well:");
    expect(md).toContain("- First\n- Second");
    expect(md).not.toContain("• ");
  });
});

describe("pdfMarkdown list boundaries", () => {
  test("does not swallow the prose that follows a list", () => {
    // A line back at the margin has left the list. Treating every unbulleted
    // line as a continuation produced "- Second point Conclusion after the
    // list."
    const md = pdfMarkdown(
      layout([
        line("• First point", 700),
        line("• Second point", 680),
        line("Conclusion after the list.", 660),
      ]),
    );
    expect(md).toContain("- First point\n- Second point");
    expect(md).toContain("\n\nConclusion after the list.");
    expect(md).not.toContain("Second point Conclusion");
  });

  test("still hangs a genuine continuation under its bullet", () => {
    const md = pdfMarkdown(
      layout([
        line("• A point that wraps", 700),
        { ...line("onto the next line", 680), x: 86 },
        line("Prose at the margin.", 660),
      ]),
    );
    expect(md).toContain("- A point that wraps onto the next line");
    expect(md).toContain("\n\nProse at the margin.");
  });
});

describe("pdfMarkdown fence spacing", () => {
  test("does not insert a space where the page left none", () => {
    // `foo` in Courier followed by `Bar` in Courier-Bold is one word split by
    // a font change, not two.
    const md = pdfMarkdown(
      layout([
        {
          ...line("foo", 700),
          x: 72,
          width: 18,
          font: "Courier",
          mono: true,
        },
        {
          ...line("Bar", 700),
          x: 90,
          width: 18,
          font: "Courier-Bold",
          mono: true,
        },
      ]),
    );
    expect(md).toContain("fooBar");
    expect(md).not.toContain("foo Bar");
  });
});

describe("pdfMarkdown columns", () => {
  /** Twelve runs so the gutter has enough on each side to be believed. */
  function twoColumns(alternating: boolean): PdfTextItem[] {
    const left: PdfTextItem[] = [];
    const right: PdfTextItem[] = [];
    for (let i = 1; i <= 6; i += 1) {
      left.push({
        ...line(`Left line ${i} of the column`, 760 - i * 20),
        x: 72,
      });
      right.push({
        ...line(`Right line ${i} of the column`, 760 - i * 20),
        x: 320,
      });
    }
    if (!alternating) return [...left, ...right];
    return left.flatMap((l, i) => [l, right[i] as PdfTextItem]);
  }

  test("reads a column at a time when the page is drawn that way", () => {
    const md = pdfMarkdown(layout(twoColumns(false)));
    expect(md).toContain("Left line 1 of the column Left line 2");
    expect(md).not.toContain("Left line 1 of the column Right line 1");
  });

  test("and when the page is drawn row by row", () => {
    // Content order is usually reading order, and nothing requires it. A
    // generator drawing row by row produced "Left 1 Right 1" on one line,
    // which then read as a table and was fenced — and fenced prose is never
    // translated, because `code` is verbatim by contract.
    const md = pdfMarkdown(layout(twoColumns(true)));
    expect(md).toContain("Left line 1 of the column Left line 2");
    expect(md).not.toContain("Left line 1 of the column Right line 1");
    expect(md).not.toContain("```");
  });

  test("leaves a single-column page alone", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      line(
        `A line of ordinary prose, number ${i}, set across the page.`,
        700 - i * 20,
      ),
    );
    const md = pdfMarkdown(layout(items));
    expect(md).not.toContain("```");
    expect(md.split("\n\n").length).toBeLessThan(4);
  });
});

describe("pdfMarkdown columns versus tables", () => {
  test("does not read a two-field table as two page columns", () => {
    // The mirror of the failure column detection was added to fix. A table's
    // fields are as widely spaced as page columns; what tells them apart is
    // that prose fills its column and cells do not. Read as columns, every
    // left cell moved above every right one and the rows were lost.
    const items: PdfTextItem[] = [];
    for (let i = 1; i <= 10; i += 1) {
      items.push({ ...line(`Metric ${i}`, 700 - i * 18), x: 72 });
      items.push({ ...line(`${i * 11}`, 700 - i * 18), x: 320 });
    }
    const md = pdfMarkdown(layout(items));
    expect(md).toContain("Metric 1");
    // Each value stays on the row it belongs to.
    const row = md.split("\n").find((l) => l.includes("Metric 3"));
    expect(row).toContain("33");
    expect(md).not.toContain("Metric 9 Metric 10");
  });

  test("still separates columns on a short page", () => {
    // Requiring eight runs before looking missed a page holding a title and
    // two lines of each column, which then interleaved.
    const md = pdfMarkdown(
      layout([
        { ...line("A Page Title Spanning Both Columns Here", 760), x: 72 },
        { ...line("Left 1 of the column text", 700), x: 72 },
        { ...line("Right 1 of the column text", 700), x: 320 },
        { ...line("Left 2 of the column text", 680), x: 72 },
        { ...line("Right 2 of the column text", 680), x: 320 },
      ]),
    );
    expect(md).toContain("Left 1 of the column text Left 2 of the column text");
    expect(md).not.toContain("Left 1 of the column text Right 1");
  });
});
