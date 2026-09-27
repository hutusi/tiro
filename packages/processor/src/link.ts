import {
  type ClipPayload,
  clipArxivPaper,
  clipGitHubDoc,
  clipPage,
  GITHUB_DOC_MAX_BYTES,
} from "@tiro/clip";
import {
  openHtmlDocument,
  plainTextShell,
  withHtmlDocument,
} from "@tiro/clip/happy-dom";
import {
  arxivAbsUrl,
  parseArxivUrl,
  parseGitHubMarkdownUrl,
} from "@tiro/shared";
import type { Deadline } from "./deadline.ts";
import type { FetchLike } from "./llm/client.ts";
import {
  fetchChecked,
  fetchCheckedWithUrl,
  type ResolveHost,
  readBodyCapped,
  resolveViaDns,
  USER_AGENT,
} from "./net-fetch.ts";
import { httpFailure, isSettled, SettledRefusal } from "./refusal.ts";

/**
 * Build the body of a link saved without its page (ADR 0034): fetch the page
 * and run the clipper on it, as the extension would in a tab.
 *
 * What it cannot do is what a tab can: it carries no cookies, so a paywall or
 * a login answers as it would to a stranger, and it runs no script, so a page
 * that builds its text in JavaScript arrives as a shell. The first comes back
 * as the page's own refusal; the second is caught by length — fewer than
 * `minChars` characters is taken to be a shell, the threshold `sweep` uses to
 * flag one. Both are settled: the article is marked, not retried, and a clip
 * from a browser replaces it.
 *
 * Publisher rules first, as in the extension: an arXiv paper is read from its
 * HTML rendering, a markdown file on GitHub from its raw bytes.
 */

/**
 * What a saved link turned out to be, and `readFrom`: the URL its body was
 * actually read from — where a redirect ended, a paper's HTML rendering or
 * its (versioned) abstract, a file's raw bytes. Always the real one, so the
 * article's `source_url` can be set from it outright rather than kept from
 * the stub, which only says where reading was *asked* to start.
 */
export type LinkPage =
  | { kind: "page"; payload: ClipPayload; readFrom: string }
  /** The link is a PDF, which the PDF stage builds a body from. */
  | { kind: "pdf"; readFrom: string };

export interface LinkFetchOptions {
  url: string;
  /** `fetch.max_bytes`, `fetch.timeout_ms`, `fetch.min_chars`. */
  maxBytes: number;
  timeoutMs: number;
  minChars: number;
  /** The run's budget: no request may outlive it (invariant 8). */
  deadline: Deadline;
  fetchImpl?: FetchLike;
  resolveHost?: ResolveHost;
  /** Test escape hatch: fixture servers listen on localhost. */
  allowPrivateHosts?: boolean;
  log?: (message: string) => void;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);

function mediaType(contentType: string | null): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The bytes as text, in the charset the page declared: the header's first,
 * then a `<meta>` near the top, then UTF-8. A Chinese page served as GBK and
 * decoded as UTF-8 is not a thin article, it is a wrong one.
 */
