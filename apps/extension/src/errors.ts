import { GitHubHttpError } from "./github.ts";
import type { Messages } from "./i18n.ts";

/** Popup-facing failure text: what happened and what to do next, in the
 * popup's language. The raw error keeps its detail for the console; the user
 * gets an instruction, not a stack trace. */
export function describeClipError(error: unknown, m: Messages): string {
  if (error instanceof GitHubHttpError) {
    switch (error.status) {
      case 401:
        return m.errTokenInvalid;
      case 404:
        // GitHub deliberately answers 404 (not 403) for a private repo the
        // token cannot access, so a wrong PAT scope looks identical to a typo.
        return m.errRepoNotFound;
      case 403:
        return m.errForbidden;
      default:
        return m.errHttp(error.status);
    }
  }
  // fetch signals network failure (offline, DNS, blocked) as a TypeError
  // whose message is exactly "Failed to fetch" in Chromium — the only
  // engine this extension runs in. Other TypeErrors are ordinary bugs and
  // must not masquerade as connectivity problems.
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return m.errNetwork;
  }
  return m.errClipFailed(String(error));
}

/**
 * A failed collection flush, phrased the way a failed clip is.
 *
 * The worker records the failure as data — it has no locale — and the popup
 * that next opens turns it into a sentence. Rebuilt into the error shapes
 * `describeClipError` already knows, so a bad token reads the same whichever
 * action ran into it.
 */
export function describeFlushError(
  status: { error?: string; httpStatus?: number },
  m: Messages,
): string {
  const detail = status.error ?? "";
  if (status.httpStatus !== undefined) {
    return describeClipError(new GitHubHttpError(status.httpStatus, detail), m);
  }
  if (detail === "Failed to fetch") {
    return describeClipError(new TypeError(detail), m);
  }
  // Not the clip fallback, which would say the page could not be *clipped*.
  // What is left is a collection file the vault holds and this cannot parse,
  // or a branch that kept moving — both say what they are.
  return `${detail}.`;
}
