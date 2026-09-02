import { rename, rm } from "node:fs/promises";
import {
  checkAlignment,
  frontmatterLength,
  isImageOnlyParagraph,
  parseArticle,
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
  const ranges = verbatimRanges(body);
  // Once for the body, not once per gap: the scan is over the whole source
  // either way, and every gap must agree on which prefix is safe.
  const prefix = tokenPrefix(body);
  const inline: { start: number; end: number }[] = [];
  const out: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const whole = wholeLinesAround(body, range);
    if (whole === null) {
      // Not skipped — masked below. A range sharing its line with prose cannot
      // split the text without handing a line transform a fragment, but the
      // three that match across lines reach inside it all the same.
      inline.push(range);
      continue;
    }
    if (whole.start < cursor) continue;
    if (whole.start > cursor) {
      out.push(masked(body, cursor, whole.start, inline, transform, prefix));
    }
    out.push(body.slice(whole.start, whole.end));
    cursor = whole.end;
  }
  if (cursor < body.length) {
    out.push(masked(body, cursor, body.length, inline, transform, prefix));
  }
  return out.join("");
}

const TOKEN_DIGITS = 4;
const MAX_MASKED = 10 ** TOKEN_DIGITS;
const TOKEN_BASE = "TIROVERBATIM";

/**
 * A token prefix that appears nowhere in the source.
 *
 * A fixed prefix is a substitution waiting to happen: an article containing the
 * literal token — this repository's own documentation would — had that text
 * replaced with the contents of a code span when the mask was undone. Lengthening
 * until the source disagrees costs one scan and removes the possibility, rather
 * than making it unlikely. It terminates because a finite source cannot contain
 * an arbitrarily long run.
 */
function tokenPrefix(source: string): string {
  let prefix = TOKEN_BASE;
  while (source.includes(prefix)) prefix += "X";
  return prefix;
}

/** Alphanumeric on purpose: no transform's pattern can match inside it. */
const verbatimToken = (prefix: string, i: number) =>
  `${prefix}${String(i).padStart(TOKEN_DIGITS, "0")}`;

/**
 * Transform one gap with its inline verbatim ranges hidden behind tokens.
 *
 * Splitting the gap at them is not an option: that is what handed
 * `promoteTableHeaders` half a table row. Hiding them lets the line transforms
 * still see whole lines while `joinLinkTitles`, `rejoinSplitLinks` and
 * `rejoinSplitFootnotes` — which match across lines, and so reach into an
 * inline code span, inline formula or inline HTML — find nothing to match.
 *
 * Follows `maskMath` and `unmaskMath` in `llm/translate.ts`, whose two guards
 * this needs for the same reasons: the replacement is a callback because `$$`,
 * `$&`, `` $` `` and `$'` are all replacement syntax and all occur in the code
 * spans being restored, and each token must still be there exactly once or the
 * transforms moved something and the output cannot be trusted.
 *
 * The bound is theirs too: past the token width the padding stops guaranteeing
 * distinct tokens, and leaving the gap unmasked falls back to the protection
 * that existed before rather than to a wrong substitution.
 */
function masked(
  body: string,
  from: number,
  to: number,
  inline: readonly { start: number; end: number }[],
  transform: (prose: string) => string,
  prefix: string,
): string {
  const within = inline.filter((r) => r.start >= from && r.end <= to);
  if (within.length === 0 || within.length > MAX_MASKED) {
    return transform(body.slice(from, to));
  }
  let text = "";
  let cursor = from;
  const hidden: string[] = [];
  for (const range of within) {
    text +=
      body.slice(cursor, range.start) + verbatimToken(prefix, hidden.length);
    hidden.push(body.slice(range.start, range.end));
    cursor = range.end;
  }
  let out = transform(text + body.slice(cursor, to));
  for (let i = 0; i < hidden.length; i += 1) {
    const token = verbatimToken(prefix, i);
    const first = out.indexOf(token);
    if (first === -1 || out.indexOf(token, first + token.length) !== -1) {
      // Dropped or duplicated: no transform should do either, but if one has,
      // the masked output cannot be restored faithfully. Hand back the gap
      // untouched — an unrepaired article beats a silently altered one.
      return body.slice(from, to);
    }
    out = out.replace(token, () => hidden[i] ?? "");
  }
  return out;
}

