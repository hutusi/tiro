import { describe, expect, test } from "bun:test";
import {
  checkAlignment,
  joinBlocks,
  mathRanges,
  normalizeBlockMath,
  splitBlocks,
} from "../src/blocks.ts";

const canonicalBody = [
  "# Heading",
  "",
  "First paragraph with **bold** text.",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2; // blank line above must not split this block",
  "```",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a   | 1   |",
  "",
  "- item one",
  "  - nested item",
  "- item two",
  "",
  "![cover](./assets/cover.png)",
  "",
  '<figure><img src="x.png" /></figure>',
  "",
  "Closing paragraph.",
  "",
].join("\n");

describe("splitBlocks", () => {
  test("splits top-level blocks with correct types", () => {
    const blocks = splitBlocks(canonicalBody);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "code",
      "table",
      "list",
      "paragraph",
      "html",
      "paragraph",
    ]);
  });

  test("keeps a fenced code block with blank lines as one block, byte-identical", () => {
    const blocks = splitBlocks(canonicalBody);
    const code = blocks.find((b) => b.type === "code");
    expect(code?.text).toBe(
      "```ts\nconst a = 1;\n\nconst b = 2; // blank line above must not split this block\n```",
    );
  });

  test("keeps a multi-item nested list as one block", () => {
    const blocks = splitBlocks(canonicalBody).filter((b) => b.type === "list");
    expect(blocks).toHaveLength(1);
  });

  test("keeps display math with a blank line as one block", () => {
    // Without remark-math this split into two half-delimited paragraphs:
    // unrenderable block-by-block, and two broken fragments to the
    // translator. The blank line inside is the whole point of the case.
    const body = [
      "$$",
      "\\begin{aligned}",
      "a &= b",
      "",
      "c &= d",
      "\\end{aligned}",
      "$$",
    ].join("\n");
    const blocks = splitBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("math");
    expect(blocks[0]?.text).toBe(body);
  });

  test("reads single-line $$…$$ as a paragraph, not a math block", () => {
    // micromark needs the fences on their own lines for flow math; on one
    // line it is *inline* math inside a paragraph. The processor has to
    // treat such a paragraph as verbatim, so pin the behaviour here.
    expect(splitBlocks("$$E = mc^2$$").map((b) => b.type)).toEqual([
      "paragraph",
    ]);
  });

  test("leaves prose containing dollar amounts as one paragraph", () => {
    const blocks = splitBlocks("It costs $5 to $10 depending on the plan.");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("re-reads an unclosed $$ fence as prose", () => {
    // An unclosed fence runs to end of document, so a price tier or a note
    // about the shell's $$ used to swallow the whole article into one math
    // block: copied verbatim past the translator, rendered as one red error,
    // and silent, because both sides parse identically and alignment passes.
    const body =
      "Our tiers:\n$$10 for the basic plan.\n\nSecond paragraph.\n\n## Next\n\nMore.";
    const blocks = splitBlocks(body);
    expect(blocks.map((b) => b.type)).not.toContain("math");
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "heading",
      "paragraph",
    ]);
    // Byte-identity survives the re-read: every block is still a slice.
    for (const b of blocks) expect(body).toContain(b.text);
  });

  test("re-reads prose that merely ends in $$ as prose", () => {
    // micromark closes a fence only on a delimiter-only line, so testing for
    // a trailing `$$` anywhere called this a closed math block and rendered
    // the whole thing as one red error.
    expect(
      splitBlocks("$$ — moderate\n\nThe service costs $$").map((b) => b.type),
    ).toEqual(["paragraph", "paragraph"]);
  });

  test("re-reads an unclosed fence nested in a list", () => {
    // Same mistake one level down: the block type is `list`, so a check that
    // only looked at top-level `math` nodes never saw these.
    const blocks = splitBlocks("Tiers:\n\n- $$ — moderate\n- $$$ — premium\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
    expect(blocks[1]?.text).toContain("moderate");
    expect(blocks[1]?.text).toContain("premium");
  });

  test("still reads a closed fence as math", () => {
    expect(splitBlocks("$$\nE = mc^2\n$$").map((b) => b.type)).toEqual([
      "math",
    ]);
  });

  test("returns an empty array for an empty body", () => {
    expect(splitBlocks("")).toEqual([]);
    expect(splitBlocks("\n\n")).toEqual([]);
  });
});

