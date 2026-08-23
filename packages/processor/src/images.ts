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

// A browser-ish UA plus the article as Referer defuses most hotlink protection.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MD_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMG_RE = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/g;

export interface ImageStageOptions {
  body: string;
  articleUrl: string;
  /** Absolute path of the article's assets directory. */
  assetsDirAbs: string;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: FetchLike;
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
    if (match[1] !== undefined) urls.add(match[1]);
  }
  return [...urls];
}

const PRIVATE_NAME_RE = /^(localhost|.+\.localhost|.+\.local|.+\.internal)$/i;

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local incl. cloud metadata endpoints
    a >= 224 // multicast/reserved — never a public image host
  );
}

/**
 * Reject obviously non-public hosts so a malicious clipped page cannot point
 * the workflow at loopback/link-local/private services (e.g. cloud metadata).
 * Deliberately name-based — no DNS resolution or per-redirect-hop checks —
 * which blocks the practical vectors at proportionate cost; responses are
 * additionally gated on an image content type and a recognized extension.
 */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_NAME_RE.test(host)) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) {
    // IPv6: loopback/unspecified, unique-local fc00::/7, link-local fe80::/10,
    // and v4-mapped literals (never a legitimate public image URL).
    return (
      host === "::1" ||
      host === "::" ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("::ffff:")
    );
  }
  return false;
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
 * never fails the article.
 */
export async function processImages(
  options: ImageStageOptions,
): Promise<ImageStageResult> {
  const {
    articleUrl,
    assetsDirAbs,
    maxBytes,
    timeoutMs,
    fetchImpl = fetch,
    allowPrivateHosts = false,
    log = () => {},
  } = options;
  const body = options.body;
  const replacements = new Map<string, string>();
  let failed = 0;

  for (const url of findImageUrls(body)) {
    try {
      if (!allowPrivateHosts && isForbiddenHost(new URL(url).hostname)) {
        throw new Error("non-public host");
      }
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT, Referer: articleUrl },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type");
      if (contentType !== null && !contentType.startsWith("image/")) {
        throw new Error(`not an image: ${contentType}`);
      }
      const declaredLength = Number(res.headers.get("content-length") ?? "0");
      if (declaredLength > maxBytes)
        throw new Error(`too large: ${declaredLength} bytes`);
      const filename = await assetFilename(url, contentType);
      if (filename === null) throw new Error("no recognizable image extension");
      const bytes = await readBodyCapped(res, maxBytes);
      await Bun.write(`${assetsDirAbs}/${filename}`, bytes);
      replacements.set(url, `./assets/${filename}`);
    } catch (error) {
      failed += 1;
      log(`image kept as hotlink (${String(error)}): ${url}`);
    }
  }

  // Rewrite only within image syntax, via the same patterns used for
  // discovery. A bare split/join on the URL text would also corrupt longer
  // URLs sharing it as a prefix (x.png inside x.png.html) and rewrite plain
  // links, which should keep pointing at the source.
  const rewriteMatch = (match: string, url: string): string => {
    const relative = replacements.get(url);
    return relative === undefined ? match : match.replace(url, relative);
  };
  const rewritten = body
    .replace(MD_IMAGE_RE, rewriteMatch)
    .replace(HTML_IMG_RE, rewriteMatch);

  return { body: rewritten, downloaded: replacements.size, failed };
}