export function decodePage(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(
    contentType ?? "",
  )?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? undefined;
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (label === undefined) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // An unknown label: fall through to the next claim.
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchLinkPage(
  options: LinkFetchOptions,
): Promise<LinkPage> {
  const {
    url,
    maxBytes,
    timeoutMs,
    minChars,
    deadline,
    fetchImpl = fetch,
    resolveHost = resolveViaDns,
    allowPrivateHosts = false,
    log = () => {},
  } = options;
  const what = "fetching a saved link";
  deadline.check(1, what);
  const requestMs = () =>
    Math.max(1, Math.min(timeoutMs, deadline.remainingMs()));

  try {
    const paper = parseArxivUrl(url);
    const doc = paper === null ? parseGitHubMarkdownUrl(url) : null;
    if (paper !== null || doc !== null) {
      return await publisherPage();
    }
    return await plainPage();
  } catch (error) {
    // The request was given what was left of the run, so a run that expired
    // mid-fetch aborts it — and that is a deferral, not a broken link. Asked
    // for a millisecond, since at the boundary "expired" is what is rounded.
    deadline.check(1, what);
    throw error;
  }

  async function plainPage(): Promise<LinkPage> {
    const { response, url: finalUrl } = await fetchCheckedWithUrl(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(requestMs()),
      },
      fetchImpl,
      allowPrivateHosts,
      resolveHost,
      requestMs,
    );
    const contentType = response.headers.get("content-type");
    const media = mediaType(contentType);
    if (!response.ok) {
      await response.body?.cancel();
      // Cloudflare says so when the answer was a challenge page, not the
      // site's: the page is there, but not for a fetch without a browser.
      if (response.headers.get("cf-mitigated") === "challenge") {
        throw new SettledRefusal(
          "a bot check stood in front of the page; clip it in a browser",
        );
      }
      throw httpFailure(response.status);
    }
    if (PDF_TYPES.has(media)) {
      // The PDF stage downloads it again, under its own caps and gates;
      // reading it here too would be a second 25 MB for nothing.
      await response.body?.cancel();
      return { kind: "pdf", readFrom: finalUrl };
    }
    const isHtml = HTML_TYPES.has(media);
    if (!isHtml && !TEXT_TYPES.has(media)) {
      await response.body?.cancel();
      throw new SettledRefusal(
        `not a page: ${contentType ?? "no content type"}`,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new SettledRefusal(`too large: ${declared} bytes`);
    }
    const text = decodePage(
      await readBodyCapped(response, maxBytes),
      contentType,
    );
    const base = finalUrl;
    const payload = await withHtmlDocument(
      isHtml ? text : plainTextShell(text),
      base,
      (page) => clipPage(page, base),
    );
    const chars = payload.markdown.trim().length;
    // A markdown file is what it is, however short; only a rendered page can
    // be a shell of one.
    if (!payload.markdownSource && chars < minChars) {
      throw new SettledRefusal(
        `the page gave ${chars} characters — it probably builds its text with scripts, which a fetch cannot run; clip it in a browser`,
      );
    }
    log(`link: clipped ${chars} characters from ${base}`);
    return {
      kind: "page",
      payload,
      readFrom: finalUrl,
    };
  }

  async function publisherPage(): Promise<LinkPage> {
    const paper = parseArxivUrl(url);
    // The GitHub helper refuses a file past its own cap, as a plain error.
    // Capping the guard at the same size makes the guard refuse it first,
    // and the guard's refusal is settled.
    const cap =
      paper === null ? Math.min(maxBytes, GITHUB_DOC_MAX_BYTES) : maxBytes;
    // The guards of the plain path, for the requests the publisher helpers
    // make themselves: every hop's host checked, the body capped, the time
    // bounded — and how each request ended, kept here, because a helper may
    // swallow it. arXiv's does, on purpose: a failed full-text fetch falls
    // back to the abstract page, and a size refusal then surfaces only as
    // "arXiv did not serve".
    const refusals: unknown[] = [];
    let otherwise = 0;
    const guarded: FetchLike = async (input) => {
      try {
        const res = await fetchChecked(
          String(input),
          {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(requestMs()),
          },
          fetchImpl,
          allowPrivateHosts,
          resolveHost,
          requestMs,
        );
        if (!res.ok) {
          await res.body?.cancel();
          const failure = httpFailure(res.status);
          if (isSettled(failure)) refusals.push(failure);
          else otherwise += 1;
          return new Response(null, { status: res.status });
        }
        const bytes = await readBodyCapped(res, cap);
        otherwise += 1;
        // The body's length is known now; a header claiming otherwise must not
        // reach a helper that would refuse on it with a plain error.
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(bytes, { status: res.status, headers });
      } catch (error) {
        if (isSettled(error)) refusals.push(error);
        else otherwise += 1;
        throw error;
      }
    };
    const closers: (() => Promise<void>)[] = [];
    try {
      if (paper !== null) {
        const clip = await clipArxivPaper(paper, {
          fetch: guarded,
          parse: (html) => {
            const opened = openHtmlDocument(html, url);
            closers.push(opened.close);
            return opened.document;
          },
        });
        return {
          kind: "page",
          payload: clip.payload,
          // No sourceUrl means the canonical abstract page was what was read.
          readFrom: clip.sourceUrl ?? arxivAbsUrl(paper),
        };
      }
      const doc = parseGitHubMarkdownUrl(url);
      if (doc === null) throw new Error(`no publisher rule for ${url}`);
      const clip = await clipGitHubDoc(doc, { fetch: guarded });
      return { kind: "page", payload: clip.payload, readFrom: clip.sourceUrl };
    } catch (error) {
      if (isSettled(error)) throw error;
      // Settled only when every request the helper made was refused for good:
      // one that failed for now, or one that came back, leaves it worth
      // asking again.
      const last = refusals.at(-1);
      if (last !== undefined && otherwise === 0) throw last;
      throw error;
    } finally {
      await Promise.all(closers.map((close) => close()));
    }
  }
}
