import {
  checkAlignment,
  splitBlocks,
  translationPath,
  verbatimRanges,
} from "@tiro/shared";

/**
 * Repair markdown that the clipper wrote before its Turndown defects were
 * fixed. Every transform here mirrors one fix in `apps/extension`, because a
 * code fix only ever helps the *next* clip — the vault keeps whatever the
 * clipper produced at the time, and re-clipping 30 pages by hand is not a
 * migration.
 *
 * All of them are shape repairs, never content edits: each one removes markup
 * the converter emitted twice or left unterminated. Nothing here can invent
 * text, which is what makes applying the same transform to `index.md` and
 * `zh.md` safe — the defects are mirrored in both, since the translator
 * preserves structure.
 */

/**
 * Run `transform` over everything the parser does not call code, math or raw
 * HTML.
 *
 * Every pattern below is a line shape, and line shapes occur inside code blocks
 * for entirely legitimate reasons — a shell transcript contains `|  |`, a diff
 * contains `[`, a markdown tutorial contains all of them. Splitting the text
 * first means no transform has to carry its own "unless this is code" condition.
 *
 * This asks `verbatimRanges` rather than scanning for fences, because scanning
 * cannot be made right: it read the first three backticks of a longer fence and
 * mistook the inner ``` for its closer, and it opened on a one-line `$$E=mc^2$$`
 * that closes on the same line and so never closed at all — silently skipping
 * every repair after it. The parser knows fence lengths, indented code and
 * inline spans without being told.
 *
 * Still a denylist of node *types*, unlike `proseRanges`' allowlist, and
 * deliberately: these repairs join text across nodes — `[`, an image and
 * `](url)` are three separate blocks, which is the defect — so "only touch text
 * nodes" cannot express them. What changed is that the list is the parser's
 * answer instead of a guess about line shapes.
 */
function outsideVerbatim(body: string, transform: (prose: string) => string) {
  const out: string[] = [];
  let cursor = 0;
  for (const range of verbatimRanges(body)) {
    if (!ownsItsLines(body, range)) continue;
    if (range.start > cursor) {
      out.push(transform(body.slice(cursor, range.start)));
    }
    out.push(body.slice(range.start, range.end));
    cursor = range.end;
  }
  if (cursor < body.length) out.push(transform(body.slice(cursor)));
  return out.join("");
}

/**
 * Whether a range has its lines to itself, ignoring indentation and quoting.
 *
 * Every transform reads whole lines, so cutting the text at something that
 * begins mid-line hands them a fragment. The `<br>` between two cells of a
 * clipped table is such a range — remark reads each one as an html node — and
 * splitting there left `promoteTableHeaders` looking at half a row, which it
 * duly mangled. Inline code and inline math have the same shape.
 *
 * Leaving those in place costs nothing: a line with prose on it is not a bare
 * `|  |  |` or a bare `N.  (n)`, so no line transform matches it either way.
 */
function ownsItsLines(
  body: string,
  range: { start: number; end: number },
): boolean {
  const lineStart = body.lastIndexOf("\n", range.start - 1) + 1;
  const before = body.slice(lineStart, range.start);
  const lineEnd = body.indexOf("\n", range.end);
  const after = body.slice(range.end, lineEnd === -1 ? body.length : lineEnd);
  return /^[\s>]*$/.test(before) && after.trim() === "";
}

/**
 * Flatten a link title that spans lines.
 *
 * arXiv writes a section path into `title=`, and when the path contains a
 * formula the attribute carries the MathML's rendered newlines. The emitted
 * title never closes on its line, so the link never terminates and the
 * swallowed lines arrive as prose — one of them a lone `=`, which markdown
 * reads as a setext heading, turning the paragraph above into an `<h1>`.
 *
 * The destination alternation accepts `\(` and `\)` because Turndown escapes
 * parentheses rather than dropping them, and a bare-paren class rejected the
 * whole link — leaving the multi-line title, and so the setext heading, in place
 * on every Wikipedia-style `Foo_(disambiguation)` URL.
 *
 * Mirrors `normalizeLinkTitles` in the clipper.
 */
