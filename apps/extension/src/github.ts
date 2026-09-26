import { readFrontmatterLoose } from "@tiro/shared/documents";
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

/** Fewer days than this before the token expires and Test connection warns
 * rather than just saying when (ADR 0032) — the same window the workflows'
 * weekly check uses for their tokens. */
export const TOKEN_EXPIRY_WARN_DAYS = 30;

/**
 * The expiry GitHub reports for the token, from the
 * `GitHub-Authentication-Token-Expiration` response header — sent for any
 * token that has one, as `2027-09-26 10:00:00 +0800`. Null when the header is
 * absent (a token with no expiry) or in a shape this does not know, which
 * the options page shows as nothing rather than as a wrong date.
 */
export function parseTokenExpiry(header: string | null): Date | null {
  if (header === null) return null;
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:([+-]\d{2})(\d{2})|UTC)$/.exec(
      header.trim(),
    );
  if (match === null) return null;
  const [, day, time, offsetHours, offsetMinutes] = match;
  const zone =
    offsetHours === undefined ? "Z" : `${offsetHours}:${offsetMinutes}`;
  const date = new Date(`${day}T${time}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Days from `now` to `expiresAt` on the reader's own calendar: 0 when the
 * token expires today, 1 when tomorrow, whatever the hours in between.
 *
 * Calendar days rather than elapsed ones, because the number is shown beside
 * a date. Counting 24-hour periods, a token expiring at 01:00 tomorrow read as
 * "expires today" at 23:00 — next to tomorrow's date. Rounded, not floored,
 * so a day that daylight saving made 23 or 25 hours long still counts as one.
 */
export function daysUntil(expiresAt: Date, now: Date): number {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(expiresAt) - startOfDay(now)) / 86_400_000);
}

/** Structured so the options page can phrase the outcome in the user's
 * language; prose does not belong in this layer. */
export type ConnectionTestResult =
  | { ok: true; fullName: string; expiresAt?: Date }
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
    const expiresAt = parseTokenExpiry(
      res.headers.get("github-authentication-token-expiration"),
    );
    return {
      ok: true,
      fullName: repo.full_name ?? `${config.owner}/${config.repo}`,
      ...(expiresAt !== null ? { expiresAt } : {}),
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
  /**
   * The body of the article being overwritten.
   *
   * Only a PDF re-clip reads it, and for that one it is load-bearing: a PDF is
   * clipped as a stub with no body, so writing the stub over a converted
   * article would replace real Markdown with nothing and bet that the next
   * processing run rebuilds it. If the fetch then fails — or the source has
   * 404'd since — the article is simply gone from the vault's current state.
   * Carrying it forward means a failed reconversion costs freshness rather
   * than content (ADR 0026).
   *
   * Empty when the article could not be read, which is the same conservative
   * answer `unlisted` gives there.
   */
  body: string;
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
  // Decoded once and read twice: both answers come from the same bytes, and
  // fetching them again for the second would double a request on every clip.
  const text = decodeBase64Utf8(
    file.encoding === "base64" && file.content !== undefined
      ? file.content
      : await fetchBlobContent(config, path, file.sha, fetchImpl),
  );
  return {
    path,
    sha: file.sha,
    unlisted: readsAsUnlisted(path, text),
    body: bodyOf(text),
  };
}

/** The article's body — whatever follows the frontmatter fence.
 *
 * Deliberately not `parseArticle`: that validates against the schema and
 * throws, and this is called on an article that may predate any part of the
 * current contract. A body that cannot be located reads as empty, which is the
 * same answer as "there was no body", and both are safe here — the caller only
 * ever uses it to avoid replacing something with nothing. */
function bodyOf(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match === null
    ? text
    : text.slice(match[0].length).replace(/^\n+/, "");
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

/* ------------------------------------------------ multi-file commits (ADR 0029) */

/** A branch as it appears in a ref path. Its slashes are structure — a branch
 * `feature/x` is `heads/feature/x` — so each segment is encoded, not the whole. */
function refPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function contentsUrl(
  config: TiroExtensionConfig,
  path: string,
  ref: string,
): string {
  return `${API}/repos/${config.owner}/${config.repo}/contents/${refPath(path)}?ref=${encodeURIComponent(ref)}`;
}

async function expectOk(res: Response, doing: string): Promise<Response> {
  if (!res.ok) {
    throw new GitHubHttpError(
      res.status,
      `${doing} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res;
}

