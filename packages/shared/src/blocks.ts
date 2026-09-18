import type { Root } from "mdast";
import remarkCjkFriendly from "remark-cjk-friendly";
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

/**
 * `remarkCjkFriendly` is on every parser here because the site renders with it
 * (`apps/site/src/lib/render.ts`), and the contract has to read an article the
 * way its reader will see it. It is the proposed CommonMark amendment for CJK:
 * strict CommonMark refuses `**事实上，**` because `，` counts as punctuation
 * and so the closing run is not flanking, which leaves the asterisks on the
 * page. Output is unchanged for any input without CJK, and inline emphasis
 * cannot move a block boundary, so nothing about alignment changes — verified
 * over the whole vault, block for block.
 */
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly)
  .use(remarkMath);
/**
 * Without single-dollar math, matching how the site renders an article that
 * has not declared its dollar signs curated (frontmatter `has_math`).
 */
const dollarSafeParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly)
  .use(remarkMath, { singleDollarTextMath: false });
/** No math at all — used to re-read a `$$` fence that was never closed. */
const proseParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly);

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

export interface MarkdownLink {
  type: "link" | "image" | "linkReference" | "imageReference" | "definition";
  /** Source range of the whole node. */
  start: number;
  end: number;
  /**
   * Source range of everything after the label: the `(…)` of an inline link,
   * the `[…]` of a reference, or the empty span at the end of a shortcut
   * reference. Replacing exactly this range retargets a link without touching
   * a byte of the text it sits on — which is the point, because that text can
   * be another node.
   *
   * Null when there is no label to be after: an autolink, a bare URL GFM
   * linkified, or a definition.
   */
  tail: { start: number; end: number } | null;
  /** The destination, for the forms that carry one. Empty on a reference,
   * whose destination lives on its definition. */
  url: string;
  title: string | null;
  /** Normalized identifier, for the reference forms and definitions. */
  identifier: string | null;
}

const LINK_NODE_TYPES: ReadonlySet<string> = new Set([
  "link",
  "image",
  "linkReference",
  "imageReference",
  "definition",
]);

/**
 * Every link, image, reference and definition in `text`, with the source
 * ranges a rewrite needs.
 *
 * The companion to `verbatimRanges` above: that one says what a rewrite must
 * not touch, and this one says what it may. Both ask the parser, for the same
 * reason. Recognising a link by line shape means re-implementing the label
 * grammar, and every omission either rewrites something that was never a link
 * or silently declines to rewrite one that was — a destination may hold
 * balanced parentheses, a label may hold brackets, a code span inside a label
 * may hold an unbalanced one, and `<https://…>` is a link with no label at all.
 *
 * Read with the same parser the site uses for an article that has not declared
 * `has_math`, so a `$$…$$` the reader will see as a formula is a formula here
 * too, and a link inside one is left where it is.
 *
 * Nodes nest — `[![alt](img.png)](page.md)` is an image inside a link — so the
 * walk does not stop at a match. Their tails never overlap, because a tail
 * begins after the label that contains every child.
 */
