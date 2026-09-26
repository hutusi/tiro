import { readdir, rm, stat } from "node:fs/promises";
import {
  type ArticleFrontmatter,
  ArticleFrontmatterSchema,
  INBOX_DIR,
  indexPath,
  normalizeUrl,
  slugForUrl,
  stringifyArticle,
  TIRO_SCHEMA_VERSION,
} from "@tiro/shared";

/**
 * Turn the links waiting in `inbox/` into article stubs (ADR 0034).
 *
 * A phone cannot compute a slug — normalizing the URL, hashing it and
 * slugifying it are not things a share-sheet shortcut can do — so it saves the
 * URL into a file of its own, and this is where it becomes an article: a stub
 * under `articles/<slug>/` holding the URL and `tiro.capture: "link"`, with no
 * body until the link stage fetches the page. The inbox file is deleted in the
 * same run, so the commit that adds the stub removes the file that asked for it.
 *
 * Never overwrites. A URL that already has an article — clipped in a browser,
 * or saved twice — keeps the article it has; the inbox file is simply
 * consumed. A browser clip is always the better body.
 */

export interface InboxReport {
  /** Became a new stub. */
  saved: { file: string; slug: string; url: string }[];
  /** Named an article that already exists, which is kept as it is. */
  existing: { file: string; slug: string }[];
  /** Held no usable link. Deleted, and reported as a run failure, since the
   * save it came from is otherwise lost without a word. */
  rejected: { file: string; reason: string }[];
}

export interface InboxOptions {
  dryRun?: boolean;
  now?: () => Date;
  /** The tiro commit the processor runs from, recorded as the stub's
   * `clipper_commit`: it is the code that will clip the page. */
  clipperCommit?: string;
  log?: (message: string) => void;
}

/** A save is a URL, perhaps with the text a share sheet puts around it;
 * anything bigger is not what the inbox is for. */
const MAX_INBOX_FILE_BYTES = 64 * 1024;

/** The first http(s) URL in a file's text. The shortcut writes the URL alone,
 * but a hand-made file, or text a share sheet included, is read the same way. */
function firstLink(text: string): string | null {
  const match = /https?:\/\/[^\s<>"'`]+/i.exec(text);
  if (match === null) return null;
  // Sentence punctuation that trails a pasted link is not part of it.
  return match[0].replace(/[).,;:!?\]]+$/, "");
}

export async function drainInbox(
  vaultDir: string,
  options: InboxOptions = {},
): Promise<InboxReport> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const report: InboxReport = { saved: [], existing: [], rejected: [] };
  const inboxDir = `${vaultDir}/${INBOX_DIR}`;

  let names: string[];
  try {
    names = (await readdir(inboxDir)).filter((name) => !name.startsWith("."));
  } catch {
    return report; // no inbox yet: nothing was ever saved
  }
  names.sort();

  for (const name of names) {
    const path = `${inboxDir}/${name}`;
    const file = `${INBOX_DIR}/${name}`;
    // Any one file failing never stops the others (invariant 7).
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const reject = async (reason: string) => {
        report.rejected.push({ file, reason });
        log(`inbox: ${file} rejected: ${reason}`);
        if (options.dryRun !== true) await rm(path, { force: true });
      };
      if (info.size > MAX_INBOX_FILE_BYTES) {
        await reject(`${info.size} bytes, more than a saved link`);
        continue;
      }
      const raw = firstLink(await Bun.file(path).text());
      if (raw === null) {
        await reject("no http(s) link in it");
        continue;
      }
      let url: string;
      try {
        url = normalizeUrl(raw);
      } catch {
        await reject(`not a URL: ${raw}`);
        continue;
      }
      const slug = await slugForUrl(url);
      const target = `${vaultDir}/${indexPath(slug)}`;
      if (await Bun.file(target).exists()) {
        report.existing.push({ file, slug });
        log(`inbox: ${file} names ${slug}, which already exists; keeping it`);
        if (options.dryRun !== true) await rm(path, { force: true });
        continue;
      }
      report.saved.push({ file, slug, url });
      log(`inbox: ${file} → ${slug}`);
      if (options.dryRun === true) continue;
      const domain = new URL(url).hostname;
      const frontmatter: ArticleFrontmatter = ArticleFrontmatterSchema.parse({
        url,
        // A placeholder until the page is fetched; the site hides an article
        // with no body, so nobody reads it as a title.
        title: domain,
        domain,
        clipped_at: now().toISOString(),
        tiro: {
          schema: TIRO_SCHEMA_VERSION,
          ...(options.clipperCommit !== undefined &&
          options.clipperCommit !== ""
            ? { clipper_commit: options.clipperCommit }
            : {}),
          capture: "link",
        },
      });
      await Bun.write(target, stringifyArticle(frontmatter, ""));
      await rm(path, { force: true });
    } catch (error) {
      // Left in place: whatever went wrong here may not go wrong next run,
      // and deleting the file would lose the save.
      report.rejected.push({ file, reason: String(error) });
      log(`inbox: ${file} could not be read: ${String(error)}`);
    }
  }
  return report;
}