/** The branch's head commit and that commit's tree. */
async function branchHead(
  config: TiroExtensionConfig,
  fetchImpl: FetchLike,
): Promise<{ commit: string; tree: string }> {
  const repo = `${API}/repos/${config.owner}/${config.repo}`;
  const ref = await expectOk(
    await fetchImpl(`${repo}/git/ref/heads/${refPath(config.branch)}`, {
      headers: headers(config),
    }),
    `reading branch ${config.branch}`,
  );
  const commit = ((await ref.json()) as { object: { sha: string } }).object.sha;
  const detail = await expectOk(
    await fetchImpl(`${repo}/git/commits/${commit}`, {
      headers: headers(config),
    }),
    `reading commit ${commit}`,
  );
  const tree = ((await detail.json()) as { tree: { sha: string } }).tree.sha;
  return { commit, tree };
}

/**
 * A text file as it stands in one commit, or null when it does not exist.
 *
 * Pinned to a commit rather than the branch, so every read one build makes
 * sees the same snapshot. Correctness does not rest on it — `commitFiles`
 * never forces the ref, so a build computed from any state other than its
 * parent's is refused at the ref update and redone — but reading the branch
 * would let one build mix two states and then spend an attempt finding out.
 * (A mutation test confirms it: reading the branch instead fails nothing.)
 */
async function readTextAt(
  config: TiroExtensionConfig,
  path: string,
  commit: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const res = await fetchImpl(contentsUrl(config, path, commit), {
    headers: headers(config),
  });
  if (res.status === 404) return null;
  await expectOk(res, `reading ${path}`);
  const file = (await res.json()) as
    | { sha: string; content?: string; encoding?: string }
    | unknown[];
  if (Array.isArray(file)) {
    throw new Error(`${path} is a directory, not a file`);
  }
  return decodeBase64Utf8(
    file.encoding === "base64" && file.content !== undefined
      ? file.content
      : await fetchBlobContent(config, path, file.sha, fetchImpl),
  );
}

/**
 * Whether the vault already has an article at `slug`, on the configured
 * branch: its `index.md`, not just a directory — an orphan `zh.md` is not an
 * article. One listing request, however large the article (see `listAt`).
 */
export async function articleExists(
  config: TiroExtensionConfig,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const names = await listAt(
    config,
    `articles/${slug}`,
    config.branch,
    fetchImpl,
  );
  return names?.includes("index.md") ?? false;
}

/** Whether anything — file or directory — exists at `path` in one commit. A
 * directory listing is cheap whatever the files inside it weigh, which is why
 * an article is checked for by its directory rather than its `index.md`. */
async function existsAt(
  config: TiroExtensionConfig,
  path: string,
  commit: string,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const res = await fetchImpl(contentsUrl(config, path, commit), {
    headers: headers(config),
  });
  if (res.status === 404) return false;
  await expectOk(res, `checking ${path}`);
  return true;
}

/** The names directly inside a directory in one commit, or null when there is
 * no directory there. One listing request whatever the files weigh — which is
 * why a file is looked for in its directory's listing rather than fetched,
 * since fetching an article's `index.md` would pull up to 1 MB to learn that it
 * exists. */
