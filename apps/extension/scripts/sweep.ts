/**
 * Clip every article in a vault from its source page and report what a re-clip
 * would change.
 *
 * The clipper is the one part of Tiro whose output nobody sees until an article
 * is already published, and its failures are silent by construction: an image
 * Readability deleted leaves nothing behind to notice. Two of the three
 * articles that lost every image to `MEDIA-DROP` had been live for a week.
 *
 * So this asks the only question that finds those: clip the page again and
 * compare. Two modes, and they answer different things.
 *
 *   --baseline <git-ref>   Regression sweep. Clips each page twice, once with
 *                          the working tree and once with the clipper at
 *                          <ref>, and diffs the two. Answers "did my change
 *                          break anything on the corpus?" — the check to run
 *                          before merging a clipper change.
 *
 *   --fill-languages       Language backfill. Clips each page, and copies the
 *                          fence languages the current clipper recovers onto
 *                          the bare fences already committed. Answers "what
 *                          can today's clipper tell me about yesterday's
 *                          clips?" — reports only, until `--write`.
 *
 *   --recanonicalize       Slug migration. Finds articles whose directory name
 *                          no longer matches the slug their URL derives to,
 *                          renames them, and rewrites the frontmatter — the
 *                          repair path for a changed identity rule, which
 *                          `validate` can detect but not fix. Bodies and
 *                          `zh.md` are untouched, so nothing is re-translated.
 *                          Reports only, until `--write`.
 *
 *   (default)              Re-clip advisor. Compares a fresh clip against the
 *                          body committed in the vault. Answers "which
 *                          articles would gain from being re-clipped?"
 *
 * Three things it cannot see, all of which can make a result wrong rather than
 * merely incomplete. They are stated here, printed by the tool, and repeated in
 * docs/operations.md, because a sweep that is quietly unsound is worse than no
 * sweep at all.
 *
 * 1. **It reads raw HTML; the extension reads Chrome's rendered DOM.** A page
 *    that builds its article in JavaScript arrives here as a shell — two
 *    gatesnotes articles in the corpus do exactly that — and lazy-loaded images
 *    resolve in a browser and not here. Only a headless browser fixes this, and
 *    that is a different tool. `--min-chars` flags the shells it can detect.
 * 2. **A `--baseline` run resolves dependencies from the working tree.** The
 *    worktree holds source, not `node_modules`, so both sides import today's
 *    Readability and Turndown. That is what you want when judging your own
 *    change and exactly wrong when judging a dependency bump — which would show
 *    as byte-identical. The run warns when the baseline's lockfile differs.
 * 3. **The corpus contains the shapes it contains.** Every guard in
 *    `unwrapMediaWrappers` exists for a failure this sweep reports as
 *    byte-identical, because no vault page wraps a lone figure in a sidebar. It
 *    finds corpus regressions; it is not a safety argument, and adversarial
 *    shapes belong in `test/dom-prepare.test.ts`.
 */

import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ArticleFrontmatter,
  canonicalLanguage,
  checkAlignment,
  detectLanguage,
  foldedFigureCount,
  imageOffsets,
  normalizeUrl,
  parseArticle,
  slugForUrl,
  splitBlocks,
  stringifyArticle,
} from "@tiro/shared";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";
import type { ClipPayload } from "../src/messages.ts";

interface Article {
  slug: string;
  url: string;
  /** The article body as committed, frontmatter removed. */
  body: string;
  /** Parsed frontmatter, so a mode can rewrite it without re-reading. */
  frontmatter: ArticleFrontmatter;
}

interface Counts {
  images: number;
  captions: number;
}

/**
 * Count images, and the paragraphs shaped like a folded figure (ADR 0011).
 *
 * Both come from the markdown parser via `@tiro/shared`, and nothing here reads
 * the text by line any more. Every version of this counter that did was wrong
 * in a way the vault happened not to expose: a regex over `[^\]]` missed the
 * escaped alt text the clipper really emits, a fence check by line shape missed
 * four-backtick and blockquoted fences, and splitting on `\n` left a `\r` that
 * made every folded caption in a CRLF document invisible.
 */
export function countMarkdown(markdown: string): Counts {
  return {
    images: imageOffsets(markdown).length,
    captions: foldedFigureCount(markdown),
  };
}