/**
 * The whole lines a range sits on, or null if it shares them with prose.
 *
 * Every transform reads whole lines, so cutting the text at something that
 * begins mid-line hands them a fragment. The `<br>` between two cells of a
 * clipped table is such a range — remark reads each one as an html node — and
 * splitting there left `promoteTableHeaders` looking at half a row, which it
 * duly mangled. Inline code and inline math have the same shape.
 *
 * Only markup that opens a block may precede one: indentation, blockquote
 * markers, and list markers. That last is not optional — Turndown writes code
 * inside an `<li>` as `-   ``` `, opener on the marker line, so a rule that
 * demanded whitespace left every fenced block in every list unprotected, and
 * the line transforms rewrote the code inside them.
 *
 * Returning the *expanded* span rather than the range itself is what keeps the
 * marker out of the transforms' reach, and makes the invariant total: every gap
 * handed to a transform is a whole number of lines.
 *
 * Leaving a mid-line range in place costs nothing: a line with prose on it is
 * not a bare `|  |  |` or a bare `N.  (n)`, so no line transform matches it.
 */
function wholeLinesAround(
  body: string,
  range: { start: number; end: number },
): { start: number; end: number } | null {
  const lineStart = body.lastIndexOf("\n", range.start - 1) + 1;
  const before = body.slice(lineStart, range.start);
  const lineEnd = body.indexOf("\n", range.end);
  const end = lineEnd === -1 ? body.length : lineEnd;
  const after = body.slice(range.end, end);
  if (!BLOCK_OPENING_PREFIX.test(before) || after.trim() !== "") return null;
  return { start: lineStart, end };
}

/** Indentation, quoting and list markers — the markup that can open a block. */
const BLOCK_OPENING_PREFIX = /^[\s>]*(?:(?:[-*+]|\d+[.)])[\s>]*)*$/;

/**
 * A link destination as Turndown writes one: angle-bracketed, or a run in which
 * parentheses appear escaped.
 *
 * `[^()]*` looks equivalent and is not. Turndown escapes rather than drops a
 * parenthesis in a URL, so a bare-paren class rejects every Wikipedia-style
 * `Foo_(disambiguation)` link — the same gap `joinLinkTitles` was fixed for,
 * reappearing here because the pattern was written fresh instead of shared.
 */
const DESTINATION_BODY = String.raw`<[^<>\n]*>|(?:\\[()]|[^\s()])+`;
const DESTINATION = String.raw`(?:${DESTINATION_BODY})`;

/**
 * The `"title"` Turndown appends after a destination, and its escaping.
 *
 * `[^"]*` stops at the first quote, and a title may contain one: the clipper
 * writes `title.replace(/"/g, '\\"')`, so `Permalink to "Title"` arrives as
 * `Permalink to \"Title\"`. Matching an escaped pair explicitly is the only
 * way to reach the real closing quote.
 *
 * The escape consumes `[\s\S]`, not `.`, because `.` excludes newlines and a
 * title is exactly where newlines live — flattening multi-line titles is what
 * `joinLinkTitles` exists for. Spelling it `.` silently switched that transform
 * off for any title holding a backslash before a line break.
 */
const TITLE_BODY = String.raw`(?:\\[\s\S]|[^"\\])*`;
const TITLE = String.raw`(?:\s+"${TITLE_BODY}")?`;

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
    new RegExp(
      String.raw`\]\((${DESTINATION_BODY})\s+"(${TITLE_BODY})"\)`,
      "g",
    ),
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

