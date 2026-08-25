/** Referral/tracking params stripped for identity. Blocklist, not allowlist,
 * on purpose: a missed tracker only yields a visible duplicate article, while
 * a stripped content-identifying param (?v=, ?id=, ?p=) would silently merge
 * distinct pages into one slug — data loss. Keep this list conservative. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "ref",
  "source",
  "from",
  "si",
  "spm",
  "scm",
  "igshid",
  "mc_cid",
  "mc_eid",
  "wfr",
  "isappinstalled",
]);
const SLUG_BASE_MAX = 60;
/** Byte budget for a tag slug's readable part, before any hash suffix. */
const TAG_SLUG_MAX_BYTES = 60;
const HASH_SUFFIX_LEN = 8;

/**
 * Canonical form of a URL for identity purposes: no fragment, no tracking
 * params, lowercase host, no trailing slash. Two clips of "the same page"
 * must normalize identically — this string is what gets hashed.
 */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  const toDelete: string[] = [];
  url.searchParams.forEach((_value, key) => {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) toDelete.push(key);
  });
  for (const key of toDelete) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** decodeURIComponent throws URIError on malformed escapes (a URL can carry
 * a literal stray "%"); such URLs must still get a slug, so fall back to the
 * encoded pathname — slugify flattens the difference anyway. */
function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Deterministic slug for a URL: slugified host+path (www stripped, ASCII
 * only, truncated) plus an 8-hex SHA-256 suffix of the normalized URL.
 * Deterministic ⇒ re-clipping overwrites the same article; the hash suffix
 * ⇒ no collisions between truncated paths; non-ASCII paths degrade to a
 * hash-dominant slug. Async because it uses WebCrypto, which is what lets
 * the same code run in the extension and in Bun.
 */
export async function slugForUrl(rawUrl: string): Promise<string> {
  const normalized = normalizeUrl(rawUrl);
  const hash = (await sha256Hex(normalized)).slice(0, HASH_SUFFIX_LEN);
  const url = new URL(normalized);
  const host = url.hostname.replace(/^www\./, "");
  let base = slugify(`${host}${safeDecodePathname(url.pathname)}`);
  if (base.length > SLUG_BASE_MAX) {
    base = base.slice(0, SLUG_BASE_MAX).replace(/-+$/, "");
  }
  return base === "" ? `article-${hash}` : `${base}-${hash}`;
}

/** FNV-1a. Sync, unlike the SHA-256 used for article slugs, because the site
 * calls this once per tag per page render. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Route-safe form of a free-form tag or category.
 *
 * Tags are unconstrained LLM output and go straight into a URL path segment,
 * so `ci/cd` would otherwise emit a page at a path the route pattern cannot
 * match, and `..` would climb out of the output directory. Unlike
 * `slugForUrl` this keeps non-ASCII: the summary is written in the target
 * language, so ASCII-folding would collapse every Chinese tag to the empty
 * string and pile them all onto one route.
 *
 * Distinct tags can share a slug (`AI/ML` and `ai-ml`), so callers must group
 * by the result rather than assume it is unique. That also merges terms that
 * are not really the same — `C#` and `C` both reduce to `c` — which is a
 * deliberate trade: grouping still lists every article and shows a real label,
 * and hashing every lossy slug to avoid it would make each one an unreadable
 * URL.
 *
 * The result is capped in *bytes*, because a path component must fit NAME_MAX
 * (255) and a 100-character Chinese tag is already 300 bytes — which this has
 * to expect, since summaries are written in the target language.
 */
export function tagSlug(tag: string): string {
  const cleaned = tag
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[/\\?#%\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (cleaned === "") return `tag-${shortHash(tag)}`;
  const truncated = truncateUtf8(cleaned, TAG_SLUG_MAX_BYTES);
  if (truncated === cleaned) return cleaned;
  // Same shape as slugForUrl: a readable base plus a hash of the whole input,
  // so two long tags sharing a prefix do not collapse into one route.
  return `${truncated.replace(/-+$/, "")}-${shortHash(tag)}`;
}

/** Cut to at most `maxBytes` of UTF-8 without splitting a character. Iterating
 * a string yields whole code points, so surrogate pairs survive. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}