/**
 * Read a vault's articles through the shared contract parser.
 *
 * `parseArticle` rather than a regex over the frontmatter, because the contract
 * is a keystone this repo already owns and hand-parsing it gets the edge cases
 * wrong: a quoted `url: "https://…"` — which is how every fixture article
 * writes it — came back with its quotes attached, and the fetch then failed on
 * every one of them while the run still exited 0.
 *
 * A malformed article is reported and skipped rather than ending the sweep, on
 * the same reasoning as a page that will not load: it is a fact about one
 * article, not about the corpus.
 */
async function loadArticles(vault: string): Promise<Article[]> {
  const root = join(vault, "articles");
  const entries = await readdir(root, { withFileTypes: true });
  const articles: Article[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "index.md");
    if (!existsSync(path)) continue;
    try {
      const { frontmatter, body } = parseArticle(await readFile(path, "utf-8"));
      articles.push({
        slug: entry.name,
        url: frontmatter.url,
        body,
        frontmatter,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`  ?  ${entry.name}: unreadable frontmatter (${reason})`);
    }
  }
  return articles;
}

/**
 * Fetch a page, caching it on disk.
 *
 * The cache is what makes the sweep usable: a run costs one request per article
 * the first time and none afterwards, so comparing two clipper versions
 * compares the clipper rather than whatever the sites served that minute.
 *
 * The deadline is not optional. Without it one server that accepts a connection
 * and then stops talking hangs the whole corpus indefinitely, and the run has
 * no output to show for the articles it already did.
 */
async function fetchPage(url: string, pages: string, slug: string) {
  const path = join(pages, `${slug}.html`);
  if (existsSync(path)) return readFile(path, "utf-8");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      // Several sites serve a stub to an unrecognised agent, and a stub clips
      // to an empty article that looks exactly like a regression.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  await mkdir(pages, { recursive: true });
  await writeFile(path, html);
  return html;
}

type Clip = (doc: Document, url: string) => { markdown: string };

/**
 * Clip one page with a given implementation.
 *
 * `documentElement.innerHTML` rather than a full parse because happy-dom has
 * no document parser that keeps `<head>`; the regex trims the wrapper so the
 * head's `<link>` and `<meta>` still land where Readability looks for them.
 *
 * Subresource loading is off because it is not inert: happy-dom really does
 * issue a request for every `<link rel=preload as=style|script>`, through its
 * own Fetch rather than the global one, and nine pages in the corpus carry
 * them. Left on, a sweep quietly reaches the network while parsing a cached
 * page — which is both slower and a straight contradiction of the reason the
 * cache exists, since a `--baseline` run would be comparing two clips taken
 * against whatever those CDNs served each time. (JavaScript evaluation needs no
 * flag; happy-dom disables it by default.)
 *
 * Each window is closed rather than dropped. One per article per side, held for
 * the life of the process, is exactly the shape that turns a long corpus into a
 * memory problem.
 */
