import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import type { FetchLike } from "./llm/client.ts";
import {
  fetchChecked,
  type ResolveHost,
  readBodyCapped,
  resolveViaDns,
  USER_AGENT,
} from "./net-fetch.ts";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};
const KNOWN_EXTENSIONS = new Set(Object.values(EXT_BY_CONTENT_TYPE));

/** What `assetFilename` produces: a 12-hex digest plus one of the extensions
 * above. Built from KNOWN_EXTENSIONS so adding a format cannot leave this
 * behind. Anything in assets/ not matching was put there by someone else. */
const PROCESSOR_ASSET_RE = new RegExp(
  `^[0-9a-f]{12}(?:${[...KNOWN_EXTENSIONS]
    .map((ext) => ext.replace(".", "\\."))
    .join("|")})$`,
);

const MD_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/g;

/**
 * Undo the ampersand escaping an HTML attribute requires.
 *
 * A `src` holding a query string must spell `&` as `&amp;` to be valid HTML,
 * so a CDN URL arrives here as `?w=800&amp;format=webp`. Fetched literally
 * that is a different URL: the CDN either ignores the parameters or 404s, and
 * the image falls back to a hotlink for no reason. Only the ampersand is
 * decoded — it is the one character an attribute is obliged to escape, and
 * decoding more would risk turning text that merely looks like an entity into
 * a different URL than the page asked for.
 */
