import { readFrontmatterLoose } from "@tiro/shared";
import type { TiroExtensionConfig } from "./storage.ts";

const API = "https://api.github.com";

/** A GitHub API failure carrying its HTTP status, so the popup can tell the
 * user what to do (fix the token, check the repo) instead of echoing raw
 * error text. The status stays in the message for logs and tests. */
export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function headers(config: TiroExtensionConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** btoa throws on non-Latin1 input (any Chinese title), so base64 must go
 * through TextEncoder, chunked to stay under argument-count limits. */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Structured so the options page can phrase the outcome in the user's
 * language; prose does not belong in this layer. */
export type ConnectionTestResult =
  | { ok: true; fullName: string }
  | { ok: false; reason: "not_found" | "unauthorized" }
  | { ok: false; reason: "http"; status: number }
  | { ok: false; reason: "network"; detail: string };

export async function testConnection(
  config: TiroExtensionConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ConnectionTestResult> {
  try {
    const res = await fetchImpl(`${API}/repos/${config.owner}/${config.repo}`, {
      headers: headers(config),
    });
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (!res.ok) return { ok: false, reason: "http", status: res.status };
    const repo = (await res.json()) as { full_name?: string };
    return {
      ok: true,
      fullName: repo.full_name ?? `${config.owner}/${config.repo}`,
    };
  } catch (error) {
    return { ok: false, reason: "network", detail: String(error) };
  }
}

export interface ExistingIndex {
  path: string;
  sha: string;
  /** Was the article being overwritten unlisted? A re-clip rebuilds
   * `index.md` from scratch, so a flag nobody carried forward would be
   * dropped and the article would silently rejoin the public library
   * (ADR 0017). False when the content could not be read — see below. */
  unlisted: boolean;
}

/** The inverse of `encodeBase64Utf8`, for content GitHub hands back. */
function decodeBase64Utf8(content: string): string {
  const binary = atob(content.replace(/\s/g, ""));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
}

/**
 * Is the article at this path unlisted?
 *
 * Read as leniently as the file allows, because the cost of a wrong answer is
 * asymmetric: "no" silently republishes an article someone deliberately hid
 * (ADR 0017), while "yes" costs a line in a file that is about to be rewritten
 * anyway. So the frontmatter is parsed without contract validation — an article
 * whose *other* fields are invalid keeps its flag.
 *
 * What it will not do is guess. The Contents API omits `content` above 1MB, so
 * that case re-reads the body as a blob (100MB limit) rather than assuming, and
 * frontmatter it cannot parse stops the clip rather than answering "listed". If
 * either read fails the error propagates, because overwriting an article whose
 * visibility is unknown is the one outcome worth failing for.
 */
async function readUnlisted(
  config: TiroExtensionConfig,
  path: string,
  file: { sha: string; content?: string; encoding?: string },
  fetchImpl: FetchLike,
): Promise<boolean> {
  const inline =
    file.encoding === "base64" && file.content !== undefined
      ? file.content
      : await fetchBlobContent(config, path, file.sha, fetchImpl);
  return readsAsUnlisted(path, decodeBase64Utf8(inline));
}

function readsAsUnlisted(path: string, text: string): boolean {
  const frontmatter = readFrontmatterLoose(text);
  if (frontmatter.kind === "unreadable") {
    // Not "assume listed": a block this cannot parse is exactly where a
    // hand-set flag hides — behind a truncated file, or a typo one line above
    // it. The clip stops instead, which is loud, retryable, and fixable by
    // opening the article in the vault.
    throw new Error(
      `${path}: the article already there has frontmatter this cannot read — refusing to overwrite it`,
    );
  }
  if (frontmatter.kind === "none" || !("unlisted" in frontmatter.data)) {
    return false;
  }
  const value = frontmatter.data.unlisted;
  if (typeof value !== "boolean") {
    // `unlisted: "true"`, or the YAML 1.2 reading of `unlisted: yes` — a
    // string. The contract rejects it, so the site cannot build at all while
    // it is there; what must not happen is this clip quietly *repairing* the
    // article by dropping the key, turning a loud failure the owner would
    // investigate into a silent republish of something they meant to hide.
    throw new Error(
      `${path}: the article already there has an \`unlisted\` value this cannot read (${JSON.stringify(value)}) — refusing to overwrite it`,
    );
  }
  return value;
}

async function fetchBlobContent(
  config: TiroExtensionConfig,
  path: string,
  sha: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(
    `${API}/repos/${config.owner}/${config.repo}/git/blobs/${sha}`,
    { headers: headers(config) },
  );
  if (!res.ok) {
    throw new GitHubHttpError(
      res.status,
      `reading ${path} failed: ${res.status}`,
    );
  }
  const blob = (await res.json()) as { content?: string; encoding?: string };
  if (blob.encoding !== "base64" || blob.content === undefined) {
    throw new Error(`reading ${path} returned no content`);
  }
  return blob.content;
}

/**
 * Look up an existing index.md for this slug. The flat layout makes the path
 * deterministic from the slug, so this is a single GET — it supplies the blob
 * sha a re-clip must send to overwrite instead of create, and the one piece of
 * the old article a re-clip has to keep.
 */
export async function findExistingIndex(
  config: TiroExtensionConfig,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<ExistingIndex | null> {
  const path = `articles/${slug}/index.md`;
  const res = await fetchImpl(
    `${API}/repos/${config.owner}/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch)}`,
    { headers: headers(config) },
  );
  if (res.status === 404) return null; // first clip of this URL
  if (!res.ok) {
    throw new GitHubHttpError(
      res.status,
      `checking ${path} failed: ${res.status}`,
    );
  }
  const file = (await res.json()) as {
    sha: string;
    content?: string;
    encoding?: string;
  };
  return {
    path,
    sha: file.sha,
    unlisted: await readUnlisted(config, path, file, fetchImpl),
  };
}

export interface PutFileOptions {
  path: string;
  contentBase64: string;
  message: string;
  sha?: string;
  /**
   * Build the retry payload after a stale-sha rejection, against the file as it
   * now stands.
   *
   * Without it the retry re-sends the same bytes, which is right for content
   * derived from nothing but this clip, and wrong for anything the intervening
   * commit may have added that the payload cannot regenerate. An article's
   * `unlisted` flag is exactly that: hand-set, unregenerable, and the one field
   * whose loss silently republishes something someone hid (ADR 0017).
   */
  resolveConflict?: () => Promise<{ sha?: string; contentBase64: string }>;
}

/** Create or update one file via the Contents API. A 409/422 (stale sha —
 * e.g. the processor committed meanwhile) re-reads and retries once. */
export async function putFile(
  config: TiroExtensionConfig,
  options: PutFileOptions,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const attempt = async (
    sha: string | undefined,
    contentBase64: string,
  ): Promise<Response> =>
    fetchImpl(
      `${API}/repos/${config.owner}/${config.repo}/contents/${options.path}`,
      {
        method: "PUT",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: options.message,
          content: contentBase64,
          branch: config.branch,
          ...(sha !== undefined ? { sha } : {}),
        }),
      },
    );

  let res = await attempt(options.sha, options.contentBase64);
  if (res.status === 409 || res.status === 422) {
    const next =
      options.resolveConflict === undefined
        ? {
            sha: await freshSha(config, options.path, fetchImpl),
            contentBase64: options.contentBase64,
          }
        : await options.resolveConflict();
    res = await attempt(next.sha, next.contentBase64);
  }
  if (!res.ok) {
    throw new GitHubHttpError(
      res.status,
      `committing ${options.path} failed: ${res.status} ${await res.text()}`,
    );
  }
}

async function freshSha(
  config: TiroExtensionConfig,
  path: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const res = await fetchImpl(
    `${API}/repos/${config.owner}/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch)}`,
    { headers: headers(config) },
  );
  return res.ok && res.status !== 404
    ? ((await res.json()) as { sha?: string }).sha
    : undefined;
}
