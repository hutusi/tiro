import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface Block {
  /** mdast node type of the top-level block (paragraph, heading, code, …). */
  type: string;
  /** The block's exact source text, sliced from the original document. */
  text: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
/**
 * Without single-dollar math, matching how the site renders an article that
 * has not declared its dollar signs curated (frontmatter `has_math`).
 */
const dollarSafeParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false });
/** No math at all — used to re-read a `$$` fence that was never closed. */
const proseParser = unified().use(remarkParse).use(remarkGfm);

/**
 * A closed `$$` fence ends with one. An unclosed one runs to end of document,
 * exactly like an unterminated code fence — see `splitBlocks`.
 */
const CLOSED_MATH_FENCE = /\$\$+[ \t]*$/;

/**
 * Block types a translation must reproduce byte-for-byte. Code is obvious;
 * `$$…$$` math is the same kind of content — a notation the model has no
 * business rewriting, where a single altered character changes the meaning
 * or stops parsing altogether. Exported so the processor can guarantee it
 * never sends to the LLM anything `checkAlignment` will demand back unchanged.
 */
export const VERBATIM_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "code",
  "math",
]);

/**
 * True when a paragraph's entire content is one inline-math node — i.e. the
 * author wrote `$$E = mc^2$$` on a single line. micromark needs the `$$`
 * fences on their own lines to produce a `math` block, so on one line it is
 * inline math inside a paragraph and the block-type check above misses it.
 * The translator needs to know: it is notation, not prose, whatever mdast
 * calls the block it landed in.
 */
export function isInlineMathOnlyParagraph(text: string): boolean {
  if (!text.startsWith("$")) return false;
  const [node] = (parser.parse(text) as Root).children;
  return (
    node?.type === "paragraph" &&
    node.children.length === 1 &&
    node.children[0]?.type === "inlineMath"
  );
}

export interface InlineMathRange {
  /** Offset of the opening delimiter in the text this was read from. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** The LaTeX between the delimiters. */
  value: string;
}

/**
 * Every inline formula in a block, with the source offsets of its delimiters,
 * so a caller can splice rather than pattern-match its way around LaTeX.
 *
 * `singleDollar` must match how the site will render the article — the
 * frontmatter `has_math` flag. Reading `$…$` as math in an article that never
 * declared its dollars curated would find "5 to " inside "costs $5 to $10" and
 * treat a price as a formula, which is the exact mistake the flag exists to
 * prevent.
 */
export function inlineMathRanges(
  text: string,
  options: { singleDollar: boolean },
): InlineMathRange[] {
  const tree = (options.singleDollar ? parser : dollarSafeParser).parse(
    text,
  ) as Root;
  const found: InlineMathRange[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      value?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    if (n.type === "inlineMath") {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        found.push({ start, end, value: n.value ?? "" });
      }
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/**
 * Make a block's math render the way `splitBlocks` classified it.
 *
 * Two disagreements are possible between the contract's view of a block and
 * what a renderer re-parsing that block alone would decide:
 *
 * - A `$$` fence that never closed is prose (see `splitBlocks`), but a
 *   renderer given the block on its own would still read it as math running to
 *   the end and print one red error. Escaping the fence says what the block is.
 * - `$$E = mc^2$$` on a single line is *inline* math to micromark, which needs
 *   the fences on their own lines for a display block. A paragraph that is
 *   nothing but a formula in doubled delimiters means display, and rendering it
 *   inline loses the centring and the overflow box a wide formula needs.
 *
 * Renderers only. This rewrites text, so it must never touch what
 * `splitBlocks` slices or the byte-identity contract breaks.
 */
export function normalizeBlockMath(text: string): string {
  const tree = parser.parse(text) as Root;
  const unterminated = tree.children.filter((node) => {
    if (node.type !== "math") return false;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return false;
    return !CLOSED_MATH_FENCE.test(text.slice(start, end));
  });
  if (unterminated.length > 0) {
    let out = text;
    // Back to front, so earlier offsets stay valid.
    for (const node of unterminated.reverse()) {
      const start = node.position?.start.offset ?? 0;
      out = `${out.slice(0, start)}\\$\\$${out.slice(start + 2)}`;
    }
    return out;
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("$$") && isInlineMathOnlyParagraph(trimmed)) {
    return `$$\n${trimmed.slice(2, -2).trim()}\n$$`;
  }
  return text;
}

/**
 * Split a markdown body (frontmatter already stripped — see parseArticle)
 * into its top-level blocks. Block text is sliced from the source by mdast
 * offsets, never re-stringified, so untouched blocks stay byte-identical —
 * the translation alignment contract (ADR 0003) depends on this. mdast
 * guarantees that blank lines inside fenced code do not split a block.
 *
 * remark-math is part of the parser so `$$…$$` is one `math` block for the
 * same reason: without it, display math containing a blank line splits into
 * two half-delimited paragraphs, which the site (rendering block by block)
 * can never typeset and the translator sees as two broken fragments.
 *
 * An **unclosed** `$$` runs to the end of the document, the way an
 * unterminated code fence does, and that is far more likely to be prose than
 * intent: "$$ is the shell's PID", a "$$ — moderate" price tier, "$$10 for the
 * basic plan". Left alone it swallows the rest of the article into one `math`
 * block, which is then copied verbatim past the translator and rendered as a
 * single red KaTeX error — silently, because both sides parse identically and
 * alignment still passes. So a math block that never closed is re-read as
 * prose. The blocks it yields are still sliced from `body`, so byte-identity
 * holds either way.
 */
export function splitBlocks(body: string): Block[] {
  return blocksFrom(body, parser);
}

function blocksFrom(source: string, from: typeof parser): Block[] {
  const tree = from.parse(source) as Root;
  return tree.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error(
        `mdast node of type "${node.type}" has no source position`,
      );
    }
    const text = source.slice(start, end);
    if (node.type === "math" && !CLOSED_MATH_FENCE.test(text)) {
      // proseParser has no math extension, so this cannot recurse forever.
      return blocksFrom(text, proseParser);
    }
    return [{ type: node.type, text }];
  });
}

/** Reassemble blocks into a canonical markdown body (blank-line separated). */
export function joinBlocks(blocks: readonly Block[]): string {
  return `${blocks
    .map((b) => b.text)
    .join("\n\n")
    .trimEnd()}\n`;
}

export interface AlignmentResult {
  ok: boolean;
  errors: string[];
}

/**
 * Verify the 1:1 alignment contract between an original body's blocks and a
 * translation's blocks: equal count, equal type per index, and byte-identical
 * code and math blocks (translators must copy them verbatim).
 */
export function checkAlignment(
  original: readonly Block[],
  translated: readonly Block[],
): AlignmentResult {
  const errors: string[] = [];
  if (original.length !== translated.length) {
    errors.push(
      `block count mismatch: original ${original.length}, translated ${translated.length}`,
    );
    return { ok: false, errors };
  }
  original.forEach((block, i) => {
    const other = translated[i];
    if (other === undefined) return;
    if (block.type !== other.type) {
      errors.push(
        `block ${i}: type mismatch (original "${block.type}", translated "${other.type}")`,
      );
    } else if (
      VERBATIM_BLOCK_TYPES.has(block.type) &&
      block.text !== other.text
    ) {
      errors.push(`block ${i}: ${block.type} block was altered by translation`);
    }
  });
  return { ok: errors.length === 0, errors };
}
