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

export async function testConnection(
  config: TiroExtensionConfig,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchImpl(`${API}/repos/${config.owner}/${config.repo}`, {
      headers: headers(config),
    });
    if (res.status === 404)
      return {
        ok: false,
        message: "Repository not found (check name and token scope)",
      };
    if (res.status === 401)
      return { ok: false, message: "Token rejected (401)" };
    if (!res.ok) return { ok: false, message: `GitHub returned ${res.status}` };
    const repo = (await res.json()) as { full_name?: string };
    return {
      ok: true,
      message: `Connected to ${repo.full_name ?? "repository"}`,
    };
  } catch (error) {
    return { ok: false, message: `Network error: ${String(error)}` };
  }
}

export interface ExistingIndex {
  path: string;
  sha: string;
}

/**
 * Look up an existing index.md for this slug. The flat layout makes the path
 * deterministic from the slug, so this is a single GET — its only job is
 * fetching the blob sha a re-clip must send to overwrite instead of create.
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
  const file = (await res.json()) as { sha: string };
  return { path, sha: file.sha };
}

export interface PutFileOptions {
  path: string;
  contentBase64: string;
  message: string;
  sha?: string;
}

/** Create or update one file via the Contents API. A 409/422 (stale sha —
 * e.g. the processor committed meanwhile) re-reads the sha and retries once. */
export async function putFile(
  config: TiroExtensionConfig,
  options: PutFileOptions,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const attempt = async (sha: string | undefined): Promise<Response> =>
    fetchImpl(
      `${API}/repos/${config.owner}/${config.repo}/contents/${options.path}`,
      {
        method: "PUT",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: options.message,
          content: options.contentBase64,
          branch: config.branch,
          ...(sha !== undefined ? { sha } : {}),
        }),
      },
    );

  let res = await attempt(options.sha);
  if (res.status === 409 || res.status === 422) {
    const fresh = await fetchImpl(
      `${API}/repos/${config.owner}/${config.repo}/contents/${options.path}?ref=${encodeURIComponent(config.branch)}`,
      { headers: headers(config) },
    );
    const sha =
      fresh.ok && fresh.status !== 404
        ? ((await fresh.json()) as { sha?: string }).sha
        : undefined;
    res = await attempt(sha);
  }
  if (!res.ok) {
    throw new GitHubHttpError(
      res.status,
      `committing ${options.path} failed: ${res.status} ${await res.text()}`,
    );
  }
}
