import {
  githubRawUrl,
  parseArxivUrl,
  parseGitHubMarkdownUrl,
} from "@tiro/shared";
import { ARXIV_ORIGIN, clipArxivPaper } from "./arxiv.ts";
import { clipGitHubDoc, RAW_ORIGIN } from "./github-doc.ts";
import type { FetchSourceKind, Messages } from "./i18n.ts";
import type { ClipPayload } from "./messages.ts";

/**
 * A document this tab's URL addresses that Tiro would rather read from its
 * publisher than from the page in front of it.
 *
 * Both rules exist for one reason (ADR 0013, clause 5): collapsing several URLs
 * onto one identity means a clip *replaces* an article rather than adding one,
 * so the lesser body — an abstract page, GitHub's rendering of a file — must
 * never be the one committed. Everything that differs between the publishers is
 * behind this object, so the popup's flow is written once.
 *
 * Its own module rather than a corner of popup.ts because nothing can import
 * popup.ts — it pulls in CSS and reaches for `document` at module scope — and
 * this is where the policy that decides what may be committed now lives. The
 * same reason `tabSourceUrl` moved to `clip.ts`.
 */
interface FetchableSourceBase {
  kind: FetchSourceKind;
  /** The optional host permission to ask for. */
  origin: string;
  /** Fetch and clip. Throws on failure; the caller decides what that means. */
  clip: () => Promise<{ payload: ClipPayload; sourceUrl?: string }>;
}

/**
 * A union rather than a flag, so a publisher cannot refuse without saying what
 * to do instead. Refusing to clip is only honest beside a way through, and a
 * rule added without one does not compile.
 */
export type FetchableSource = FetchableSourceBase &
  (
    | {
        /** The tab's own body is a fair article under this slug. An arXiv
         * abstract page is the paper's canonical URL: a fetch that cannot
         * happen costs a fuller body, not the article. */
        degradesToTab: true;
      }
    | {
        /** The tab's own body is a rendering of the document, filed under the
         * document's slug — committing it replaces the real clip rather than
         * adding one. */
        degradesToTab: false;
        /** What to do instead, already localized. */
        instead: string;
      }
  );

export function fetchableSource(
  tabUrl: string,
  m: Messages,
): FetchableSource | null {
  const paper = parseArxivUrl(tabUrl);
  if (paper !== null) {
    return {
      kind: "arxiv",
      origin: ARXIV_ORIGIN,
      degradesToTab: true,
      clip: () =>
        clipArxivPaper(paper, {
          fetch: (input, init) => fetch(input, init),
          parse: (html) => new DOMParser().parseFromString(html, "text/html"),
        }),
    };
  }
  const doc = parseGitHubMarkdownUrl(tabUrl);
  if (doc === null) return null;
  const rawUrl = githubRawUrl(doc);
  // Already on the bytes. The tab holds the file, `activeTab` covers reading
  // it, and asking for a host permission to fetch what is on screen would be
  // absurd — so a raw URL takes the ordinary path and `clipPage` does the rest.
  if (new URL(tabUrl).origin === new URL(rawUrl).origin) return null;
  return {
    kind: "github",
    origin: RAW_ORIGIN,
    degradesToTab: false,
    // Names the URL rather than the Raw button: it is exact, it is copyable,
    // and clipping it needs no permission at all.
    instead: m.fetchSources.github.instead(rawUrl),
    clip: () =>
      clipGitHubDoc(doc, { fetch: (input, init) => fetch(input, init) }),
  };
}