/** A line that would start a nested list if lifted onto the marker line. */
const NESTED_LIST = /^(?:[-*+]|\d+[.)])\s/;

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
    // A nested list must not be pulled up: `1.  - child` is no longer nested,
    // and both shapes parse as a single `list` block, so alignment never sees
    // the difference. Stripping the label instead is worse — the indented
    // content then reparses as code blocks.
    if (NESTED_LIST.test(first.trim())) {
      out.push(line);
      continue;
    }
    out.push(`${marker[1]}${first.trim()}`);
    i = j;
  }
  return out.join("\n");
}

/**
 * What a repair needs to know about the article beyond its body text.
 *
 * Only `stripHeadingAnchors` reads it; the rest ignore the argument. It is
 * threaded rather than looked up because `zh.md` has no frontmatter of its
 * own, and both halves of a pair must reach the same verdict or the repair
 * edits one file and not the other.
 */
export interface RepairContext {
  /** The page this article was clipped from, from `index.md` frontmatter. */
  articleUrl?: string;
}

/**
 * Whether a heading's trailing link points back into this same article.
 *
 * Neither the link's text nor the presence of a fragment is sufficient. A
 * heading may genuinely end in a deep link that carries one —
 * `## Syntax [§](https://html.spec.whatwg.org/#syntax)` — and stripping that
 * deletes something the page said, which is worse than leaving a marker
 * behind. A permalink is by definition same-document, so that is what gets
 * checked: a bare fragment, or an absolute URL agreeing with the article's own
 * origin and path.
 *
 * Without a known article URL only the bare form qualifies. That is the
 * conservative direction — an unrepaired heading, never a deleted link.
 */