describe("joinBlocks", () => {
  test("round-trips a canonical body byte-identically", () => {
    expect(joinBlocks(splitBlocks(canonicalBody))).toBe(canonicalBody);
  });
});

describe("checkAlignment", () => {
  const original = splitBlocks(canonicalBody);

  test("accepts a structurally identical translation", () => {
    const translated = original.map((b) =>
      b.type === "paragraph" ? { ...b, text: "翻译后的段落。" } : b,
    );
    expect(checkAlignment(original, translated)).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("rejects a block count mismatch", () => {
    const result = checkAlignment(original, original.slice(1));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("block count mismatch");
  });

  test("rejects a per-index type mismatch", () => {
    const translated = original.map((b, i) =>
      i === 0 ? { ...b, type: "paragraph" } : b,
    );
    const result = checkAlignment(original, translated);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("type mismatch");
  });

  test("rejects an altered code block", () => {
    const translated = original.map((b) =>
      b.type === "code"
        ? { ...b, text: b.text.replace("const a", "const 甲") }
        : b,
    );
    const result = checkAlignment(original, translated);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("code block was altered");
  });

  test("rejects an altered math block", () => {
    const mathBody = "Before.\n\n$$\nE = mc^2\n$$\n\nAfter.";
    const mathOriginal = splitBlocks(mathBody);
    expect(mathOriginal.map((b) => b.type)).toEqual([
      "paragraph",
      "math",
      "paragraph",
    ]);
    const translated = mathOriginal.map((b) =>
      b.type === "math" ? { ...b, text: "$$\nE = mc^{2}\n$$" } : b,
    );
    const result = checkAlignment(mathOriginal, translated);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("math block was altered");
  });
});

describe("mathRanges", () => {
  const text = "The variance $d_k$ grows as $O(n^2)$.";

  test("reports each formula's delimiters by offset", () => {
    const ranges = mathRanges(text, { singleDollar: true });
    expect(ranges.map((r) => r.value)).toEqual(["d_k", "O(n^2)"]);
    // Offsets span the delimiters, so a caller can splice rather than guess.
    expect(text.slice(ranges[0]?.start, ranges[0]?.end)).toBe("$d_k$");
    expect(text.slice(ranges[1]?.start, ranges[1]?.end)).toBe("$O(n^2)$");
  });

  test("reads single dollars as math only when asked to", () => {
    expect(mathRanges(text, { singleDollar: false })).toEqual([]);
    // The reason the option exists: without it, a price becomes a formula.
    expect(
      mathRanges("costs $5 to $10", { singleDollar: true }).map((r) => r.value),
    ).toEqual(["5 to "]);
    expect(mathRanges("costs $5 to $10", { singleDollar: false })).toEqual([]);
  });

  test("finds display math nested in a list or a blockquote", () => {
    // A formula inside a list item makes the top-level block a `list`, so it
    // is not verbatim; unless it is reported here it reaches the model raw.
    const inList = mathRanges("- First\n\n  $$\n  E=mc^2\n  $$\n", {
      singleDollar: true,
    });
    expect(inList).toHaveLength(1);
    expect(inList[0]?.display).toBe(true);
    expect(inList[0]?.terminated).toBe(true);
    expect(inList[0]?.value).toBe("E=mc^2");

    const inQuote = mathRanges("> q\n>\n> $$\n> E=mc^2\n> $$", {
      singleDollar: true,
    });
    expect(inQuote.map((r) => r.value)).toEqual(["E=mc^2"]);
  });

  test("marks an unclosed fence as unterminated", () => {
    const ranges = mathRanges("- $$ — moderate\n- $$$ — premium\n", {
      singleDollar: true,
    });
    expect(ranges).toHaveLength(2);
    expect(ranges.every((r) => r.display && !r.terminated)).toBe(true);
  });

  test("still finds doubled delimiters with single dollars off", () => {
    expect(
      mathRanges("scales as $$O(n)$$ here", { singleDollar: false }).map(
        (r) => r.value,
      ),
    ).toEqual(["O(n)"]);
  });
});

describe("normalizeBlockMath", () => {
  test("escapes an unclosed fence so it renders as the prose it is", () => {
    expect(normalizeBlockMath("$$10 for the basic plan.")).toBe(
      "\\$\\$10 for the basic plan.",
    );
    expect(normalizeBlockMath("$$ is the shell PID variable.")).toBe(
      "\\$\\$ is the shell PID variable.",
    );
  });

  test("escapes an unclosed fence nested in a list, delimiters and all", () => {
    // Left alone these render as two empty KaTeX displays and the item text
    // disappears. The whole run has to go: escaping "$$$" as "\\$\\$$" would
    // leave a stray delimiter behind.
    expect(normalizeBlockMath("- $$ — moderate\n- $$$ — premium\n")).toBe(
      "- \\$\\$ — moderate\n- \\$\\$\\$ — premium\n",
    );
  });

  test("escapes chained openers, not just the first", () => {
    // An unclosed fence swallows everything after it, so the parse that finds
    // it cannot see the opener hiding on the next line. Escaping once revealed
    // that one, which then ate "premium" as an empty formula of its own.
    expect(normalizeBlockMath("$$ — moderate\n$$$ — premium")).toBe(
      "\\$\\$ — moderate\n\\$\\$\\$ — premium",
    );
    expect(normalizeBlockMath("> $$ — moderate\n> $$$ — premium")).toBe(
      "> \\$\\$ — moderate\n> \\$\\$\\$ — premium",
    );
  });

  test("leaves nothing unterminated behind, however many are chained", () => {
    for (const source of [
      "$$ a\n$$$ b\n$$$$ c",
      "> $$ a\n> $$$ b",
      "- $$ a\n- $$$ b\n",
    ]) {
      const normalized = normalizeBlockMath(source);
      expect(
        mathRanges(normalized, { singleDollar: true }).filter(
          (r) => !r.terminated,
        ),
      ).toEqual([]);
    }
  });

  test("stays fast when a block is nothing but openers", () => {
    // Reparsing per cascade step is quadratic: 1000 such lines took ~7.8s,
    // and this runs at site-build time on clipped content.
    const source = Array.from({ length: 1000 }, (_, i) => `$$ tier ${i}`).join(
      "\n",
    );
    const started = performance.now();
    const normalized = normalizeBlockMath(source);
    expect(performance.now() - started).toBeLessThan(2000);
    // The bounded path must still leave nothing for KaTeX to eat.
    expect(
      mathRanges(normalized, { singleDollar: true }).filter(
        (r) => !r.terminated,
      ),
    ).toEqual([]);
    expect(normalized).toContain("tier 999");
  });

  test("escapes fences in lists nested past the reparse limit", () => {
    // Each level's opener is only revealed once the one above it is escaped,
    // so a list deeper than MAX_ESCAPE_PASSES falls to the linear pass — which
    // matched only whitespace and `>`, leaving the deepest opener live to hide
    // its item. Depths either side of the limit, and well past it.
    for (const depth of [8, 9, 10, 30]) {
      const source = Array.from(
        { length: depth },
        (_, i) => `${"  ".repeat(i)}- $$ tier ${i}`,
      ).join("\n");
      const normalized = normalizeBlockMath(source);
      expect(
        mathRanges(normalized, { singleDollar: true }).filter(
          (r) => !r.terminated,
        ),
      ).toEqual([]);
      expect(normalized).toContain(`tier ${depth - 1}`);
    }
  });

  test("handles ordered and blockquoted list markers too", () => {
    for (const build of [
      (i: number) => `${"   ".repeat(i)}${i + 1}. $$ t${i}`,
      (i: number) => `> ${"  ".repeat(i)}- $$ t${i}`,
    ]) {
      const source = Array.from({ length: 12 }, (_, i) => build(i)).join("\n");
      expect(
        mathRanges(normalizeBlockMath(source), { singleDollar: true }).filter(
          (r) => !r.terminated,
        ),
      ).toEqual([]);
    }
  });

  test("handles containers alternating to any depth", () => {
    // Markdown lets list and blockquote markers interleave freely. Spelling
    // that out as a prefix pattern always misses a combination, so candidates
    // come from where the parser says a text node starts — which is after
    // every container, whatever they were.
    const cascade = (tail: string) =>
      [...Array.from({ length: 12 }, (_, i) => `$$ tier ${i}`), "", tail].join(
        "\n",
      );
    for (const tail of [
      "- > $$ hidden",
      "> - > $$ hidden",
      "- - $$ hidden",
      "1. > $$ hidden",
      ">>> $$ hidden",
      "- 1. > - $$ hidden",
    ]) {
      const normalized = normalizeBlockMath(cascade(tail));
      expect(normalized).toContain("hidden");
      expect(
        mathRanges(normalized, { singleDollar: true }).filter(
          (r) => !r.terminated,
        ),
      ).toEqual([]);
    }
  });

  test("leaves a mid-line $$ in prose alone", () => {
    // A text node can also start mid-line, after emphasis or a link, and
    // `**a**$$ x` is prose rather than a fence — escaping it would put visible
    // backslashes into the sentence.
    const source = [
      ...Array.from({ length: 12 }, (_, i) => `$$ tier ${i}`),
      "",
      "**a**$$ x",
    ].join("\n");
    expect(normalizeBlockMath(source)).toContain("**a**$$ x");
  });

  test("never escapes inside anything the parser does not call prose", () => {
    // Naming the shapes to protect is open-ended — fenced, then indented, then
    // inline, then raw <pre> — and each omission puts visible backslashes into
    // someone's snippet. Escaping only text closes it, so this covers the
    // literal shapes together, including ones no review has reported.
    const cascade = (tail: string[]) => {
      const lines = ["- item"];
      for (let i = 0; i < 12; i += 1) lines.push(`  $$ tier ${i}`);
      return [...lines, "", ...tail].join("\n");
    };
    const shapes: [string[], string][] = [
      [["  <pre>", "  $$ is the shell PID", "  </pre>"], "$$ is the shell PID"],
      [["  ```sh", "  $$ is the shell PID", "  ```"], "$$ is the shell PID"],
      [["      $$ indented code"], "$$ indented code"],
      [["  <div>", "  $$ raw html", "  </div>"], "$$ raw html"],
    ];
    for (const [tail, preserved] of shapes) {
      const normalized = normalizeBlockMath(cascade(tail));
      expect(normalized).toContain(preserved);
      expect(normalized).not.toContain(`\\$\\${preserved.slice(1)}`);
      // The prose fences around it must still all be dealt with.
      expect(
        mathRanges(normalized, { singleDollar: true }).filter(
          (r) => !r.terminated,
        ),
      ).toEqual([]);
    }
  });

  test("never escapes inside code, even on the linear pass", () => {
    // The math parser cannot see a code fence swallowed by an unclosed one, so
    // the linear pass reads structure with the math-free parser instead —
    // otherwise a shell snippet gains a visible `\\$\\$`.
    const lines = ["- item"];
    for (let i = 0; i < 12; i += 1) lines.push(`  $$ tier ${i}`);
    lines.push("", "  ```sh", "  $$ is the shell PID", "  ```");
    const normalized = normalizeBlockMath(lines.join("\n"));
    expect(normalized).toContain("  $$ is the shell PID");
    expect(normalized).not.toContain("\\$\\$ is the shell");
    expect(
      mathRanges(normalized, { singleDollar: true }).filter(
        (r) => !r.terminated,
      ),
    ).toEqual([]);
  });

  test("treats a lone trailing $$ as delimiters, not an empty formula", () => {
    // One line cannot be both opener and closer, but testing only the last
    // line said it was — so the delimiters rendered as a blank display block.
    expect(normalizeBlockMath("Some text\n\n$$")).toBe("Some text\n\n\\$\\$");
    // An opener and a closer on separate lines is still a formula.
    expect(normalizeBlockMath("$$\n$$")).toBe("$$\n$$");
  });

  test("leaves closed math nested in a list alone", () => {
    const nested = "- First\n\n  $$\n  E=mc^2\n  $$\n";
    expect(normalizeBlockMath(nested)).toBe(nested);
  });

  test("promotes a single-line $$…$$ paragraph to display math", () => {
    // micromark needs the fences on their own lines for a display block, so
    // one line renders inline — no centring, no overflow box.
    expect(normalizeBlockMath("$$E = mc^2$$")).toBe("$$\nE = mc^2\n$$");
  });

  test("leaves inline math, real display math, and prose alone", () => {
    expect(normalizeBlockMath("$x$")).toBe("$x$");
    expect(normalizeBlockMath("$$\nE = mc^2\n$$")).toBe("$$\nE = mc^2\n$$");
    expect(normalizeBlockMath("costs $5 to $10")).toBe("costs $5 to $10");
    expect(normalizeBlockMath("plain prose")).toBe("plain prose");
  });
});
