const TRACKING_PARAMS = new Set(["fbclid", "gclid"]);
const SLUG_BASE_MAX = 60;
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
  let base = slugify(`${host}${decodeURIComponent(url.pathname)}`);
  if (base.length > SLUG_BASE_MAX) {
    base = base.slice(0, SLUG_BASE_MAX).replace(/-+$/, "");
  }
  return base === "" ? `article-${hash}` : `${base}-${hash}`;
}