export function joinLinkTitles(body: string): string {
  return body.replace(
    /\]\((<[^<>\n]*>|(?:\\[()]|[^\s()])+)\s+"([^"]*)"\)/g,
    (match, destination: string, title: string) => {
      const flat = title.replace(/\s+/g, " ").trim();
      if (flat === title) return match;
      return flat === "" ? `](${destination})` : `](${destination} "${flat}")`;
    },
  );
}

/**
 * Rejoin a link whose text was pushed onto its own lines.
 *
 * Turndown puts a block child's surrounding blank lines *inside* a link's
 * brackets, so `<a><div><img></a>` — every captioned Substack image — comes out
 * as `[`, the image, and `](url)` on three lines. Markdown reads none of it as
 * a link.
 *
 * Mirrors the `inlineLinkRule` in the clipper.
 */
export function rejoinSplitLinks(body: string): string {
  return body.replace(
    /\[\n\s*\n([\s\S]*?)\n\s*\n\]\(/g,
    (_match, content: string) => `[${content.replace(/\s+/g, " ").trim()}](`,
  );
}

/**
 * Rejoin a footnote label that Readability split.
 *
 * Pages that separate paragraphs with `<br><br>` rather than `<p>` — Paul
 * Graham's essays are the archetype — make Readability rebuild the blocks
 * itself, and it does so through the middle of an inline run: `[<a
 * name="f1n">1</a>] Should students…` comes back as `<p>[</p>` followed by the
 * rest at block level. Turndown then emits `\[` as its own paragraph, so every
 * footnote publishes as a stray bracket above its own text.
 *
 * The cause is inside Readability, before the clipper's markdown ever exists,
 * so unlike the transforms above this one has no counterpart in `apps/extension`
 * — a re-clip of such a page reproduces it.
 */
export function rejoinSplitFootnotes(body: string): string {
  return body.replace(/\\\[\n\s*\n(?=\d+\\\])/g, "\\[");
}

const EMPTY_ROW = /^\|(?:\s*\|)+\s*$/;
const DIVIDER = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;

/**
 * Drop a synthesized empty header row and promote the row below it.
 *
 * GFM cannot express a headerless table, so the Turndown plugin invented a
 * blank header whenever the source had no `<thead>` — a visible empty row, with
 * the real headings below it still rendered as data.
 *
 * Mirrors `promoteTableHeaders` in the clipper.
 */
export function promoteTableHeaders(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const row = lines[i];
    const divider = lines[i + 1];
    const next = lines[i + 2];
    if (
      row !== undefined &&
      divider !== undefined &&
      next !== undefined &&
      EMPTY_ROW.test(row) &&
      DIVIDER.test(divider) &&
      next.startsWith("|") &&
      !DIVIDER.test(next)
    ) {
      // Promote by swapping the empty row out and the divider down one line:
      // the row that was first data becomes the header.
      out.push(next, divider);
      i += 2;
      continue;
    }
    if (row !== undefined) out.push(row);
  }
  return out.join("\n");
}

/** `1.  (1)` / `2.  (b)` — a marker the list already supplies. */
const DUPLICATE_MARKER =
  /^([ \t]*(?:\d+\.|[-*+])[ \t]+)\((?:\d+|[a-z]|[ivx]+)\)[ \t]*$/i;

/**
 * Pull a list item's text up onto its marker line.
 *
 * LaTeXML numbers `<ol>` items itself and writes the label into the item, so
 * the `<ol>`'s marker and the label both survive: `1.  (1)`, with the item's
 * real text in an indented paragraph below. Removing the label alone would
 * leave an empty marker line, so the first following paragraph is lifted onto
 * it.
 *
 * Mirrors `stripRedundantListMarkers` in the clipper.
 */
