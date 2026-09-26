import { describe, expect, test } from "bun:test";
import {
  createDeadline,
  DeadlineExceededError,
  unboundedDeadline,
} from "../src/deadline.ts";
import { decodePage, fetchLinkPage } from "../src/link.ts";
import type { FetchLike } from "../src/llm/client.ts";
import { isSettled } from "../src/refusal.ts";

const ARTICLE = `<html><head><title>A Page Worth Keeping</title>
  <meta name="author" content="A. Writer"></head><body><article>
  <h1>A Page Worth Keeping</h1>
  ${"<p>A paragraph of real prose, long enough that nobody could mistake it for a script-built shell, with <a href='/next'>a relative link</a>.</p>".repeat(6)}
  </article></body></html>`;

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });

/** Answers each URL from a table; anything else is a 404. */
function site(pages: Record<string, () => Response>): FetchLike {
  return async (input) =>
    pages[String(input)]?.() ?? new Response("", { status: 404 });
}

const base = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  minChars: 500,
  deadline: unboundedDeadline(),
  resolveHost: async () => ["93.184.216.34"],
};

describe("fetchLinkPage", () => {
  test("clips the page it finds at the link", async () => {
    const page = await fetchLinkPage({
      ...base,
      url: "https://example.net/post",
      fetchImpl: site({ "https://example.net/post": () => html(ARTICLE) }),
    });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.payload.title).toBe("A Page Worth Keeping");
    expect(page.payload.markdown).toContain("https://example.net/next");
    expect(page.sourceUrl).toBeUndefined();
  });

  test("follows a redirect, and reads relative links from where it landed", async () => {
    const page = await fetchLinkPage({
      ...base,
      url: "https://short.example/x",
      fetchImpl: site({
        "https://short.example/x": () =>
          new Response(null, {
            status: 301,
            headers: { location: "https://example.net/2026/post" },
          }),
        "https://example.net/2026/post": () => html(ARTICLE),
      }),
    });
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.sourceUrl).toBe("https://example.net/2026/post");
    expect(page.payload.markdown).toContain("https://example.net/next");
  });

  test("refuses, for good, a redirect into a private network", async () => {
    const error = await fetchLinkPage({
      ...base,
      url: "https://example.net/post",
      resolveHost: async (host) =>
        host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"],
      fetchImpl: site({
        "https://example.net/post": () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://internal.example/admin" },
          }),
      }),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
    expect(String(error)).toContain("non-public address");
  });

  test("a 404 is settled, a 503 is worth another try", async () => {
    const gone = await fetchLinkPage({
      ...base,
      url: "https://example.net/gone",
      fetchImpl: site({}),
    }).catch((e) => e);
    expect(isSettled(gone)).toBe(true);
    expect(String(gone)).toContain("HTTP 404");

    const busy = await fetchLinkPage({
      ...base,
      url: "https://example.net/busy",
      fetchImpl: async () => new Response("", { status: 503 }),
    }).catch((e) => e);
    expect(busy).toBeInstanceOf(Error);
    expect(isSettled(busy)).toBe(false);
  });

  test("names a bot check for what it is", async () => {
    const error = await fetchLinkPage({
      ...base,
      url: "https://example.net/post",
      fetchImpl: async () =>
        new Response("<html>Just a moment…</html>", {
          status: 403,
          headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
        }),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
    expect(String(error)).toContain("bot check");
  });

  test("hands a PDF to the PDF stage, and abandons this download", async () => {
    // The PDF stage fetches it again under its own caps and gates; reading it
    // here as well would be a second 25 MB for nothing.
    let cancelled = false;
    const page = await fetchLinkPage({
      ...base,
      url: "https://example.net/paper",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/pdf" } },
        ),
    });
    expect(page).toEqual({ kind: "pdf" });
    expect(cancelled).toBe(true);
  });

  test("refuses, for good, something that is not a document", async () => {
    const error = await fetchLinkPage({
      ...base,
      url: "https://example.net/cat.png",
      fetchImpl: async () =>
        new Response("png", { headers: { "content-type": "image/png" } }),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
    expect(String(error)).toContain("not a page: image/png");
  });

  test("refuses, for good, a page past the size cap", async () => {
    const error = await fetchLinkPage({
      ...base,
      maxBytes: 100,
      url: "https://example.net/huge",
      fetchImpl: async () => html(ARTICLE),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
    expect(String(error)).toContain("too large");
  });

  test("takes a short page for a script-built shell", async () => {
    const error = await fetchLinkPage({
      ...base,
      url: "https://example.net/app",
      fetchImpl: async () =>
        html('<html><body><div id="root"></div><p>Loading…</p></body></html>'),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
    expect(String(error)).toContain("builds its text with scripts");
  });

  test("keeps a markdown file however short", async () => {
    // A file is what it is; only a rendered page can be a shell of one.
    const page = await fetchLinkPage({
      ...base,
      url: "https://example.net/NOTES.md",
      fetchImpl: async () =>
        new Response("# Notes\n\nShort.", {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    });
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.payload.markdownSource).toBe(true);
    expect(page.payload.markdown).toBe("# Notes\n\nShort.");
  });

  test("reads a markdown file on GitHub from its raw bytes", async () => {
    const page = await fetchLinkPage({
      ...base,
      url: "https://github.com/owner/repo/blob/main/docs/GUIDE.md",
      fetchImpl: site({
        "https://raw.githubusercontent.com/owner/repo/main/docs/GUIDE.md": () =>
          new Response("# Guide\n\nThe guide.", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      }),
    });
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.payload.markdown).toBe("# Guide\n\nThe guide.");
    expect(page.sourceUrl).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/docs/GUIDE.md",
    );
  });

  test("a GitHub file that is gone is settled", async () => {
    const error = await fetchLinkPage({
      ...base,
      url: "https://github.com/owner/repo/blob/main/GONE.md",
      fetchImpl: site({}),
    }).catch((e) => e);
    expect(isSettled(error)).toBe(true);
  });

  test("a run that runs out mid-fetch defers the article", async () => {
    // Invariant 8: the budget binds the request, and running out is an
    // orderly stop — not a broken link, and not a settled one.
    let now = 0;
    const deadline = createDeadline(10_000, () => now);
    const error = await fetchLinkPage({
      ...base,
      deadline,
      url: "https://example.net/slow",
      fetchImpl: async () => {
        now = 20_000;
        const timeout = new Error("The operation timed out.");
        timeout.name = "TimeoutError";
        throw timeout;
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DeadlineExceededError);
  });
});

describe("decodePage", () => {
  // 中文 in GBK. A Chinese page served as GBK and read as UTF-8 is not a
  // thin article; it is a wrong one.
  const gbk = new Uint8Array([
    ...new TextEncoder().encode("<p>"),
    0xd6,
    0xd0,
    0xce,
    0xc4,
    ...new TextEncoder().encode("</p>"),
  ]);

  test("uses the charset the header declares", () => {
    expect(decodePage(gbk, "text/html; charset=gbk")).toBe("<p>中文</p>");
  });

  test("falls back to a charset the page declares near its top", () => {
    const withMeta = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="GBK">'),
      ...gbk,
    ]);
    expect(decodePage(withMeta, "text/html")).toContain("<p>中文</p>");
  });

  test("reads UTF-8 when nothing says otherwise, and survives a bad label", () => {
    const utf8 = new TextEncoder().encode("<p>中文</p>");
    expect(decodePage(utf8, "text/html")).toBe("<p>中文</p>");
    expect(decodePage(utf8, "text/html; charset=no-such-charset")).toBe(
      "<p>中文</p>",
    );
  });
});