function isSelfPermalink(destination: string, articleUrl?: string): boolean {
  const raw = destination.replace(/^<|>$/g, "").replace(/\\([()])/g, "$1");
  if (raw.startsWith("#")) return raw.length > 1;
  if (articleUrl === undefined) return false;
  try {
    const target = new URL(raw);
    if (target.hash.length <= 1) return false;
    // Trailing slashes are not a difference: the vault's own case links
    // `…/understanding-chatgpt-work/#two-products` from an article whose url
    // has no trailing slash.
    const place = (url: URL) =>
      `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return place(target) === place(new URL(articleUrl));
  } catch {
    return false;
  }
}

/**
 * A heading ending in its own permalink anchor: `## Title [#](#title)`.
 *
 * The link text is restricted to the symbols generators actually use for this
 * affordance, so an ordinary heading that merely ends in a link — `## See
 * [the docs](…)` — cannot match.
 *
 * The gap before the anchor is `[^\S\n]` — every whitespace character except a
 * newline — not `[ \t]`. Generators emit `&nbsp;` there to stop the marker
 * wrapping onto a line of its own, so the separator is routinely U+00A0. A
 * `[ \t]` version of this pattern matched none of the 14 headings on the one
 * article in the vault that has them, while every unit test still passed,
 * because the fixtures used ordinary spaces.
 */
const HEADING_ANCHOR = new RegExp(
  String.raw`^(#{1,6} +.*\S)[^\S\n]*\[[#¶§]\]\((${DESTINATION_BODY})${TITLE}\)[^\S\n]*$`,
  "gm",
);

/**
 * Drop a heading's trailing permalink anchor.
 *
 * Static-site generators append a self-link to every heading — typically
 * `<a class="headerlink" href="#section">#</a>` — as the hover affordance that
 * reveals the anchor. On the page it is invisible until hover; in markdown
 * Turndown has no reason to treat it as anything but a link, so it survives as
 * `[#](…)` and every heading publishes with a trailing `#`.
 *
 * Like `rejoinSplitFootnotes`, this has no counterpart in `apps/extension`, so
 * a re-clip reproduces it. The clipper-side mirror would be a dom-prepare pass
 * removing `a.headerlink`/`a.anchor` inside `h1`–`h6`.
 */
export function stripHeadingAnchors(
  body: string,
  context: RepairContext = {},
): string {
  return body.replace(
    HEADING_ANCHOR,
    (match, heading: string, destination: string) =>
      isSelfPermalink(destination, context.articleUrl) ? heading : match,
  );
}

/**
 * Lift images that markdown is reading as an indented code block.
 *
 * A page that pretty-prints `<picture>` puts the `<img>` on its own line
 * indented under the wrapper. Turndown has no rule for `<picture>`, so it keeps
 * those whitespace text nodes, and the image lands four or more spaces in —
 * which is an indented code block. The site then renders the literal text
 * `![](…)` in a syntax-highlighted box and the image never appears at all. One
 * article in the vault is five images, and all five are lost this way.
 *
 * Unlike every transform in `TRANSFORMS`, this cannot run inside
 * `outsideVerbatim`: the damaged block *is* a `code` block, so the very
 * protection that keeps the line transforms honest hides these lines from them.
 * It therefore runs as a pre-pass over the whole body, and asks the parser
 * rather than scanning lines — which is also what makes it safe. Indentation
 * inside a list is part of a `list` block, never a top-level `code` block, so
 * legitimately-nested content is unreachable here by construction rather than
 * by a heuristic that has to recognise list context.
 *
 * The candidate is lifted and handed to the parser rather than matched line by
 * line. A regex for image syntax is always narrower than the real thing —
 * Turndown escapes parentheses in a destination and brackets in alt text, and
 * a `[^()]`-style pattern rejects both, declining to repair the defect instead
 * of failing visibly. Asking whether the lifted text is one image-only
 * paragraph also states the property that matters directly: one `code` block
 * becomes exactly one `paragraph`, so `index.md` and `zh.md` stay aligned.
 *
 * The residual risk is a markdown tutorial whose indented sample is nothing
 * but image syntax; no parser signal separates that from this.
 */
export function deindentBlockImages(body: string): string {
  let out = "";
  let cursor = 0;
  for (const block of splitBlocks(body)) {
    if (block.type !== "code") continue;
    const lines = block.text.split("\n");
    const lifted = lines.map((line) => line.replace(/^\s+/, "")).join("\n");
    if (!isImageOnlyParagraph(lifted)) continue;
    // Blocks arrive in document order and each `text` is an exact slice, so a
    // forward scan rebuilds the body with everything between blocks untouched.
    const at = body.indexOf(block.text, cursor);
    if (at === -1) continue;
    out += body.slice(cursor, at);
    out += lines.map((line) => line.replace(/^\s+/, "")).join("\n");
    cursor = at + block.text.length;
  }
  return out + body.slice(cursor);
}

const TRANSFORMS: Array<(body: string, context: RepairContext) => string> = [
  joinLinkTitles,
  rejoinSplitLinks,
  rejoinSplitFootnotes,
  promoteTableHeaders,
  liftDuplicateListMarkers,
  stripHeadingAnchors,
];

/** Apply every repair to one markdown body. */
export function repairBody(body: string, context: RepairContext = {}): string {
  // Normalize once here rather than teaching each transform about `\r`. Three
  // separate CRLF defects were fixed one at a time and each left the next
  // standing, because every transform was individually responsible for line
  // endings — two of them silently did nothing on a CRLF article while the
  // other three worked, which is worse than not running at all. Converting at
  // the boundary makes every transform LF-only by construction, including ones
  // written later by someone who never thinks about this.
  if (!isUniformlyCrlf(body)) return repairLf(body, context);
  return repairLf(body.replaceAll("\r\n", "\n"), context).replaceAll(
    "\n",
    "\r\n",
  );
}

function repairLf(body: string, context: RepairContext): string {
  // The pre-pass runs first and outside the masking, because the block it
  // repairs is itself verbatim — see `deindentBlockImages`. Once lifted, the
  // image is ordinary prose and the line transforms see it like any other.
  return outsideVerbatim(deindentBlockImages(body), (prose) =>
    TRANSFORMS.reduce((text, transform) => transform(text, context), prose),
  );
}

/**
 * Every line ends `\r\n` — no line ends with a bare `\n`.
 *
 * A bare `\n` is the only thing that disqualifies a body, because it is the
 * only thing normalize-then-restore cannot survive: restoring turns every `\n`
 * into `\r\n`, so a body that mixed the two would come back changed on lines
 * the repair never touched. Such a body takes the direct path and is repaired
 * on its LF-terminated lines only; nothing in Tiro produces one.
 *
 * A lone `\r` is *not* disqualifying, though it reads like it should be.
 * `replaceAll("\r\n", "\n")` cannot consume one, and the restore cannot
 * manufacture one, so it passes through untouched — verified by property test
 * over every combination of `\r`, `\r\n` and text. Excluding it cost real
 * repairs: an otherwise-CRLF article with a carriage return inside a code fence
 * skipped normalization, and the two transforms that anchor on `\n` silently
 * did nothing.
 */
function isUniformlyCrlf(body: string): boolean {
  return body.includes("\r\n") && !/(?<!\r)\n/.test(body);
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

    // Read once from index.md and used for both files: zh.md carries no
    // frontmatter, and a repair that ran on one side only would edit a pair
    // out of agreement.
    const context: RepairContext = { articleUrl: articleUrlOf(indexText) };
    const newIndex = repairFile(indexText, context);
    const newZh = zhText === null ? null : repairFile(zhText, context);

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
      const writes: { pathAbs: string; contents: string; original: string }[] =
        [];
      if (newIndex !== indexText) {
        writes.push({
          pathAbs: indexAbs,
          contents: newIndex,
          original: indexText,
        });
      }
      if (newZh !== null && newZh !== zhText && zhText !== null) {
        writes.push({ pathAbs: zhAbs, contents: newZh, original: zhText });
      }
      await writePairAtomically(writes);
    }
    repaired.push({ slug, files });
  }

  return { repaired, refused, scanned };
}