export function liftDuplicateListMarkers(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = line === undefined ? null : DUPLICATE_MARKER.exec(line);
    if (marker === null || line === undefined) {
      if (line !== undefined) out.push(line);
      continue;
    }
    // Find the item's first real line, skipping the blank that always follows.
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
    const first = lines[j];
    // Only lift a line indented *into* this item; anything else means the
    // label was the whole item and there is nothing to pull up.
    if (first === undefined || !/^[ \t]/.test(first)) {
      out.push(line);
      continue;
    }
    out.push(`${marker[1]}${first.trim()}`);
    i = j;
  }
  return out.join("\n");
}

const TRANSFORMS = [
  joinLinkTitles,
  rejoinSplitLinks,
  rejoinSplitFootnotes,
  promoteTableHeaders,
  liftDuplicateListMarkers,
];

/** Apply every repair to one markdown body. */
export function repairBody(body: string): string {
  return outsideVerbatim(body, (prose) =>
    TRANSFORMS.reduce((text, transform) => transform(text), prose),
  );
}

export interface RepairedArticle {
  slug: string;
  /** Which files actually changed — `index.md`, `zh.md`, or both. */
  files: string[];
}

export interface RepairReport {
  repaired: RepairedArticle[];
  /** Articles whose repair was refused because it broke 1:1 alignment. */
  refused: { slug: string; errors: string[] }[];
  scanned: number;
}

export interface RepairOptions {
  slug?: string;
  dryRun?: boolean;
}

/**
 * Repair every article in the vault, index and translation together.
 *
 * The pair is rewritten or neither is. `zh.md` must stay strictly 1:1
 * block-aligned with the body (invariant 4), and these transforms change block
 * structure by design — an unterminated title stops being a setext heading, a
 * split link stops being three blocks. Applying a repair to only one side, or
 * to two sides that were not damaged identically, would silently drop the
 * article's whole translation to stacked rendering. So the result is checked
 * before anything is written, and a pair that no longer aligns is left exactly
 * as it was and reported.
 */
export async function repairVault(
  vaultDir: string,
  options: RepairOptions = {},
): Promise<RepairReport> {
  const articlesDir = `${vaultDir}/articles`;
  const repaired: RepairedArticle[] = [];
  const refused: { slug: string; errors: string[] }[] = [];
  let scanned = 0;

  const relPaths = Array.from(
    new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();

  for (const relPath of relPaths) {
    const [slug] = relPath.split("/");
    if (slug === undefined) continue;
    if (options.slug !== undefined && options.slug !== slug) continue;
    scanned += 1;

    const indexAbs = `${articlesDir}/${relPath}`;
    const indexText = await Bun.file(indexAbs).text();
    const zhAbs = `${vaultDir}/${translationPath(slug)}`;
    const zhFile = Bun.file(zhAbs);
    const hasZh = await zhFile.exists();
    const zhText = hasZh ? await zhFile.text() : null;

    const newIndex = repairFile(indexText);
    const newZh = zhText === null ? null : repairFile(zhText);

    const files: string[] = [];
    if (newIndex !== indexText) files.push("index.md");
    if (newZh !== null && newZh !== zhText) files.push("zh.md");
    if (files.length === 0) continue;

    if (newZh !== null) {
      const alignment = checkAlignment(
        splitBlocks(bodyOf(newIndex)),
        splitBlocks(newZh),
      );
      if (!alignment.ok) {
        refused.push({ slug, errors: alignment.errors });
        continue;
      }
    }

    if (options.dryRun !== true) {
      if (newIndex !== indexText) await Bun.write(indexAbs, newIndex);
      if (newZh !== null && newZh !== zhText) await Bun.write(zhAbs, newZh);
    }
    repaired.push({ slug, files });
  }

  return { repaired, refused, scanned };
}

/** Frontmatter is YAML, not markdown — repair the body and leave it alone. */
function repairFile(text: string): string {
  const end = frontmatterEnd(text);
  if (end === null) return repairBody(text);
  return text.slice(0, end) + repairBody(text.slice(end));
}

function bodyOf(text: string): string {
  const end = frontmatterEnd(text);
  return end === null ? text : text.slice(end);
}

/** Offset just past the closing `---` of a frontmatter block, if there is one. */
function frontmatterEnd(text: string): number | null {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---\n", 3);
  return close === -1 ? null : close + "\n---\n".length;
}
