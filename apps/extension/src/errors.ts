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