function decodeAmpersands(url: string): string {
  // The two named spellings HTML actually defines, plus the numeric forms with
  // their optional leading zeros. Not case-insensitive: `&amp;` and `&AMP;`
  // are both in the character-reference table and `&aMp;` is not, so matching
  // loosely would rewrite a URL that legitimately contains that text.
  return url.replace(/&(?:amp|AMP|#0*38|#[xX]0*26);/g, "&");
}

// How a localized image is spelled once the stage has rewritten it.
const ASSET_PREFIX = "./assets/";

export interface ImageStageOptions {
  body: string;
  articleUrl: string;
  /** Absolute path of the article's assets directory. */
  assetsDirAbs: string;
  maxBytes: number;
  timeoutMs: number;
  /** Aggregate guards. maxBytes/timeoutMs bound a single image; these bound
   * the whole stage so one pathological article cannot run out the job. */
  maxCount?: number;
  totalMaxBytes?: number;
  stageTimeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Injectable so tests never touch a resolver. */
  resolveHost?: ResolveHost;
  /** Test escape hatch: fixture servers listen on localhost. */
  allowPrivateHosts?: boolean;
  log?: (message: string) => void;
}

export interface ImageStageResult {
  body: string;
  downloaded: number;
  failed: number;
}

/** Collect the distinct absolute image URLs referenced by the body. */
export function findImageUrls(body: string): string[] {
  const urls = new Set<string>();
  for (const match of body.matchAll(MD_IMAGE_RE)) {
    if (match[1] !== undefined) urls.add(match[1]);
  }
  for (const match of body.matchAll(HTML_IMG_RE)) {
    if (match[1] !== undefined) urls.add(decodeAmpersands(match[1]));
  }
  return [...urls];
}

async function assetFilename(
  url: string,
  contentType: string | null,
): Promise<string | null> {
  const normalizedType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  let ext = EXT_BY_CONTENT_TYPE[normalizedType];
  if (ext === undefined) {
    const pathExt = new URL(url).pathname
      .match(/(\.[a-z0-9]+)$/i)?.[1]
      ?.toLowerCase();
    if (pathExt === ".jpeg") ext = ".jpg";
    else if (pathExt !== undefined && KNOWN_EXTENSIONS.has(pathExt))
      ext = pathExt;
  }
  if (ext === undefined) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 12);
  return `${hash}${ext}`;
}

/**
 * Download every hotlinked image into assets/ and rewrite image references to
 * relative paths. Already-relative and data: URLs are untouched, which makes
 * the stage idempotent. Any per-image failure leaves that URL hotlinked and
 * never fails the article, and so does hitting any of the aggregate caps.
 *
 * Downloads stay sequential on purpose: the stage deadline is what actually
 * protects the job, and a deterministic order keeps the tests readable.
 */
export async function processImages(
  options: ImageStageOptions,
): Promise<ImageStageResult> {
  const {
    articleUrl,
    assetsDirAbs,
    maxBytes,
    timeoutMs,
    maxCount = 100,
    totalMaxBytes = 100 * 1024 * 1024,
    stageTimeoutMs = 300_000,
    fetchImpl = fetch,
    resolveHost = resolveViaDns,
    allowPrivateHosts = false,
    log = () => {},
  } = options;
  const body = options.body;
  const replacements = new Map<string, string>();
  let failed = 0;

  const urls = findImageUrls(body);
  const deadline = Date.now() + stageTimeoutMs;
  let totalBytes = 0;

  for (const [index, url] of urls.entries()) {
    // Aggregate guards. Hitting one abandons the rest of the images, which
    // leaves them hotlinked — the same outcome as any per-image failure, and
    // never a failed article.
    const remainingMs = deadline - Date.now();
    const budget = totalMaxBytes - totalBytes;
    let stop: string | undefined;
    if (index >= maxCount) stop = `image count cap (${maxCount})`;
    else if (remainingMs <= 0) stop = `stage timeout (${stageTimeoutMs}ms)`;
    else if (budget <= 0) stop = `total byte budget (${totalMaxBytes})`;
    if (stop !== undefined) {
      const left = urls.length - index;
      failed += left;
      log(`${left} image(s) kept as hotlinks, hit the ${stop}`);
      break;
    }

    try {
      const res = await fetchChecked(
        url,
        {
          headers: { "User-Agent": USER_AGENT, Referer: articleUrl },
          signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
        },
        fetchImpl,
        allowPrivateHosts,
        resolveHost,
        () => Math.min(timeoutMs, Math.max(0, deadline - Date.now())),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A missing Content-Type used to skip this check and fall through to the
      // path extension, which let an arbitrary endpoint at a .png path through.
      const contentType = res.headers.get("content-type");
      if (contentType === null || !contentType.startsWith("image/")) {
        throw new Error(`not an image: ${contentType ?? "no content type"}`);
      }
      const cap = Math.min(maxBytes, budget);
      const declaredLength = Number(res.headers.get("content-length") ?? "0");
      if (declaredLength > cap)
        throw new Error(`too large: ${declaredLength} bytes`);
      const filename = await assetFilename(url, contentType);
      if (filename === null) throw new Error("no recognizable image extension");
      const bytes = await readBodyCapped(res, cap);
      await Bun.write(`${assetsDirAbs}/${filename}`, bytes);
      totalBytes += bytes.byteLength;
      replacements.set(url, `${ASSET_PREFIX}${filename}`);
    } catch (error) {
      failed += 1;
      log(`image kept as hotlink (${String(error)}): ${url}`);
    }
  }

  // Rewrite only within image syntax, via the same patterns used for
  // discovery. A bare split/join on the URL text would also corrupt longer
  // URLs sharing it as a prefix (x.png inside x.png.html) and rewrite plain
  // links, which should keep pointing at the source.
  // `decode` must match what discovery keyed the map on, or an HTML image
  // whose URL carried `&amp;` downloads and then fails to be rewritten,
  // leaving the body pointing at the network for a file already on disk.
  const rewriteWith =
    (decode: (url: string) => string) =>
    (match: string, url: string): string => {
      const relative = replacements.get(decode(url));
      return relative === undefined ? match : match.replace(url, relative);
    };
  const rewritten = body
    .replace(
      MD_IMAGE_RE,
      rewriteWith((url) => url),
    )
    .replace(HTML_IMG_RE, rewriteWith(decodeAmpersands));

  return { body: rewritten, downloaded: replacements.size, failed };
}

/**
 * Delete files in assets/ that `body` no longer points at, returning how many
 * went. Call this only with a body that has been written to disk.
 *
 * It lives outside `processImages` for that reason. Downloading has to happen
 * before the body that references the new files is rewritten, and the stages
 * between the two can throw — so the stage cannot be atomic. Deletion can be:
 * running it after the article is written means a file is only ever removed
 * against a body that actually exists. A failed run still leaves its
 * speculative downloads unreferenced, but the next successful run reconciles
 * them, so the orphan window is one run rather than forever.
 *
 * The body is the source of truth: filenames are derived from the source URL,
 * so a file the body still names can never be a candidate here.
 *
 * Two things narrow what is even eligible, because this deletes from the
 * user's content repo and should err toward doing too little. A stray
 * subdirectory is left alone rather than removed recursively. And only files
 * shaped like this processor's own output are considered at all: a reference
 * can be spelled in unboundedly many ways — percent escapes, HTML entities,
 * both at once — so rather than trying to recognise every spelling, a file
 * nothing here created is simply never a candidate.
 */
export async function reconcileAssets(
  assetsDirAbs: string,
  body: string,
  log: (message: string) => void = () => {},
): Promise<number> {
  const decodedBody = decodePercentRuns(body);
  let entries: Dirent[];
  try {
    entries = await readdir(assetsDirAbs, { withFileTypes: true });
  } catch {
    return 0; // no assets directory — nothing was ever downloaded
  }
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Not ours, so not ours to remove — see PROCESSOR_ASSET_RE.
    if (!PROCESSOR_ASSET_RE.test(entry.name)) continue;
    if (isReferenced(body, decodedBody, entry.name)) continue;
    await rm(`${assetsDirAbs}/${entry.name}`, { force: true });
    pruned += 1;
    log(`removed orphaned asset: ${entry.name}`);
  }
  return pruned;
}

/**
 * Percent-decode each maximal run of escapes, leaving anything malformed
 * exactly as written.
 *
 * Runs rather than single escapes, so a multi-byte name decodes as one unit
 * (`%E4%B8%AD` -> `中`) instead of three separate failures. Total rather than
 * throwing, because `./assets/100%.png` is a body a vault can genuinely hold —
 * an unguarded decode of one wedged an article a few commits ago.
 */
function decodePercentRuns(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Does `body` point at this file?
 *
 * Asked filename-first on purpose. Scanning the body for references means
 * guessing where each one ends, and every guess is a new way to delete live
 * content — a comma inside an `srcset`, a full stop closing a sentence.
 * Searching for the name itself has no boundary to get wrong.
 *
 * Compared against the decoded body as well as the raw one, because a
 * reference and a filename can be spelled differently and still mean the same
 * file: `%61.png` is a perfectly good way to write `a.png`. Listing the
 * spellings this function happens to think of is what kept losing content —
 * decoding turns an unbounded set into one comparison. The raw body still
 * counts, for a name holding a `%` that no decoding would produce.
 *
 * A name that is a prefix of another (`a.png` beside `a.png.bak`) is kept when
 * only the longer one is referenced: over-keeping costs a stale byte,
 * over-deleting loses content.
 */
function isReferenced(
  body: string,
  decodedBody: string,
  name: string,
): boolean {
  const reference = `${ASSET_PREFIX}${name}`;
  return body.includes(reference) || decodedBody.includes(reference);
}
