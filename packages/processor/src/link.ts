import {
  type ClipPayload,
  clipArxivPaper,
  clipGitHubDoc,
  clipPage,
} from "@tiro/clip";
import {
  openHtmlDocument,
  plainTextShell,
  withHtmlDocument,
} from "@tiro/clip/happy-dom";
import { parseArxivUrl, parseGitHubMarkdownUrl } from "@tiro/shared";
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

export type LinkPage =
  /** The page, clipped. `sourceUrl` when it was read somewhere other than the
   * saved URL — a redirect, a paper's HTML rendering, a file's raw bytes. */
  | { kind: "page"; payload: ClipPayload; sourceUrl?: string }
  /** The link is a PDF, which the PDF stage builds a body from. */
  | { kind: "pdf"; sourceUrl?: string };

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
    const sourceUrl = finalUrl !== url ? finalUrl : undefined;
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
      return { kind: "pdf", ...(sourceUrl !== undefined ? { sourceUrl } : {}) };
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
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  }

  async function publisherPage(): Promise<LinkPage> {
    // The guards of the plain path, for the requests the publisher helpers
    // make themselves: every hop's host checked, the body capped, the time
    // bounded. Statuses are kept, so a paper or file that is gone reads as
    // settled rather than as a network fault.
    const statuses: number[] = [];
    const guarded: FetchLike = async (input) => {
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
      statuses.push(res.status);
      if (!res.ok) {
        await res.body?.cancel();
        return new Response(null, { status: res.status });
      }
      const bytes = await readBodyCapped(res, maxBytes);
      return new Response(bytes, { status: res.status, headers: res.headers });
    };
    const closers: (() => Promise<void>)[] = [];
    try {
      const paper = parseArxivUrl(url);
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
          ...(clip.sourceUrl !== undefined
            ? { sourceUrl: clip.sourceUrl }
            : {}),
        };
      }
      const doc = parseGitHubMarkdownUrl(url);
      if (doc === null) throw new Error(`no publisher rule for ${url}`);
      const clip = await clipGitHubDoc(doc, { fetch: guarded });
      return { kind: "page", payload: clip.payload, sourceUrl: clip.sourceUrl };
    } catch (error) {
      const last = statuses.at(-1);
      if (!isSettled(error) && last !== undefined && last >= 400) {
        const failure = httpFailure(last);
        if (failure instanceof SettledRefusal) throw failure;
      }
      throw error;
    } finally {
      await Promise.all(closers.map((close) => close()));
    }
  }
}
