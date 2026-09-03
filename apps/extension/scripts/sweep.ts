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
 * What it is not: proof that a change is safe. A corpus of 34 articles contains
 * the shapes it contains — every guard in `unwrapMediaWrappers` was added for a
 * failure this sweep reported as byte-identical, because no vault page carries
 * a sidebar around a lone figure. It finds corpus regressions. Adversarial
 * shapes belong in `test/dom-prepare.test.ts`.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const IMAGE = /!\[[^\]]*\]\(/;

/**
 * An image line ending in a hard break is a folded figure caption (ADR 0011).
 *
 * Spelled as `endsWith` rather than folded into the regex because the signal is
 * two literal trailing spaces, and a regex that ends in whitespace is the kind
 * of thing a formatter silently eats.
 */
export function countMarkdown(markdown: string): Counts {
  let images = 0;
  let captions = 0;
  for (const line of markdown.split("\n")) {
    if (!IMAGE.test(line)) continue;
    images++;
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
 * The cache is what makes the sweep usable: a run costs 34 requests the first
 * time and none afterwards, so comparing two clipper versions compares the
 * clipper rather than whatever the sites served that minute. Delete the
 * directory to refresh.
 */
async function fetchPage(url: string, cache: string, slug: string) {
  const path = join(cache, `${slug}.html`);
  if (existsSync(path)) return readFile(path, "utf-8");
  const response = await fetch(url, {
    headers: {
      // Several sites serve a stub to an unrecognised agent, and a stub clips
      // to an empty article that looks exactly like a regression.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  await mkdir(cache, { recursive: true });
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
      "usage: sweep --vault <dir> [--baseline <git-ref>] [--cache <dir>] [--only <slug>]",
    );
    process.exit(2);
  }
  return {
    vault,
    baseline: get("baseline"),
    only: get("only"),
    cache: get("cache") ?? ".sweep-cache",
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
    baselineClip = await loadBaseline(args.baseline);
  }

  console.log(
    baselineClip === null
      ? `Re-clip advisor — ${articles.length} article(s), vault body vs a fresh clip`
      : `Regression sweep — ${articles.length} article(s), ${args.baseline} vs working tree`,
  );

  let changed = 0;
  let failed = 0;
  for (const article of articles) {
    let html: string;
    try {
      html = await fetchPage(article.url, args.cache, article.slug);
    } catch (error) {
      // A page that will not load is not a finding about the clipper, and must
      // not stop the other 33 from being reported.
      console.log(`  ?  ${article.slug}: fetch failed (${String(error)})`);
      failed++;
      continue;
    }

    const after = clipHtml(html, article.url, clipPage);
    const before =
      baselineClip === null
        ? article.body
        : clipHtml(html, article.url, baselineClip);

    if (baselineClip !== null && before === after) continue;
    const delta = describe(countMarkdown(before), countMarkdown(after));
    if (baselineClip === null && delta === null) continue;

    changed++;
    console.log(`  ${article.slug}: ${delta ?? "text differs"}`);
  }

  const scope = baselineClip === null ? "would change" : "differ";
  console.log(
    `\n${changed} of ${articles.length} ${scope}` +
      (failed > 0 ? `, ${failed} could not be fetched` : ""),
  );
}

/**
 * Import the clipper as of a git ref, via a worktree.
 *
 * A worktree rather than `git show`, because the pipeline is several modules
 * and they import each other by relative path. Left on disk under the cache so
 * a repeated comparison against the same ref does not re-check it out; it is a
 * normal worktree and `git worktree remove` disposes of it.
 */
async function loadBaseline(ref: string): Promise<Clip> {
  const { $ } = await import("bun");
  const dir = join(process.cwd(), ".sweep-cache", `baseline-${ref}`);
  if (!existsSync(dir)) {
    await $`git worktree add --detach ${dir} ${ref}`.quiet();
  }
  const entry = join(dir, "apps/extension/src/clip-page.ts");
  if (!existsSync(entry)) {
    // Before clip-page.ts existed the pipeline lived inside the injected IIFE,
    // which cannot be imported. Say so rather than failing on a module error.
    throw new Error(
      `${ref} predates apps/extension/src/clip-page.ts, so its clipper cannot be imported`,
    );
  }
  const module = (await import(entry)) as { clipPage: Clip };
  return module.clipPage;
}

// Guarded so the pure helpers above can be imported by tests without the
// script fetching 34 pages as a side effect of the import.
if (import.meta.main) await main();