/**
 * Replace a whole set of files, or none of them.
 *
 * `checkAlignment` above decides the pair is safe to write; that promise is only
 * worth anything if both halves actually land. Writing them one after another
 * meant a failure on the second — a full disk, a permission change mid-run —
 * left the article repaired on one side and not the other, which is exactly the
 * misaligned state the check exists to prevent.
 *
 * Staged writes first, then renames. Everything that can realistically fail
 * happens while the originals are still in place, and `rename(2)` within a
 * directory is atomic, the same reasoning the translation checkpoint uses
 * (`llm/cache.ts`, ADR 0008). Should a rename still fail partway, the originals
 * are in memory and go back.
 */
async function writePairAtomically(
  writes: readonly { pathAbs: string; contents: string; original: string }[],
): Promise<void> {
  const staged: string[] = [];
  try {
    for (const write of writes) {
      const tmpAbs = `${write.pathAbs}.tmp`;
      // Recorded before the write, not after: a write that fails partway — a
      // full disk is the obvious way — can still have created the file, and a
      // path only added on success is a path cleanup never sees. `rm` with
      // `force` on one that was never created costs nothing.
      staged.push(tmpAbs);
      await Bun.write(tmpAbs, write.contents);
    }
    for (const [i, write] of writes.entries()) {
      const tmpAbs = staged[i];
      if (tmpAbs !== undefined) await rename(tmpAbs, write.pathAbs);
    }
  } catch (error) {
    // Put back whatever did land, then clear the staging files so the vault's
    // `git add -A` never commits them.
    for (const write of writes) {
      await Bun.write(write.pathAbs, write.original).catch(() => {});
    }
    for (const tmpAbs of staged) await rm(tmpAbs, { force: true });
    throw error;
  }
}

/** Frontmatter is YAML, not markdown — repair the body and leave it alone. */
/** The article's own url, or undefined when the frontmatter cannot be read —
 * a repair must never fail because it could not learn its context. */
function articleUrlOf(indexText: string): string | undefined {
  try {
    return parseArticle(indexText).frontmatter.url;
  } catch {
    return undefined;
  }
}

function repairFile(text: string, context: RepairContext): string {
  const end = frontmatterLength(text);
  if (end === null) return repairBody(text, context);
  return text.slice(0, end) + repairBody(text.slice(end), context);
}

function bodyOf(text: string): string {
  const end = frontmatterLength(text);
  return end === null ? text : text.slice(end);
}
