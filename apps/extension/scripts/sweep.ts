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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { clipPage } from "../src/clip-page.ts";

interface Article {
  slug: string;
  url: string;
  /** The article body as committed, frontmatter removed. */
  body: string;
}

interface Counts {
  images: number;
  captions: number;
}

/** Global: a line may carry more than one image, and each one counts. */
const IMAGE = /!\[[^\]]*\]\(/g;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * Count images, and the subset that carry a folded caption (ADR 0011).
 *
 * Per image rather than per line, because Turndown emits adjacent images with
 * nothing between them — `![a](a.png)![b](b.png)` — and a per-line count
 * reports losing one of them as no change at all. Fenced code is skipped for
 * the same reason: an article *about* markdown contains image syntax that is
 * not an image, and counting it makes every diff of that article noise.
 *
 * A caption stays per line: a folded figure is one paragraph, however many
 * images the page put in it.
 */
export function countMarkdown(markdown: string): Counts {
  let images = 0;
  let captions = 0;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const found = line.match(IMAGE)?.length ?? 0;
    if (found === 0) continue;
    images += found;
    // Trailing whitespace is the whole signal, so test the raw line.
    if (line.endsWith("  ")) captions++;
  }
  return { images, captions };
}

/**
 * Strip YAML frontmatter. Deliberately not a YAML parse: the body is
 * everything after the second `---`, and a malformed head should surface as a
 * wrong count rather than a thrown error mid-sweep.
 */
export function stripFrontmatter(source: string): string {
  if (!source.startsWith("---\n")) return source;
  const end = source.indexOf("\n---\n", 4);
  return end === -1 ? source : source.slice(end + 5);
}

export function readUrl(frontmatter: string): string | null {
  const match = /^url:[ \t]*(\S+)[ \t]*$/m.exec(frontmatter);
  return match?.[1] ?? null;
}

async function loadArticles(vault: string): Promise<Article[]> {
  const root = join(vault, "articles");
  const entries = await readdir(root, { withFileTypes: true });
  const articles: Article[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "index.md");
    if (!existsSync(path)) continue;
    const source = await readFile(path, "utf-8");
    const url = readUrl(source);
    if (url === null) {
      console.warn(`  ${entry.name}: no url in frontmatter, skipped`);
      continue;
    }
    articles.push({ slug: entry.name, url, body: stripFrontmatter(source) });
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
 */
function clipHtml(html: string, url: string, clip: Clip): string {
  const window = new Window({ url });
  const doc = window.document as unknown as Document;
  doc.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, "")
    .replace(/<\/html>[\s\S]*$/i, "");
  return clip(doc, url).markdown;
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

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const vault = get("vault");
  if (vault === undefined) {
    console.error(
      "usage: sweep --vault <dir> [--baseline <git-ref>] [--cache <dir>]\n" +
        "             [--only <slug>] [--min-chars <n>]",
    );
    process.exit(2);
  }
  // Absolute: a relative cache path resolves against the *importing module*
  // in a dynamic import(), not the working directory, so the baseline clipper
  // would be looked for beside this script.
  const cache = resolve(get("cache") ?? ".sweep-cache");
  return {
    vault,
    baseline: get("baseline"),
    only: get("only"),
    // Pages and worktrees are kept apart because the documented way to refresh
    // pages is to delete them, and deleting a registered worktree's directory
    // leaves git refusing to re-create it at the same path.
    pages: join(cache, "pages"),
    baselines: join(cache, "baselines"),
    minChars: Number(get("min-chars") ?? 500),
  };
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
      after = clipHtml(html, article.url, clipPage);
      before =
        baselineClip === null
          ? article.body
          : clipHtml(html, article.url, baselineClip);
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
    if (after.length < args.minChars) {
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
