import { type GitHubDocRef, githubBlobUrl, githubRawUrl } from "@tiro/shared";
import { clipMarkdownFile } from "./clip-page.ts";
import type { FetchLike } from "./github.ts";
import type { ClipPayload } from "./messages.ts";

/**
 * Clipping a GitHub markdown file from whichever of its URLs the reader is on.
 *
 * The identity rule in `@tiro/shared` makes the raw bytes and the blob page one
 * article, which on its own would be a trap — the same one ADR 0013's fifth
 * clause describes for arXiv. A blob page's body is GitHub's rendering of the
 * file run back through Turndown, and its "Code" tab is worse still: the source
 * lives in a virtualized container holding only the lines scrolled into view.
 * Clipping either would *overwrite* a clip of the file itself. Collapsing the
 * identity and always reading the bytes are the same change, not two.
 *
 * The fetch happens here rather than in the injected clipper because the file
 * is not in the tab at all. That costs a host permission, which is why it is
 * optional and requested from the Clip flow's own user gesture rather than held
 * at install time.
 *
 * Nothing here is needed when the reader is already on the raw URL: the tab
 * holds the bytes, `activeTab` covers reading them, and `clipPage` takes the
 * markdown branch on its own.
 */

/** The origin pattern the popup asks for, matching `optional_host_permissions`
 * in the manifest. Exported so the two cannot drift. */
export const RAW_ORIGIN = "https://raw.githubusercontent.com/*";

/**
 * A file this large is not an article, and treating it as one costs more than
 * the clip is worth: the Contents API carries it base64-encoded in a JSON body,
 * the vault keeps it forever, and the processor would translate it block by
 * block. Generated API references run to tens of megabytes.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Would clipping this payload file a rendering under the file's slug?
 *
 * The publisher-specific half of `needsFetch` in `clip-candidate.ts`: which
 * field of a payload means "this is the file". Kept here, and pure, because the
 * popup that acts on it has no test harness.
 */
export function needsRawFetch(
  payload: Pick<ClipPayload, "markdownSource">,
  isGitHubDoc: boolean,
): boolean {
  return isGitHubDoc && !payload.markdownSource;
}

export interface GitHubClip {
  payload: ClipPayload;
  /**
   * The URL the body was read from — `tiro.source_url`. Always present, unlike
   * arXiv's: the article is filed under the blob page, and the blob page is
   * never where the bytes are.
   */
  sourceUrl: string;
}

export interface GitHubFetchDeps {
  fetch: FetchLike;
}

/**
 * Fetch a markdown file's bytes and clip them.
 *
 * Throws on any failure; the caller then has the tab's own clip to fall back
 * on, and says so rather than silently committing the rendering.
 */
export async function clipGitHubDoc(
  doc: GitHubDocRef,
  deps: GitHubFetchDeps,
): Promise<GitHubClip> {
  const rawUrl = githubRawUrl(doc);
  const response = await deps.fetch(rawUrl);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${rawUrl}`);
  }
  // Asked before reading the body where the server says, so an enormous file
  // is refused rather than downloaded to be refused.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    throw new Error(`${rawUrl} is too large to clip`);
  }
  const text = await response.text();
  // Characters rather than bytes, which under-counts multi-byte text — this is
  // a guard against the absurd, not an accounting of it, and the header above
  // is the exact answer whenever there is one.
  if (text.length > MAX_FILE_BYTES) {
    throw new Error(`${rawUrl} is too large to clip`);
  }
  return {
    // Filed under the page, read from the bytes: a repo-relative image
    // resolved against the blob page would point at another HTML page.
    payload: clipMarkdownFile(text, githubBlobUrl(doc), rawUrl),
    sourceUrl: rawUrl,
  };
}
