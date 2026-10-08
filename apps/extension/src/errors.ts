import { GitHubHttpError } from "./github.ts";
import type { Messages } from "./i18n.ts";
import { UnreadableCollectionError } from "./remove-article.ts";

/** What a GitHub or network failure means for the user, whichever action ran
 * into it — or null for an error that is neither, which each action phrases
 * for itself. */
function describeGitHubFailure(error: unknown, m: Messages): string | null {
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
  return null;
}

/** Popup-facing failure text: what happened and what to do next, in the
 * popup's language. The raw error keeps its detail for the console; the user
 * gets an instruction, not a stack trace. */
export function describeClipError(error: unknown, m: Messages): string {
  // A clip carrying figure snapshots commits through the Git Data API, which
  // gives up as a 409 of its own when the branch keeps moving — and the
  // one-file PUT ends the same way when its single retry is refused too.
  // Neither is GitHub failing; the next press usually lands.
  if (error instanceof GitHubHttpError && error.status === 409) {
    return m.errClipBusy;
  }
  return describeGitHubFailure(error, m) ?? m.errClipFailed(String(error));
}

/**
 * A failed removal (ADR 0036), phrased the way a failed clip is — a bad token
 * reads the same whichever action ran into it — plus the two ways only a
 * removal fails: a collection naming the article that cannot be parsed, and a
 * branch that kept moving under it (`commitFiles` gives up as a 409 of its
 * own). Neither is a token problem, and both say what to do.
 */
export function describeRemoveError(error: unknown, m: Messages): string {
  if (error instanceof UnreadableCollectionError) {
    return m.errRemoveCollection(error.path);
  }
  if (error instanceof GitHubHttpError && error.status === 409) {
    return m.errRemoveBusy;
  }
  return describeGitHubFailure(error, m) ?? m.errRemoveFailed(String(error));
}

/**
 * A failed collection flush, phrased the way a failed clip is.
 *
 * The worker records the failure as data — it has no locale — and the popup
 * that next opens turns it into a sentence. Rebuilt into the error shapes
 * the clip's description already knows, so a bad token reads the same
 * whichever action ran into it — but not through `describeClipError` itself,
 * whose busy-branch sentence tells the reader to press Clip.
 */
export function describeFlushError(
  status: { error?: string; httpStatus?: number },
  m: Messages,
): string {
  const detail = status.error ?? "";
  const error =
    status.httpStatus !== undefined
      ? new GitHubHttpError(status.httpStatus, detail)
      : detail === "Failed to fetch"
        ? new TypeError(detail)
        : null;
  if (error !== null) {
    return describeGitHubFailure(error, m) ?? m.errClipFailed(String(error));
  }
  // Not the clip fallback, which would say the page could not be *clipped*.
  // What is left is a collection file the vault holds and this cannot parse,
  // or a branch that kept moving — both say what they are.
  return `${detail}.`;
}
