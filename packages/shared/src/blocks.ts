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
 * micromark closes a `$$` fence only on a line that holds nothing but
 * delimiters, so testing for a trailing `$$` anywhere is not the same
 * question: it calls prose like "The service costs $$" a closed math block.
 * Leading whitespace and `>` are allowed because a nested fence's source
 * carries its list indentation or its blockquote marker.
 */
const CLOSING_FENCE_LINE = /^[ \t>]*\$\$+[ \t]*$/;

function isTerminatedFence(source: string): boolean {
  const lines = source.replace(/\s+$/, "").split("\n");
  // A closed fence needs an opener line and a closer line. On one line there
  // is only an opener that reached the end of its input — the opener itself
  // looks like a delimiter-only line, so testing the last line alone called a
  // trailing lone "$$" a formula and rendered it as an empty display block,
  // swallowing the delimiters the author actually wrote.
  if (lines.length < 2) return false;
  return CLOSING_FENCE_LINE.test(lines[lines.length - 1] ?? "");
}

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
 * Source ranges of content that must survive a rewrite byte-for-byte, at any
 * nesting depth.
 *
 * The any-depth counterpart to `VERBATIM_BLOCK_TYPES` above, which answers the
 * same question for a *top-level* block only. A tool that rewrites markdown in
 * place needs the deeper answer: a fence inside a list item is still code.
 *
 * Asking the parser is the point. Recognising these by line shape means naming
 * every way one can be written — fence length, indented code, an inline span, a
 * `$$…$$` that opens and closes on one line — and each omission silently
 * rewrites something that was never prose. See `proseRanges` below, which made
 * the same argument for the allowlist it uses; a caller that must work *between*
 * nodes rather than inside them cannot use that allowlist, and this is the
 * nearest safe thing.
 *
 * An unterminated `$$` is *not* protected, matching `blocksFrom` below: such a
 * fence is prose wearing a delimiter, and remark hands back the whole rest of
 * the document as one math node. Protecting that would silence every caller
 * downstream of it. The slice is re-read without the math extension instead, so
 * code genuinely inside the swallowed region keeps its protection.
 */
export function verbatimRanges(text: string): { start: number; end: number }[] {
  return rangesFrom(text, parser);
}

function rangesFrom(
  text: string,
  from: typeof parser,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const mathParsed = from !== proseParser;
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    if (n.type !== undefined && VERBATIM_NODE_TYPES.has(n.type)) {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start === undefined || end === undefined) return;
      // An unclosed `$$` runs to the end of what it was parsed from, so remark
      // reports the rest of the document as one formula. `splitBlocks` re-reads
      // such a block as prose; protect it and every later repair dies with it.
      // proseParser has no math extension, so this cannot recurse forever.
      if (
        mathParsed &&
        n.type === "math" &&
        !isTerminatedFence(text.slice(start, end))
      ) {
        for (const range of rangesFrom(text.slice(start, end), proseParser)) {
          found.push({ start: start + range.start, end: start + range.end });
        }
        return;
      }
      found.push({ start, end });
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(from.parse(text) as Root);
  return found;
}

/**
 * Node types `verbatimRanges` protects. `html` is here because clipped articles
 * carry raw HTML the converter could not express as markdown — a `<pre>` among
 * it holds source exactly like a fence does.
 */
const VERBATIM_NODE_TYPES: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "html",
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

export interface MathRange {
  /** Offset of the opening delimiter in the text this was read from. */
  start: number;
  /** Offset just past the closing delimiter. */
  end: number;
  /** The LaTeX between the delimiters. */
  value: string;
  /** A `$$…$$` block rather than an inline `$…$`. */
  display: boolean;
  /**
   * The closing fence exists. Always true for inline math; false for a `$$`
   * that ran to the end of what it was parsed from, which is prose wearing a
   * fence rather than a formula.
   */
  terminated: boolean;
}