async function clipHtml<T>(
  html: string,
  url: string,
  clip: (doc: Document, url: string) => T,
): Promise<T> {
  const window = new Window({
    url,
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      navigation: {
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  try {
    const doc = window.document as unknown as Document;
    doc.documentElement.innerHTML = html
      .replace(/^[\s\S]*?<html[^>]*>/i, "")
      .replace(/<\/html>[\s\S]*$/i, "");
    return clip(doc, url);
  } finally {
    await window.happyDOM.close();
  }
}

function describe(before: Counts, after: Counts): string | null {
  const images = after.images - before.images;
  const captions = after.captions - before.captions;
  if (images === 0 && captions === 0) return null;
  const parts: string[] = [];
  if (images !== 0) parts.push(`${images > 0 ? "+" : ""}${images} images`);
  if (captions !== 0) {
    parts.push(`${captions > 0 ? "+" : ""}${captions} captions`);
  }
  return parts.join(", ");
}

/* ---------------------------------------------------------------- backfill */

interface Span {
  start: number;
  end: number;
  text: string;
}

const FENCE = /^(`{3,}|~{3,})/;

/**
 * Every top-level code block in a document, with the offsets to edit it.
 *
 * `Block` carries the source slice but not where it came from, and the slices
 * arrive in document order, so a cursor walk recovers the offsets exactly
 * without re-parsing or guessing at a unique substring.
 */
function codeSpans(source: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const block of splitBlocks(source)) {
    const at = source.indexOf(block.text, cursor);
    if (at === -1) continue;
    cursor = at + block.text.length;
    if (block.type === "code") {
      spans.push({ start: at, end: cursor, text: block.text });
    }
  }
  return spans;
}

/** The info string on a fence's opening line, empty when it is bare. */
function fenceInfo(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return FENCE.test(line) ? line.replace(FENCE, "").trim() : "";
}

/**
 * The code inside a fence, as a key for matching one clip against another.
 *
 * Trailing whitespace and blank edges are noise that Turndown can move between
 * runs, and a key that keeps them makes a block fail to match itself.
 */
function fenceKey(text: string): string {
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const end = FENCE.test(last) ? lines.length - 1 : lines.length;
  return lines
    .slice(1, end)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Rewrite a fence's opening line to carry `language`. */
function withInfo(text: string, language: string): string {
  const newline = text.indexOf("\n");
  if (newline === -1) return text;
  const fence = text.slice(0, newline).match(FENCE)?.[1];
  if (fence === undefined) return text;
  return `${fence}${language}${text.slice(newline)}`;
}

/** Apply edits right to left, so earlier offsets stay valid. */
function applyEdits(
  source: string,
  edits: (Span & { text: string })[],
): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * The language each block of a fresh clip declares, keyed by its code.
 *
 * A key that two blocks of the same page disagree about is dropped rather than
 * resolved: the same snippet shown twice under different languages is a real
 * shape, and there is no way to tell from the vault which copy is which.
 */
function declaredLanguages(markdown: string): Map<string, string> {
  const found = new Map<string, string>();
  const rejected = new Set<string>();
  for (const span of codeSpans(markdown)) {
    const language = fenceInfo(span.text);
    if (language === "") continue;
    const key = fenceKey(span.text);
    if (key === "" || rejected.has(key)) continue;
    const seen = found.get(key);
    if (seen !== undefined && seen !== language) {
      found.delete(key);
      rejected.add(key);
      continue;
    }
    found.set(key, language);
  }
  return found;
}

interface Conflict {
  declared: string;
  inferred: string;
  /** The block's first line, so the report can be judged without opening it. */
  opening: string;
}

interface Backfill {
  /** Languages written, in document order, for the report. */
  languages: string[];
  /** Fences left bare because the page and the inference disagree. */
  conflicts: Conflict[];
  index: string;
  zh: string | null;
  /** Set when the edit was refused; nothing is written. */
  refused?: string;
}

/**
 * Whether a page's stated language and the site's inference actually disagree.
 *
 * Not every difference is one: a page writes `ts` where the site says
 * `typescript`, and both are the same answer, so the label is normalized before
 * comparing. An inference of `null` is no opinion rather than a contradiction —
 * most fences have none, and the page's label must still be written for those.
 *
 * A real disagreement is a signal worth stopping for, because this is the step
 * that makes a label permanent. `claude.com/blog` mislabels 4 of its own 13
 * blocks — a markdown document tagged `javascript`, a GitHub Actions step
 * tagged `markdown` — which is what a per-block dropdown in a CMS produces, and
 * writing those into the vault renders `- Build:` with the `-` coloured as a
 * minus operator for as long as the article exists.
 */
function conflicts(declared: string, code: string): Conflict | null {
  const inferred = detectLanguage(code);
  if (inferred === null) return null;
  // The same canonicalizer the site resolves grammars through, so `ts` against
  // an inferred `typescript` is one answer rather than a dispute.
  const canonical = canonicalLanguage(declared);
  if (canonical === null || canonical === inferred) return null;
  // `text` is a page saying "this is not code", which is exactly the answer
  // inference is not entitled to overrule. Treating the difference as a
  // conflict left the fence bare, and a bare fence is where inference runs —
  // so a block the page called plain came out highlighted, while a plain
  // re-clip of the same page would have written ```text and rendered it plain.
  // The backfill must not diverge from a re-clip.
  if (canonical === "plaintext") return null;
  return {
    declared,
    inferred,
    opening: (code.split("\n", 1)[0] ?? "").slice(0, 60),
  };
}

/**
 * Copy a fresh clip's fence languages onto an article's bare fences.
 *
 * `zh.md` moves in lockstep or nothing moves at all. `checkAlignment` compares
 * a `code` block's *source slice*, fence lines included, so a language written
 * into `index.md` alone breaks byte-identity — and a misaligned article is not
 * rendered wrong, it silently stops rendering side by side at all (ADR 0003).
 * Both files are therefore rewritten together and the result is re-checked
 * before either is offered for writing.
 */
export function backfill(
  indexText: string,
  zhText: string | null,
  fresh: string,
): Backfill | null {
  const { body } = parseArticle(indexText);
  const languages = declaredLanguages(fresh);
  if (languages.size === 0) return null;

  const indexEdits: (Span & { text: string })[] = [];
  const zhEdits: (Span & { text: string })[] = [];
  const written: string[] = [];
  const disputed: Conflict[] = [];
  const zhSpans = zhText === null ? [] : codeSpans(zhText);

  for (const span of codeSpans(body)) {
    if (fenceInfo(span.text) !== "") continue;
    const key = fenceKey(span.text);
    const language = key === "" ? undefined : languages.get(key);
    if (language === undefined) continue;

    const conflict = conflicts(language, key);
    if (conflict !== null) {
      disputed.push(conflict);
      continue;
    }

    if (zhText !== null) {
      // Matched on the whole slice, not the key: the translation holds this
      // block byte-for-byte, and anything looser would pair two blocks that
      // merely normalize alike.
      const mate = zhSpans.find(
        (other) =>
          other.text === span.text &&
          !zhEdits.some((e) => e.start === other.start),
      );
      // A block with no counterpart means the two files already disagree.
      // Editing one of them cannot improve that and can only deepen it.
      if (mate === undefined) {
        return {
          languages: [],
          conflicts: disputed,
          index: indexText,
          zh: zhText,
          refused: "index.md and zh.md do not correspond",
        };
      }
      zhEdits.push({ ...mate, text: withInfo(mate.text, language) });
    }
    indexEdits.push({ ...span, text: withInfo(span.text, language) });
    written.push(language);
  }

  if (indexEdits.length === 0) {
    return disputed.length === 0
      ? null
      : { languages: [], conflicts: disputed, index: indexText, zh: zhText };
  }

  const newBody = applyEdits(body, indexEdits);
  // `body` is a suffix of the file — `parseArticle` slices the frontmatter off
  // its front — so the head is exactly what precedes it.
  const head = indexText.slice(0, indexText.length - body.length);
  const newIndex = head + newBody;
  const newZh = zhText === null ? null : applyEdits(zhText, zhEdits);

  if (newZh !== null) {
    const result = checkAlignment(splitBlocks(newBody), splitBlocks(newZh));
    if (!result.ok) {
      return {
        languages: [],
        conflicts: disputed,
        index: indexText,
        zh: zhText,
        refused: `alignment would break (${result.errors[0] ?? "unknown"})`,
      };
    }
  }
  return {
    languages: written,
    conflicts: disputed,
    index: newIndex,
    zh: newZh,
  };
}

function tally(languages: string[]): string {
  const counts = new Map<string, number>();
  for (const one of languages) counts.set(one, (counts.get(one) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([language, n]) => (n === 1 ? language : `${language}×${n}`))
    .join(", ");
}

/**
 * Write an article's files so a failure cannot leave them disagreeing.
 *
 * `index.md` and `zh.md` have to change together — a language in one alone
 * breaks the byte-identity `checkAlignment` requires — and a plain pair of
 * writes fails that in two ways: a torn write leaves one file corrupt, and a
 * failure between the two leaves the article half-labelled. Neither is
 * repairable by a later run, which skips a fence that already carries a
 * language.
 *
 * Both files are written whole to temporaries first, so nothing is in place
 * until everything has been produced, and then renamed. The window that
 * remains is between two renames: no I/O happens in it, and this writes to a
 * git repository whose diff the operator is about to read. A durable journal
 * would close it, and would be a great deal of machinery for a local tool
 * whose recovery is `git checkout`.
 */
async function writeTogether(
  files: readonly (readonly [path: string, text: string])[],
): Promise<void> {
  const staged: [temp: string, path: string][] = [];
  try {
    for (const [path, text] of files) {
      const temp = `${path}.tiro-tmp`;
      await writeFile(temp, text);
      staged.push([temp, path]);
    }
  } catch (error) {
    await Promise.all(staged.map(([temp]) => rm(temp, { force: true })));
    throw error;
  }
  for (const [temp, path] of staged) await rename(temp, path);
}

async function fillLanguages(
  articles: Article[],
  args: ReturnType<typeof parseArgs>,
): Promise<{ failed: number }> {
  console.log(
    `Language backfill — ${articles.length} article(s)` +
      (args.write ? "" : " (reporting only; pass --write to apply)"),
  );
  let filled = 0;
  let fences = 0;
  let failed = 0;
  let disputed = 0;
  for (const article of articles) {
    const dir = join(args.vault, "articles", article.slug);
    const indexPath = join(dir, "index.md");
    const zhPath = join(dir, "zh.md");
    let result: Backfill | null;
    let indexText: string;
    let zhText: string | null;
    try {
      const html = await fetchPage(article.url, args.pages, article.slug);
      const fresh = (await clipHtml(html, article.url, clipPage)).markdown;
      indexText = await readFile(indexPath, "utf-8");
      zhText = existsSync(zhPath) ? await readFile(zhPath, "utf-8") : null;
      result = backfill(indexText, zhText, fresh);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  ?  ${article.slug}: ${reason}`);
      failed++;
      continue;
    }
    if (result === null) continue;
    if (result.refused !== undefined) {
      console.log(`  !  ${article.slug}: refused — ${result.refused}`);
      failed++;
      continue;
    }
    if (result.languages.length > 0) {
      filled++;
      fences += result.languages.length;
      console.log(
        `  ${article.slug}: ${result.languages.length} fence(s) — ${tally(result.languages)}`,
      );
    }
    for (const conflict of result.conflicts) {
      disputed++;
      console.log(
        `  !  ${article.slug}: left bare — page says ${conflict.declared}, ` +
          `code reads ${conflict.inferred}\n     ${conflict.opening}`,
      );
    }
    if (!args.write || result.languages.length === 0) continue;
    await writeTogether(
      result.zh === null
        ? [[indexPath, result.index]]
        : [
            [indexPath, result.index],
            [zhPath, result.zh],
          ],
    );
  }
  const verb = args.write ? "labelled" : "would be labelled";
  const notes = [
    disputed > 0 ? `${disputed} left bare over a disagreement` : "",
    failed > 0 ? `${failed} could not be read or were refused` : "",
  ].filter((note) => note !== "");
  console.log(
    `\n${fences} fence(s) in ${filled} of ${articles.length} article(s) ${verb}` +
      (notes.length > 0 ? ` (${notes.join(", ")})` : ""),
  );
  return { failed };
}

/* -------------------------------------------------- slug recanonicalization */

export interface Recanonicalization {
  from: string;
  to: string;
  /** The article as it should be written, frontmatter rewritten, body as-is. */
  index: string;
  /** What the fresh clip changed about the metadata, for the report. */
  refreshed: string[];
  /** Set when the article must not be written; `index` is then not to be used.
   * Mirrors `Backfill.refused` above — a refusal is a fact about one article,
   * not a reason to end the run. */
  refused?: string;
}

/**
 * Rewrite one article's frontmatter for a changed identity rule.
 *
 * The body and `zh.md` are deliberately untouched. That is what makes this
 * cheap: block alignment cannot move, `tiro.processed_at` survives, and the
 * article is never re-queued — so a rule change costs no LLM calls at all.
 * Re-clipping would cost a full re-translation of every article it moved.
 *
 * `fresh` is optional because the rename is the part that must happen: an
 * article whose page no longer loads still has to stop being invisible to the
 * next clip of it.
 *
 * "Untouched" is *checked*, not merely intended. `stringifyArticle` trims the
 * body it is given, and if the article's final block were a code or math block
 * whose last line carried trailing whitespace, that trim would land inside the
 * block — leaving `index.md` and the untouched `zh.md` byte-different where
 * `checkAlignment` requires them identical, which drops the article out of
 * side-by-side rendering. No file the tooling wrote can be in that state, since
 * `stringifyArticle` is the only writer of `index.md` and trims on the way in,
 * so this cannot fire on a vault built by Tiro. It exists for the one that
 * could reach it: an `index.md` hand-edited outside the tooling. `repair.ts`
 * guards its own write the same way rather than trusting the invariant.
 */
export async function recanonicalize(
  article: Article,
  fresh: ClipPayload | null,
): Promise<Recanonicalization | null> {
  const url = normalizeUrl(article.url);
  const to = await slugForUrl(article.url);
  if (to === article.slug) return null;

  const refreshed: string[] = [];
  const frontmatter: ArticleFrontmatter = {
    ...article.frontmatter,
    url,
    // Re-derived, not carried over: `buildClipFile` takes the domain from the
    // canonical URL, so keeping the old one would leave a migrated article
    // saying `www.arxiv.org` on its card while linking to `arxiv.org` — and
    // disagreeing with what re-clipping the same page would produce.
    domain: new URL(url).hostname,
    tiro: {
      ...article.frontmatter.tiro,
      // The URL the body was read from — which is what the recorded URL was,
      // before canonicalization moved the article somewhere else.
      ...(article.url === url ? {} : { source_url: article.url }),
    },
  };
  if (fresh !== null) {
    for (const field of ["title", "author", "excerpt"] as const) {
      const value = fresh[field].trim();
      if (value === "" || value === frontmatter[field]) continue;
      frontmatter[field] = value;
      refreshed.push(field);
    }
  }
  const index = stringifyArticle(frontmatter, article.body);
  const written = parseArticle(index).body;
  if (written !== article.body) {
    return {
      from: article.slug,
      to,
      index,
      refreshed,
      refused: "rewriting the frontmatter would alter the body",
    };
  }
  return { from: article.slug, to, index, refreshed };
}

async function recanonicalizeAll(
  articles: Article[],
  args: ReturnType<typeof parseArgs>,
): Promise<{ failed: number }> {
  console.log(
    `Slug recanonicalization — ${articles.length} article(s)` +
      (args.write ? "" : " (reporting only; pass --write to apply)"),
  );
  const root = join(args.vault, "articles");
  let moved = 0;
  let failed = 0;
  for (const article of articles) {
    // Ask the cheap local question first. The slug is a hash of the article's
    // own URL, so whether it moves is knowable without the network — and a
    // migration touching two articles was fetching all thirty-six, each with a
    // 30-second timeout on a cold cache.
    if ((await slugForUrl(article.url)) === article.slug) continue;

    // Best-effort: a page that will not load costs the metadata refresh, not
    // the rename. Leaving the directory unmoved is the worse outcome — the
    // next clip of that page would create a second article beside it.
    let fresh: ClipPayload | null = null;
    let note = "";
    try {
      const html = await fetchPage(article.url, args.pages, article.slug);
      fresh = await clipHtml(html, article.url, clipPage);
    } catch (error) {
      note = ` (metadata left alone: ${error instanceof Error ? error.message : String(error)})`;
    }

    const plan = await recanonicalize(article, fresh);
    if (plan === null) continue;
    if (plan.refused !== undefined) {
      console.log(`  !  ${article.slug}: refused — ${plan.refused}`);
      failed++;
      continue;
    }
    moved++;
    const fields =
      plan.refreshed.length === 0
        ? ""
        : ` — refreshes ${plan.refreshed.join(", ")}`;
    console.log(`  ${plan.from}
    → ${plan.to}${fields}${note}`);
    if (!args.write) continue;

    const from = join(root, plan.from);
    const to = join(root, plan.to);
    if (existsSync(to)) {
      // rename onto an existing directory nests the source inside it instead
      // of failing — the same trap the 0007 layout migration documented.
      console.log(`  !  ${plan.to} already exists; left ${plan.from} in place`);
      failed++;
      continue;
    }
    // Written before the rename, not after: a crash between the two leaves the
    // article correct in the old directory, which this same mode fixes on the
    // next run. The other order leaves it moved and stale.
    await writeTogether([[join(from, "index.md"), plan.index]]);
    await rename(from, to);
  }
  const verb = args.write ? "moved" : "would move";
  console.log(
    `
${moved} of ${articles.length} article(s) ${verb}` +
      (failed > 0 ? ` (${failed} refused)` : ""),
  );
  return { failed };
}

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const vault = get("vault");
  if (vault === undefined) {
    console.error(
      "usage: sweep --vault <dir> [--baseline <git-ref>] [--cache <dir>]\n" +
        "             [--only <slug>] [--min-chars <n>]\n" +
        "       sweep --vault <dir> --fill-languages [--write] [--only <slug>]\n" +
        "       sweep --vault <dir> --recanonicalize [--write] [--only <slug>]",
    );
    process.exit(2);
  }
  // Absolute: a relative cache path resolves against the *importing module*
  // in a dynamic import(), not the working directory, so the baseline clipper
  // would be looked for beside this script.
  const cache = resolve(get("cache") ?? ".sweep-cache");
  const fillLanguages = argv.includes("--fill-languages");
  const recanonicalize = argv.includes("--recanonicalize");
  const exclusive = [
    fillLanguages && "--fill-languages",
    recanonicalize && "--recanonicalize",
    argv.includes("--baseline") && "--baseline",
  ].filter((name) => name !== false);
  if (exclusive.length > 1) {
    console.error(`${exclusive.join(" and ")} answer different questions`);
    process.exit(2);
  }
  return {
    vault,
    fillLanguages,
    recanonicalize,
    // Reporting is the default because this is the one mode that writes to the
    // content repo, and the run that changes it should be one someone has read.
    write: argv.includes("--write"),
    baseline: get("baseline"),
    only: get("only"),
    // Pages and worktrees are kept apart because the documented way to refresh
    // pages is to delete them, and deleting a registered worktree's directory
    // leaves git refusing to re-create it at the same path.
    pages: join(cache, "pages"),
    baselines: join(cache, "baselines"),
    minChars: minChars(get("min-chars")),
  };
}

/**
 * `Number("abc")` is NaN, and every `length < NaN` is false — so a typo here
 * silently turned the shell detection off rather than complaining.
 */
function minChars(raw: string | undefined): number {
  if (raw === undefined) return 500;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`--min-chars must be a non-negative number, got ${raw}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let articles = await loadArticles(args.vault);
  if (args.only !== undefined) {
    articles = articles.filter((a) => a.slug.includes(args.only as string));
  }
  if (articles.length === 0) {
    console.error("no articles matched");
    process.exit(2);
  }

  if (args.recanonicalize) {
    const { failed } = await recanonicalizeAll(articles, args);
    if (failed > 0) process.exit(1);
    return;
  }

  if (args.fillLanguages) {
    const { failed } = await fillLanguages(articles, args);
    // Same reasoning as the sweep's own guard below: some articles failing is
    // information about those articles, all of them failing is information
    // about the invocation and must not read as a clean run to a caller that
    // only checks the status.
    if (failed === articles.length) process.exit(1);
    return;
  }

  // Resolved once: importing the baseline clipper is the only part that can
  // fail for reasons that have nothing to do with any article.
  let baselineClip: Clip | null = null;
  if (args.baseline !== undefined) {
    try {
      baselineClip = await loadBaseline(args.baseline, args.baselines);
    } catch (error) {
      // A ref that cannot be loaded is an operator error, not a stack trace.
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  }

  console.log(
    baselineClip === null
      ? `Re-clip advisor — ${articles.length} article(s), vault body vs a fresh clip`
      : `Regression sweep — ${articles.length} article(s), ${args.baseline} vs working tree`,
  );

  let changed = 0;
  let failed = 0;
  let thin = 0;
  for (const article of articles) {
    let after: string;
    let before: string;
    try {
      const html = await fetchPage(article.url, args.pages, article.slug);
      after = (await clipHtml(html, article.url, clipPage)).markdown;
      before =
        baselineClip === null
          ? article.body
          : (await clipHtml(html, article.url, baselineClip)).markdown;
    } catch (error) {
      // Neither a page that will not load nor one that will not clip is a
      // finding about the corpus, and neither may stop the rest being reported.
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  ?  ${article.slug}: ${reason}`);
      failed++;
      continue;
    }

    // A page whose article is built in JavaScript arrives as a shell, and its
    // "losses" are the sweep's blind spot rather than the clipper's doing.
    //
    // In baseline mode both sides read the *same* fetched HTML, so a baseline
    // that got 10,000 characters out of it is proof the page is readable — and
    // a working tree that gets zero from it is the most catastrophic regression
    // the clipper can have, not a shell. Requiring both to be thin is what
    // keeps this heuristic from hiding exactly what the tool is for. In advisor
    // mode there is no such proof: the committed body was clipped from Chrome's
    // rendered DOM, which this cannot see, so the fresh clip stands alone.
    const bothThin = baselineClip === null || before.length < args.minChars;
    if (after.length < args.minChars && bothThin) {
      console.log(
        `  ?  ${article.slug}: clipped to ${after.length} chars — likely client-rendered, ignore its delta`,
      );
      thin++;
      continue;
    }

    if (baselineClip !== null && before === after) continue;
    const delta = describe(countMarkdown(before), countMarkdown(after));
    if (baselineClip === null && delta === null) continue;

    changed++;
    console.log(`  ${article.slug}: ${delta ?? "text differs"}`);
  }

  const scope = baselineClip === null ? "would change" : "differ";
  const notes = [
    failed > 0 ? `${failed} could not be read` : "",
    thin > 0 ? `${thin} likely client-rendered` : "",
  ].filter((n) => n !== "");
  console.log(
    `\n${changed} of ${articles.length} ${scope}` +
      (notes.length > 0 ? ` (${notes.join(", ")})` : ""),
  );

  // Some articles failing is information about those articles. *No* article
  // being comparable is information about the invocation — a wrong --vault, no
  // network, a corpus this cannot read — and must not read as a clean sweep to
  // a caller that only checks the status. A page skipped as a shell is as
  // uncompared as one that would not load, so both count.
  if (failed + thin === articles.length) process.exit(1);
}

/**
 * Import the clipper as of a git ref, via a worktree.
 *
 * A worktree rather than `git show`, because the pipeline is several modules
 * importing each other by relative path.
 *
 * Keyed by the resolved commit, never by the ref that named it. A directory
 * called `baseline-main` is right exactly until `main` moves, and then every
 * later run silently compares against a commit nobody asked for — the worst
 * failure available to a tool whose whole job is telling you what changed.
 */
async function loadBaseline(ref: string, baselines: string): Promise<Clip> {
  const { $ } = await import("bun");
  const sha = (await $`git rev-parse ${ref}^{commit}`.text()).trim();
  const dir = join(baselines, sha);
  // Clears entries whose directory was deleted by hand; without it git refuses
  // to re-create a worktree at a path it still has registered.
  await $`git worktree prune`.quiet();
  if (!existsSync(dir)) {
    await mkdir(baselines, { recursive: true });
    await $`git worktree add --detach ${dir} ${sha}`.quiet();
  }

  // The worktree has no node_modules, so both sides of the comparison import
  // the working tree's dependencies. Say so when that is load-bearing rather
  // than letting a dependency bump read as "no change".
  const root = (await $`git rev-parse --show-toplevel`.text()).trim();
  const theirs = await $`git show ${sha}:bun.lock`.text().catch(() => "");
  const ours = await readFile(join(root, "bun.lock"), "utf-8").catch(() => "");
  if (theirs !== "" && theirs !== ours) {
    console.warn(
      `  ! ${ref} has a different bun.lock, and both sides of this comparison\n` +
        "    import the working tree's dependencies — a dependency change will\n" +
        "    read as byte-identical here.",
    );
  }

  const entry = join(dir, "apps/extension/src/clip-page.ts");
  if (!existsSync(entry)) {
    // Before clip-page.ts existed the pipeline lived inside the injected IIFE,
    // which cannot be imported. Say so rather than failing on a module error.
    throw new Error(
      `${ref} (${sha.slice(0, 8)}) predates apps/extension/src/clip-page.ts, so its clipper cannot be imported`,
    );
  }
  const module = (await import(pathToFileURL(entry).href)) as {
    clipPage: Clip;
  };
  return module.clipPage;
}

// Guarded so the pure helpers above can be imported by tests without the
// script fetching a corpus as a side effect of the import.
if (import.meta.main) await main();
