import { lookup } from "node:dns/promises";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import type { FetchLike } from "./llm/client.ts";

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

// A browser-ish UA plus the article as Referer defuses most hotlink protection.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
  resolveHost?: (hostname: string) => Promise<string[]>;
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

const PRIVATE_NAME_RE = /^(localhost|.+\.localhost|.+\.local|.+\.internal)$/i;

/** Non-public IPv4 space: the private ranges plus RFC 6890's special-purpose
 * ones. 100.64/10 matters most of the additions — carrier-grade NAT is real
 * infrastructure a resolver can genuinely answer with, not a documentation
 * range. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  return (
    a === 0 || // 0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved, 240/4 included
  );
}

/**
 * Reject obviously non-public hosts so a malicious clipped page cannot point
 * the workflow at loopback/link-local/private services (e.g. cloud metadata).
 * Applied to every redirect hop rather than only the URL the article names —
 * a public host answering 302 to 169.254.169.254 is the cheap version of this
 * attack — and to whatever each hop resolves to, since the name alone proves
 * nothing (`assertPublicAddresses`).
 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_NAME_RE.test(host)) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * Is this address outside publicly routable IPv6?
 *
 * Stated as an allowlist, because the denylist could not be finished. IANA
 * keeps adding special-purpose ranges — 100:0:0:1::/64 is RFC 9780, 2025 —
 * and four consecutive rounds of review each found another one the table had
 * missed. Enumerating a growing set will always lag it.
 *
 * Public IPv6 is allocated solely from 2000::/3, so everything else is
 * unassigned or special-purpose and cannot be an image host. That one test
 * covers ::/96, ::ffff:0:0/96, both NAT64 prefixes, both 100::/64 blocks,
 * fc00::/7, fe80::/10, fec0::/10 and ff00::/8 at once — including ranges not
 * yet written down.
 *
 * Only four carve-outs sit inside 2000::/3, and they are stable. Note that
 * 2001::/23 has to be masked rather than prefix-matched, or it would swallow
 * 2001:4860:4860::8888.
 *
 * A false reject costs one hotlinked image and never fails an article, while a
 * miss is an SSRF vector — so an address this cannot parse is refused too.
 */
function isPrivateIpv6(host: string): boolean {
  const h = expandIpv6(host);
  if (h === null) return true;
  const [h0, h1] = h as [number, number];
  if ((h0 & 0xe000) !== 0x2000) return true; // outside global unicast
  return (
    (h0 === 0x2001 && (h1 & 0xfe00) === 0x0000) || // 2001::/23 IETF protocols
    (h0 === 0x2001 && h1 === 0x0db8) || // 2001:db8::/32 documentation
    h0 === 0x2002 || // 2002::/16 6to4 — embeds IPv4
    (h0 === 0x3fff && (h1 & 0xf000) === 0x0000) // 3fff::/20 documentation
  );
}

/** Eight hextets, or null if this is not an address we can read. Handles `::`
 * compression and a trailing dotted-quad; the hostname arrives normalised from
 * `new URL()`, but the parse stays defensive because the alternative to
 * understanding an address is fetching it. */
function expandIpv6(host: string): number[] | null {
  let text = host;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1] !== undefined) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** Literal addresses were already judged by `isForbiddenHost`; resolving one
 * would just hand the same string back. */
function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Reject if `promise` has not settled within `ms`.
 *
 * `AbortSignal.timeout` reaches `fetch` and nothing else, and resolution
 * happens before the request exists — so without this an unbounded lookup lets
 * a single image outrun the whole stage budget. The losing promise keeps
 * running: `dns.lookup` has no abort, and the OS resolver will settle it in
 * its own time. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      Math.max(0, ms),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function resolveViaDns(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

/**
 * A hostname's *text* can look public while its record points at loopback or
 * the metadata endpoint — `127.0.0.1.nip.io` is the ready-made version, and
 * `169-254-169-254.nip.io` aims at exactly what the name guard exists to
 * protect. Resolve it and apply the same address rules.
 *
 * This closes static mappings, which is the attack that needs no
 * infrastructure. It is not proof against DNS rebinding: `fetch` cannot be
 * pinned to the address checked here, so a name that answers differently on
 * the connection's own lookup still gets through, and nothing downstream
 * prevents that — by the time the content-type and extension gates run, the
 * request has already been sent. What those gates still do is keep the
 * response out of the vault, so a rebind leaks nothing to the public site.
 * The request itself is the residual risk.
 */
async function assertPublicAddresses(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>,
  budgetMs: number,
): Promise<void> {
  if (isIpLiteral(hostname)) return;
  let addresses: string[];
  try {
    addresses = await withTimeout(
      resolveHost(hostname),
      budgetMs,
      `resolving ${hostname}`,
    );
  } catch (error) {
    throw new Error(`cannot resolve ${hostname}: ${String(error)}`);
  }
  for (const address of addresses) {
    if (isForbiddenHost(address)) {
      throw new Error(`${hostname} resolves to a non-public address`);
    }
  }
}

const MAX_REDIRECTS = 5;

/** fetch() follows redirects itself, which would apply the host guard only to
 * the URL the article names. Follow them by hand so every hop is checked. */
async function fetchChecked(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  allowPrivateHosts: boolean,
  resolveHost: (hostname: string) => Promise<string[]>,
  /** Re-read per hop: every lookup draws from the same shrinking budget the
   * request already respects, so six redirects cannot multiply it. */
  budgetMs: () => number,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const hostname = new URL(current).hostname;
    if (!allowPrivateHosts) {
      if (isForbiddenHost(hostname)) throw new Error("non-public host");
      await assertPublicAddresses(hostname, resolveHost, budgetMs());
    }
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (location === null) {
      throw new Error(`redirect ${res.status} without a location header`);
    }
    current = new URL(location, current).toString();
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

/** Read the body incrementally so a server that omits or lies about
 * Content-Length cannot buffer past the cap. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new Error(`too large: ${bytes.byteLength} bytes`);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`too large: exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