async function listAt(
  config: TiroExtensionConfig,
  path: string,
  commit: string,
  fetchImpl: FetchLike,
): Promise<string[] | null> {
  const res = await fetchImpl(contentsUrl(config, path, commit), {
    headers: headers(config),
  });
  if (res.status === 404) return null;
  await expectOk(res, `listing ${path}`);
  const body = (await res.json()) as unknown;
  // A file where a directory was expected is not a directory.
  if (!Array.isArray(body)) return null;
  return body
    .map((entry) => (entry as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string");
}

/** What `commitFiles` hands its builder: reads, all pinned to one commit. */
export interface TreeReader {
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[] | null>;
}

export interface BuiltCommit {
  /** Describes these files, so it is recomputed with them on every attempt. */
  message: string;
  files: readonly { path: string; content: string }[];
}

export interface CommitFilesOptions {
  /**
   * Produce the commit — its files and the message describing them — against
   * the tree it will be parented on. Returns null, or no files, when there is
   * nothing to write, and then no commit is made at all: an empty one would
   * still cost a push, a workflow run and a build.
   *
   * Called again on every attempt, against the new head. That is the point of
   * taking a builder rather than a list: after another commit lands, the files
   * have to be recomputed from what it left, not re-sent as they were — and
   * the message with them, or it describes an attempt that was never made.
   */
  build(reader: TreeReader): Promise<BuiltCommit | null>;
  /** How many heads to try before giving up. Defaults to three. */
  attempts?: number;
}

/**
 * Write several files as one commit, through the Git Data API.
 *
 * The Contents API commits one file per request, so a flush touching two
 * collections would be two commits, two pushes, two workflow runs and two
 * builds. This makes it one (ADR 0029): read the head, build against it,
 * create a tree carrying the files inline (which creates their blobs too, so
 * there is no base64 and no blob round trip), commit that tree on the head,
 * and move the branch to it.
 *
 * The ref update is never forced. If anything else committed in between —
 * the vault's processing workflow commits back on its own schedule — GitHub
 * refuses it as not a fast-forward, and the whole cycle runs again from the
 * new head, rebuilding the files from what that commit left. Three attempts,
 * where `putFile` allows one retry: a processing run can commit more than once
 * in a burst, and a rebuild here costs a few small reads, not a re-clip.
 */
export async function commitFiles(
  config: TiroExtensionConfig,
  options: CommitFilesOptions,
  fetchImpl: FetchLike = fetch,
): Promise<{ committed: string | null }> {
  const repo = `${API}/repos/${config.owner}/${config.repo}`;
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const head = await branchHead(config, fetchImpl);
    const built = await options.build({
      read: (path) => readTextAt(config, path, head.commit, fetchImpl),
      exists: (path) => existsAt(config, path, head.commit, fetchImpl),
      list: (path) => listAt(config, path, head.commit, fetchImpl),
    });
    if (built === null || built.files.length === 0) return { committed: null };
    const { files, message } = built;

    const tree = await expectOk(
      await fetchImpl(`${repo}/git/trees`, {
        method: "POST",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify({
          base_tree: head.tree,
          tree: files.map(({ path, content }) => ({
            path,
            mode: "100644",
            type: "blob",
            content,
          })),
        }),
      }),
      "creating the tree",
    );
    const treeSha = ((await tree.json()) as { sha: string }).sha;

    const commit = await expectOk(
      await fetchImpl(`${repo}/git/commits`, {
        method: "POST",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: [head.commit],
        }),
      }),
      "creating the commit",
    );
    const commitSha = ((await commit.json()) as { sha: string }).sha;

    const moved = await fetchImpl(
      `${repo}/git/refs/heads/${refPath(config.branch)}`,
      {
        method: "PATCH",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify({ sha: commitSha, force: false }),
      },
    );
    if (moved.ok) return { committed: commitSha };
    // Not a fast-forward: the branch moved after we read it. The commit made
    // above is left dangling, which GitHub collects; nothing points at it.
    if (moved.status === 422 || moved.status === 409) continue;
    await expectOk(moved, `updating ${config.branch}`);
  }
  throw new GitHubHttpError(
    409,
    `${config.branch} kept moving — gave up after ${attempts} attempts`,
  );
}
