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
 * Download every hotlinked image into assets/ and rewrite body references to
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
    log = () => {},
  } = options;
  let body = options.body;
  let downloaded = 0;
  let failed = 0;

  for (const url of findImageUrls(body)) {
    try {
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
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > maxBytes)
        throw new Error(`too large: ${bytes.byteLength} bytes`);
      await Bun.write(`${assetsDirAbs}/${filename}`, bytes);
      body = body.split(url).join(`./assets/${filename}`);
      downloaded += 1;
    } catch (error) {
      failed += 1;
      log(`image kept as hotlink (${String(error)}): ${url}`);
    }
  }

  return { body, downloaded, failed };
}