export function markdownLinks(text: string): MarkdownLink[] {
  const found: MarkdownLink[] = [];
  const walk = (node: unknown): void => {
    const n = node as LinkNode;
    const start = n.position?.start.offset;
    const end = n.position?.end.offset;
    if (
      n.type !== undefined &&
      LINK_NODE_TYPES.has(n.type) &&
      start !== undefined &&
      end !== undefined
    ) {
      found.push({
        type: n.type as MarkdownLink["type"],
        start,
        end,
        // A definition's label is its identifier, not content it sits on, and
        // nothing rewrites one in place — it is dropped whole or left alone.
        tail: n.type === "definition" ? null : labelTail(text, n, start, end),
        url: n.url ?? "",
        title: n.title ?? null,
        identifier: n.identifier ?? null,
      });
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(dollarSafeParser.parse(text) as Root);
  return found;
}

interface LinkNode {
  type?: string;
  url?: string;
  title?: string | null;
  identifier?: string;
  alt?: string;
  children?: unknown[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Where the label ends, asked of the parser rather than scanned for.
 *
 * Scanning was the original approach and it was wrong in a way that could not
 * be patched: the label grammar admits an unescaped `]` inside a code span, an
 * autolink, an HTML comment and any inline HTML attribute, and enumerating
 * those is re-implementing the spec. `[<span data-x="]">x</span>](a.md)` closed
 * the label inside the attribute and every rewrite after it landed mid-tag.
 * Nor can the list be closed by hand — `[a < b > ] c](d.md)` shows that even
 * "skip from `<` to `>`" is wrong, because a bare `<` in a label is text.
 *
 * Every shape the parser answers directly, it answers exactly; the rest return
 * null, which callers already read as "leave this node alone". That asymmetry
 * is the point. A rewrite silently not made loses a link's resolution; a
 * rewrite silently made wrong corrupts the document it was in.
 */
function labelTail(
  text: string,
  node: LinkNode,
  start: number,
  end: number,
): { start: number; end: number } | null {
  // `![` opens the image forms and `[` the rest. Anything else is an autolink
  // or a bare URL GFM linkified: a link with no label, and so no tail.
  const open = text[start] === "!" ? start + 1 : start;
  if (text[open] !== "[") return null;
  const close = labelClose(text, node, open, end);
  return close === null || text[close] !== "]"
    ? null
    : { start: close + 1, end };
}

function labelClose(
  text: string,
  node: LinkNode,
  open: number,
  end: number,
): number | null {
  // `link` and `linkReference` keep their label as children, and the last one
  // ends exactly where the `]` is — through code spans, comments and tags
  // alike, because the parser resolved them on the way in.
  const inner = lastChildEnd(node);
  if (inner !== undefined) return inner;
  // An empty label has no child to ask about, and the `]` is the next byte.
  if (text[open + 1] === "]") return open + 1;
  // The image forms keep no children — `alt` is flattened text, and its length
  // is the rendered one rather than the source's. Re-reading the node as the
  // link it is shaped like restores the children, at the same offsets.
  return reparsedLabelClose(text, node, open, end);
}

function lastChildEnd(node: LinkNode): number | undefined {
  const children = node.children ?? [];
  const last = children[children.length - 1] as LinkNode | undefined;
  return last?.position?.end.offset;
}

/**
 * Read an image as the link it is shaped like, to borrow the children it does
 * not keep.
 *
 * The slice is the node without its `!`, so the label is byte-identical and at
 * a known offset. A reference form needs its definition to resolve at all, so
 * one is synthesized from the identifier — **verbatim**, because mdast
 * normalizes case and whitespace but keeps escapes, so `a\]b` written back as
 * `[a\]b]` normalizes to itself while re-escaping it would not.
 *
 * Only a node spanning the whole slice is accepted. Without that check the
 * walk took the first link-shaped node it found, which for a label that
 * *contains* a link is the inner one — and `![[x](y.png)][id]` had its
 * destination rewritten at the inner link's bracket, leaving malformed
 * markdown. A node shorter than the slice is a child, never the re-read node.
 */
function reparsedLabelClose(
  text: string,
  node: LinkNode,
  open: number,
  end: number,
): number | null {
  const slice = text.slice(open, end);
  const identifier = node.identifier;
  const source =
    identifier === undefined ? slice : `${slice}\n\n[${identifier}]: /x`;
  let close: number | null | undefined;
  const walk = (candidate: unknown): void => {
    const n = candidate as LinkNode;
    if (
      close === undefined &&
      n.type !== undefined &&
      LINK_TYPES.has(n.type) &&
      n.position?.start.offset === 0 &&
      n.position?.end.offset === slice.length
    ) {
      // Found the re-read node itself. Whatever it says is the answer — an
      // empty label reports nothing rather than sending the walk deeper into
      // children that are not this node's.
      close = lastChildEnd(n) ?? null;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(dollarSafeParser.parse(source) as Root);
  return close === undefined || close === null ? null : open + close;
}

/** The forms that keep their label as children — what an image is re-read as. */
const LINK_TYPES: ReadonlySet<string> = new Set(["link", "linkReference"]);

/**
 * Source ranges of the raw HTML in `text`.
 *
 * Clipped and hand-written markdown both carry HTML the converter could not
 * express, and a README's first line is routinely
 * `<p align="center"><img src="logo.png"></p>`. Those references are as
 * relative as a markdown one and break the same way, but they are attributes
 * rather than nodes, so `markdownLinks` cannot see them and the caller needs
 * the span to work inside.
 *
 * Reported whole, without excluding `<pre>`: that element preserves whitespace
 * but does not escape markup, so a literal `<img src=…>` inside one is an
 * image rather than source. HTML shown *as* source is entity-escaped and holds
 * no attribute to match, and a fenced block is a `code` node this never sees.
 */
export function htmlRanges(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const walk = (node: unknown): void => {
    const n = node as LinkNode;
    if (n.type === "html") {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) found.push({ start, end });
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(dollarSafeParser.parse(text) as Root);
  return found;
}

/**
 * True when `text` is a single paragraph holding nothing but images.
 *
 * Answering this with a regex means re-implementing link syntax, and the
 * approximation is always narrower than the real thing: Turndown escapes
 * parentheses in a destination and brackets in alt text, and a pattern built
 * from `[^()]` or `[^\]]` rejects both — quietly, by declining to repair a
 * defect rather than by failing. The parser already knows where an image ends.
 *
 * One paragraph, not one line, because that is the property callers actually
 * need: a block that parses to exactly one paragraph can replace exactly one
 * block, which is what keeps `index.md` and `zh.md` aligned.
 */
export function isImageOnlyParagraph(text: string): boolean {
  const children = (parser.parse(text) as Root).children;
  const [node] = children;
  if (children.length !== 1 || node?.type !== "paragraph") return false;
  // Whatever separates two images is part of the paragraph, not content: on
  // consecutive lines they parse as image, text("\n"), image, and if the first
  // line ends in two spaces the separator is a `break` node instead. Demanding
  // every child be an image rejects both, though either is a paragraph of
  // nothing but pictures by any reading.
  const onlyImagesAndSpace = node.children.every(
    (child) =>
      child.type === "image" ||
      child.type === "break" ||
      (child.type === "text" && child.value.trim() === ""),
  );
  return (
    onlyImagesAndSpace && node.children.some((child) => child.type === "image")
  );
}

/**
 * The two mdast node types that are an image.
 *
 * `![a](x.png)` is an `image`; `![a][ref]`, `![a][]` and `![ref]` are an
 * `imageReference`, resolved against a definition elsewhere in the document.
 * Turndown writes the inline form and no vault article uses the other, so this
 * distinction is invisible today — which is exactly the kind of latent wrongness
 * that this file's other comments were written after discovering the hard way.
 */
const IMAGE_NODE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "imageReference",
]);

/**
 * Start offset of every image in `text`, in document order.
 *
 * The counting counterpart to `isImageOnlyParagraph` below, and it exists for
 * the reason that function's comment already gives: Turndown escapes brackets
 * in alt text, so the clipper writes `![a\]b](x.png)` for `alt="a]b"`, and a
 * pattern built from `[^\]]` sees no image there at all. The same pattern
 * counts `\![x](x.png)` — an escaped bang, which is literal text — as one.
 * Both were measured against the real clipper, not imagined.
 *
 * Asking the parser also settles what counts as code for free: an image inside
 * a fence, an indented block or an inline span never becomes an image node, so
 * a caller has nothing left to exclude by hand.
 *
 * Offsets rather than a count, so a caller can attribute each image to the part
 * of the document it sits in.
 */
export function imageOffsets(text: string): number[] {
  const found: number[] = [];
  walkNodes(parser.parse(text) as Root, (node) => {
    if (node.type !== undefined && IMAGE_NODE_TYPES.has(node.type)) {
      const start = node.position?.start.offset;
      if (start !== undefined) found.push(start);
    }
  });
  return found.sort((a, b) => a - b);
}

/**
 * How many paragraphs are shaped like a folded figure: an image immediately
 * followed by a hard break, which is how a caption is co-located with its
 * picture (ADR 0011).
 *
 * Read from the tree rather than from the text, because the textual form of a
 * hard break is not one thing. Turndown writes two trailing spaces, markdown
 * also accepts a trailing backslash, and a CRLF document leaves a `\r` between
 * the spaces and the newline — so a `line.endsWith("  ")` test silently
 * undercounts a vault written on Windows, which `parseArticle` explicitly
 * supports. The parser calls all three a `break`.
 *
 * Per paragraph, not per image: a folded figure is one block however many
 * pictures the page put in it, which is the property that keeps `index.md` and
 * `zh.md` aligned.
 */
export function foldedFigureCount(text: string): number {
  let count = 0;
  walkNodes(parser.parse(text) as Root, (node) => {
    if (node.type !== "paragraph") return;
    // "An image somewhere before a break", not "an image immediately before
    // one": the picture may be a link wrapping the image, which is what
    // `pictureOf` produces for a figure whose image links to a larger copy, and
    // then the paragraph's own children are link, break, text. Checking direct
    // children only lost every such figure — seven in one vault article.
    let seenImage = false;
    for (const child of (node.children ?? []) as WalkNode[]) {
      if (child.type === "break") {
        if (seenImage) {
          count++;
          return;
        }
        continue;
      }
      walkNodes(child, (inner) => {
        if (inner.type !== undefined && IMAGE_NODE_TYPES.has(inner.type)) {
          seenImage = true;
        }
      });
    }
  });
  return count;
}

interface WalkNode {
  type?: string;
  children?: unknown[];
  position?: { start: { offset?: number } };
}

/** Depth-first over every node — images nest inside links, emphasis, cells. */
function walkNodes(root: unknown, visit: (node: WalkNode) => void): void {
  const node = root as WalkNode;
  visit(node);
  for (const child of node.children ?? []) walkNodes(child, visit);
}

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
  return rangesOf(proseParser.parse(text) as Root, "text");
}

/**
 * Source ranges of every node of `type`, at any nesting depth, outermost
 * first — the walk stops at a match rather than descending into it.
 */
function rangesOf(root: Root, type: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    if (n.type === type) {
      const start = n.position?.start.offset;
      const end = n.position?.end.offset;
      if (start !== undefined && end !== undefined) found.push({ start, end });
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

/**
 * Source ranges of the text a reader sees as prose, read with the full parser.
 *
 * `proseRanges` above answers the same question for the one caller that must
 * not see math; this is the answer for everyone else. The distinction matters
 * for a rewrite that edits punctuation in place — a delimiter swap, say — which
 * has to stay out of formulas as much as out of code, and out of everything a
 * text node never covers: a link destination, an image URL, an HTML attribute.
 * Naming the safe places rather than the unsafe ones means a node type nobody
 * thought of is protected by default.
 */
export function textRanges(text: string): { start: number; end: number }[] {
  return rangesOf(parser.parse(text) as Root, "text");
}

/**
 * Source ranges of the tables in a fragment.
 *
 * A table is the one block whose syntax separates text on the same line: the
 * `|` between two cells is a wall no span reaches across. Everywhere else a
 * `|` is an ordinary character — in a code span, in a link destination, in
 * prose — which is why the question is asked about tables rather than about
 * the character.
 */
export function tableRanges(text: string): { start: number; end: number }[] {
  return rangesOf(parser.parse(text) as Root, "table");
}

/** Inline containers whose children are a text flow of their own. */
const SEPARATE_FLOW: ReadonlySet<string> = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "footnoteReference",
]);

/**
 * Source offsets at which the parser opened an emphasis or strong span, in the
 * flow those offsets belong to.
 *
 * The answer to "has this text already been read as emphasis here?", which a
 * rewrite has to ask before treating two delimiters as a pair: if the parser
 * built a span between them, its own reading disagrees, and rewriting anyway
 * would re-bracket the sentence rather than repair it.
 *
 * A link's label is a flow of its own, so a span inside one does not count. It
 * cannot interleave with delimiters outside the link — `_[a _b_ c](url)_` is an
 * emphasised link that contains an emphasised word, not an argument about where
 * the outer span ends — and counting it refused a repair the parser would have
 * been perfectly happy with.
 */
export function emphasisStarts(text: string): number[] {
  const found: number[] = [];
  const walk = (node: unknown): void => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number } };
    };
    if (SEPARATE_FLOW.has(n.type ?? "")) return;
    const start = n.position?.start.offset;
    if ((n.type === "emphasis" || n.type === "strong") && start !== undefined) {
      found.push(start);
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(parser.parse(text) as Root);
  return found;
}

/**
 * Whether an emphasis span opens exactly at `offset`.
 *
 * The question a caller asks about a delimiter it is considering rewriting:
 * would the parser read *this* one as emphasis? Anchored to the offset rather
 * than "is there emphasis anywhere", because the text around it may hold
 * emphasis of its own and answering about that would be answering a different
 * question. `strong` counts: `__x__` is the same span with a longer run.
 */
export function opensEmphasisAt(text: string, offset: number): boolean {
  // Its own walk rather than `rangesOf`, which stops at the outermost match:
  // emphasis nests, and a span wrapped in another one is still emphasis.
  const walk = (node: unknown): boolean => {
    const n = node as {
      type?: string;
      children?: unknown[];
      position?: { start: { offset?: number } };
    };
    if (
      (n.type === "emphasis" || n.type === "strong") &&
      n.position?.start.offset === offset
    ) {
      return true;
    }
    return (n.children ?? []).some(walk);
  };
  return walk(parser.parse(text) as Root);
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
  return rangesOf(proseParser.parse(text) as Root, "paragraph");
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

/**
 * The tag name an inline HTML node opens with, lowercased, or null when it does
 * not open with one.
 *
 * Asking for the name rather than pattern-matching the whole tag is what keeps
 * the attributes out of it, and two rounds of review went on attributes:
 * `[^>]*` cannot cross the `>` inside `<br title="a > b">`, and a `\b` after
 * the name counts `<br-other>` as a `<br>`. Stopping at the first delimiter has
 * neither problem, because the name is all that is being asked about.
 *
 * The leading slash is optional because the HTML parser treats `</br>` as a
 * `<br>` — a spec quirk, not a typo tolerance — and the site renders clipped
 * markup through one (rehype-raw). Verified: `first</br>second` comes out of
 * `apps/site/src/lib/render.ts` as `<p>first<br>second</p>`. A closing tag that
 * is not `br` still yields its own name, so `</span>` is not a break.
 */
const HTML_TAG_NAME = /^<\/?([a-zA-Z][^\s/>]*)/;

/**
 * The node types whose edges fall *inside* a word, so putting whitespace at
 * them would split one: `un*bel*ievable` is one word with emphasis in it.
 *
 * An allowlist, so anything unrecognised is treated as a block and separated.
 * Being wrong that way costs a space that collapses; being wrong the other way
 * cuts a word in half.
 */
const INLINE_TYPES = new Set([
  "text",
  "inlineCode",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "break",
  "html",
  "image",
  "imageReference",
  "footnoteReference",
]);

function tagName(value: string): string | null {
  return HTML_TAG_NAME.exec(value.trim())?.[1]?.toLowerCase() ?? null;
}

/**
 * The prose a markdown fragment actually shows — its text with the syntax
 * removed, for the places that need words rather than source.
 *
 * A block's `text` is its exact source, which is right for alignment and wrong
 * for anything rendered as plain text: a paragraph carrying `**bold**` or
 * `[a link](url)` would show its punctuation.
 *
 * **Image alt text does not count.** The caller asking this question is looking
 * for a paragraph a reader would recognise as prose, and a paragraph holding
 * only a picture is not one however well it is described — an article opening
 * with a hero image would otherwise be summarized by its alt attribute. Link
 * text does count: a sentence is still a sentence when parts of it are links.
 */
export function plainText(markdown: string): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    const n = node as { type?: string; value?: string; children?: unknown[] };
    if (n.type === "image" || n.type === "imageReference") return;
    // A rendered line break is whitespace. Without this the words either side
    // of it are run together — "first<br>second" became "firstsecond".
    if (
      n.type === "break" ||
      (n.type === "html" && tagName(n.value ?? "") === "br")
    ) {
      out.push(" ");
      return;
    }
    if (
      typeof n.value === "string" &&
      (n.type === "text" || n.type === "inlineCode")
    ) {
      out.push(n.value);
    }
    // Every block edge is a gap, wherever it sits: two paragraphs are two
    // sentences, and so are two list items or two table cells. Separating only
    // the root's children missed all of those — a paragraph inside a
    // blockquote ran straight into the next one.
    const isBlock = n.type !== undefined && !INLINE_TYPES.has(n.type);
    if (isBlock) out.push(" ");
    if (Array.isArray(n.children)) for (const child of n.children) walk(child);
    if (isBlock) out.push(" ");
  };
  walk(proseParser.parse(markdown) as Root);
  return out.join("").replace(/\s+/g, " ").trim();
}