/**
 * Every math node in a fragment, at any depth, with the source offsets of its
 * delimiters so callers can splice rather than pattern-match around LaTeX.
 *
 * One walker on purpose. Three places used to reason about math nodes with
 * three different partial traversals — one looked only at root children, one
 * only at `inlineMath` — and the gaps between them were bugs: a formula in a
 * list item was neither copied verbatim nor hidden from the translator, and an
 * unclosed fence inside a list item survived the repair that exists for it.
 *
 * `singleDollar` must match how the site will render the article — the
 * frontmatter `has_math` flag. Reading `$…$` as math in an article that never
 * declared its dollars curated would find "5 to " inside "costs $5 to $10" and
 * treat a price as a formula, which is the exact mistake the flag exists to
 * prevent.
 */
export function mathRanges(
  text: string,
  options: { singleDollar: boolean },
): MathRange[] {
  const tree = (options.singleDollar ? parser : dollarSafeParser).parse(
    text,
  ) as Root;
  const found: MathRange[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      value?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    const display = n.type === "math";
    if (display || n.type === "inlineMath") {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        found.push({
          start,
          end,
          value: n.value ?? "",
          display,
          terminated: !display || isTerminatedFence(text.slice(start, end)),
        });
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
/**
 * Escaping the outermost unclosed opener and parsing again is what discovers a
 * formula the fence had swallowed, so it is worth doing for real content, where
 * a cascade is one or two deep. It costs a parse per step though, and a block
 * that is nothing but openers would pay one per line — quadratic, and measured
 * at ~7.8s for 1000 lines. Past this many steps, escape every opener at once
 * instead and accept that a formula hidden that deep is not recoverable.
 */
const MAX_ESCAPE_PASSES = 8;

/** Escape a run of delimiters at `start`, whole. */
function escapeFenceAt(text: string, start: number): string {
  // The whole run, not two characters: escaping "$$$" as "\$\$$" would leave
  // a stray delimiter behind.
  const fence = /^\$+/.exec(text.slice(start))?.[0] ?? "$$";
  const escaped = fence.replace(/\$/g, () => "\\$");
  return `${text.slice(0, start)}${escaped}${text.slice(start + fence.length)}`;
}

/**
 * Source ranges of ordinary prose in a fragment, read with the math-free
 * parser.
 *
 * Deliberately an allowlist. Naming the places a delimiter must be left alone
 * — fenced code, then indented code, then inline code, then raw `<pre>` — is
 * open-ended, and each omission corrupts something visible: a shell snippet
 * gains a literal `\$\$`. Escaping only what the parser calls text closes the
 * question instead, and a node type nobody thought of is protected by default.
 *
 * It has to be the math-free parser: this runs when an unclosed fence has
 * swallowed the rest of the block, so the parser that sees the math cannot see
 * the code *inside* it.
 */
function proseRanges(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    if (n.type === "text") {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) found.push({ start, end });
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(proseParser.parse(text) as Root);
  return found;
}

/**
 * Source ranges of the paragraphs in a fragment.
 *
 * This is the answer to "could a fence open here?". A paragraph begins exactly
 * where prose begins *after* every container, however many and in whatever
 * order, so `- > $$` and `- 1. > - $$` start one at the `$$` itself while
 * `` `complexity`$$… `` starts one at the backtick. Asking the parser removes
 * the need to know Markdown's container grammar, or to guess what came earlier
 * on the line.
 */
function paragraphRanges(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    if (n.type === "paragraph") {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) found.push({ start, end });
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(proseParser.parse(text) as Root);
  return found;
}

/**
 * Whether the run at `offset` opens an inline formula rather than a fence —
 * `$$O(n)$$` on one line, which micromark reads as inline math because a
 * flow fence's opening line may not contain another delimiter.
 *
 * Asked of one line at a time, so this stays linear over the block; the
 * reparse loop answers the same question by parsing everything again, which
 * is what makes it too slow to run per opener. `keep` cannot answer it,
 * because a formula still hidden inside an unclosed fence was invisible to
 * the parse that produced it.
 */
function opensInlineMath(text: string, offset: number): boolean {
  const lineEnd = text.indexOf("\n", offset);
  const rest = text.slice(offset, lineEnd === -1 ? undefined : lineEnd);
  // Inline math has to close on the same line, so without a second delimiter
  // there is nothing to parse for. Skipping those keeps the common case — a
  // block of bare openers — at one parse rather than one per line.
  const run = /^\$+/.exec(rest)?.[0].length ?? 0;
  if (!rest.slice(run).includes("$")) return false;
  return mathRanges(rest, { singleDollar: true }).some(
    (range) => range.start === 0 && range.terminated,
  );
}

/**
 * Escape every delimiter run that opens a line of prose and is not part of a
 * formula which did close, in a single pass. Blunter than reparsing — it
 * cannot discover a valid formula that an outer unclosed fence was hiding —
 * but it is linear and it always terminates, which is what the pathological
 * case needs.
 *
 * Candidates come from the parser, not from a pattern of my own. A paragraph
 * starts where prose starts after every container, so compound prefixes need
 * no grammar here; and a `$$` that is not at a paragraph's start, nor after a
 * newline inside one, is not opening anything — which is what keeps
 * `` `complexity`$$O(n)$$ `` and `![alt](x)$$O(n)$$` intact. Asking instead
 * whether earlier *text* appeared on the line only caught inline constructs
 * that happen to contain text, so links and emphasis worked and inline code,
 * images and inline HTML did not.
 *
 * The one pattern left is a continuation line inside a single paragraph, where
 * the prefix can be nothing but indentation and blockquote markers: a list
 * marker would end the paragraph and start a new one.
 */
function escapeRemainingOpeners(
  text: string,
  keep: readonly MathRange[],
): string {
  const prose = proseRanges(text);
  const targets = new Set<number>();

  for (const paragraph of paragraphRanges(text)) {
    const slice = text.slice(paragraph.start, paragraph.end);
    for (const match of slice.matchAll(/(^|\n[ \t>]*)(\$\$+)/g)) {
      const offset =
        paragraph.start + (match.index ?? 0) + (match[1] ?? "").length;
      const covered = (r: { start: number; end: number }) =>
        offset >= r.start && offset < r.end;
      // Prose only, so code and raw HTML keep their delimiters — including
      // inline code spanning a newline, which the continuation branch reaches.
      if (!prose.some(covered)) continue;
      if (keep.some((r) => covered({ start: r.start, end: r.end }))) continue;
      if (opensInlineMath(text, offset)) continue;
      targets.add(offset);
    }
  }

  let out = text;
  // Back to front, so earlier offsets stay valid.
  for (const offset of [...targets].sort((a, b) => b - a)) {
    out = escapeFenceAt(out, offset);
  }
  return out;
}

export function normalizeBlockMath(text: string): string {
  // Most blocks have no dollar at all; skip parsing them twice over.
  if (!text.includes("$")) return text;

  let out = text;
  // An unclosed fence swallows everything after it, so one parse cannot see
  // what is inside it. Escaping just the openers it *can* see and looking
  // again is what recovers a formula the fence had hidden — in
  // "- $$ — price" followed by "$$O(n)$$", the second only becomes visible
  // once the first is neutralised. Both steps read positions from the parser;
  // the difference between them is how much they escape, not where they think
  // a fence can start.
  for (let pass = 0; ; pass += 1) {
    const ranges = mathRanges(out, { singleDollar: true });
    const unterminated = ranges.filter((range) => !range.terminated);
    if (unterminated.length === 0) break;
    if (pass >= MAX_ESCAPE_PASSES) {
      out = escapeRemainingOpeners(
        out,
        ranges.filter((range) => range.terminated),
      );
      break;
    }
    let next = out;
    // Back to front, so earlier offsets stay valid.
    for (const range of [...unterminated].reverse()) {
      next = escapeFenceAt(next, range.start);
    }
    // Each pass escapes at least one run and escaping never creates one, so
    // this converges; the no-progress check is belt and braces.
    if (next === out) break;
    out = next;
  }
  if (out !== text) return out;

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
  const mathParsed = from !== proseParser;
  return tree.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error(
        `mdast node of type "${node.type}" has no source position`,
      );
    }
    const text = source.slice(start, end);
    // Any depth, not just a top-level `math` node: an unclosed fence inside a
    // list item is the same mistake wearing a different block type.
    const unclosed =
      mathParsed &&
      mathRanges(text, { singleDollar: true }).some((r) => !r.terminated);
    if (unclosed) {
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
