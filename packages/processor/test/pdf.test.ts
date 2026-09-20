import { describe, expect, test } from "bun:test";
import { createDeadline, DeadlineExceededError } from "../src/deadline.ts";
import type { ChatFn, FetchLike } from "../src/llm/client.ts";
import { convertPdf, fetchPdf, pdfSource } from "../src/pdf.ts";
import { makePdf } from "./helpers.ts";

const PROSE =
  "The method is straightforward to implement, is computationally efficient, has little memory requirements, and is invariant to diagonal rescaling of the gradients.";

const fetchOptions = {
  url: "https://example.com/paper.pdf",
  maxBytes: 25 * 1024 * 1024,
  timeoutMs: 60_000,
  stageTimeoutMs: 300_000,
  allowPrivateHosts: true,
};

const pdfResponse = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(bytes, {
    headers: { "content-type": "application/pdf", ...headers },
  });

describe("fetchPdf", () => {
  test("returns the bytes of a PDF", async () => {
    const bytes = makePdf([PROSE]);
    const fetchImpl: FetchLike = async () => pdfResponse(bytes);
    const got = await fetchPdf({ ...fetchOptions, fetchImpl });
    expect(got.byteLength).toBe(bytes.byteLength);
  });

  test("accepts octet-stream, which is how a file download is often served", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(makePdf([PROSE]), {
        headers: { "content-type": "application/octet-stream" },
      });
    await expect(
      fetchPdf({ ...fetchOptions, fetchImpl }),
    ).resolves.toBeDefined();
  });

  test("rejects a content type that is not a PDF at all", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("<html>login</html>", {
        headers: { "content-type": "text/html" },
      });
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /not a PDF: text\/html/,
    );
  });

  test("rejects bytes that are not a PDF however they were labelled", async () => {
    // The content type is the server's claim; the magic bytes are the fact.
    // This is what stops an interstitial served as application/pdf, or a
    // rebound DNS answer, from being read as a document.
    const fetchImpl: FetchLike = async () =>
      pdfResponse(new TextEncoder().encode("<html>rate limited</html>"));
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /not a PDF: begins/,
    );
  });

  test("refuses an oversized document before downloading it", async () => {
    let read = false;
    const fetchImpl: FetchLike = async () => {
      const res = pdfResponse(makePdf([PROSE]), {
        "content-length": String(40 * 1024 * 1024),
      });
      Object.defineProperty(res, "body", {
        get() {
          read = true;
          return null;
        },
      });
      return res;
    };
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /too large/,
    );
    expect(read).toBe(false);
  });

  test("stops mid-stream when the server understated the size", async () => {
    const fetchImpl: FetchLike = async () =>
      pdfResponse(new Uint8Array(4096).fill(0x25));
    await expect(
      fetchPdf({ ...fetchOptions, fetchImpl, maxBytes: 512 }),
    ).rejects.toThrow(/too large: exceeded 512 bytes/);
  });

  test("surfaces a failed request rather than treating it as a document", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("nope", { status: 404 });
    await expect(fetchPdf({ ...fetchOptions, fetchImpl })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  test("applies the non-public host guard", async () => {
    // Not redundant with the image stage's own test: the guard is shared now,
    // and this is the assertion that this stage actually opted into it.
    const fetchImpl: FetchLike = async () => pdfResponse(makePdf([PROSE]));
    await expect(
      fetchPdf({
        ...fetchOptions,
        url: "http://169.254.169.254/latest/meta-data/",
        allowPrivateHosts: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/non-public host/);
  });
});

describe("convertPdf and its two clocks", () => {
  const chat: ChatFn = async (request) =>
    request.messages.find((m) => m.role === "user")?.content ?? "";

  const options = () => ({
    url: "https://example.com/paper.pdf",
    maxBytes: 25 * 1024 * 1024,
    timeoutMs: 60_000,
    maxPages: 200,
    minCharsPerPage: 100,
    minPageCoverage: 0.5,
    allowPrivateHosts: true,
    chat,
    model: "m",
    fetchImpl: (async () =>
      new Response(makePdf([PROSE, PROSE]), {
        headers: { "content-type": "application/pdf" },
      })) as FetchLike,
  });

  test("converts a PDF within both budgets", async () => {
    const result = await convertPdf({
      ...options(),
      stageTimeoutMs: 300_000,
      deadline: createDeadline(300_000),
    });
    expect(result.totalPages).toBe(2);
    expect(result.markdown).toContain("straightforward");
  });

  test("a blown run budget defers rather than failing the article", async () => {
    // DeadlineExceededError is the pipeline's signal to leave the article
    // pending *with the run's work committed*. Nothing in the stage may
    // convert it into an ordinary failure.
    await expect(
      convertPdf({
        ...options(),
        stageTimeoutMs: 300_000,
        deadline: createDeadline(-1),
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });

  test("a blown stage cap is a fault about this document, not the run", async () => {
    // The other clock, and deliberately not a DeadlineExceededError: the run
    // is healthy, this PDF is the problem, and reporting it as a late run
    // would put it in the log line that means "nothing is wrong".
    const error = await convertPdf({
      ...options(),
      stageTimeoutMs: -1,
      deadline: createDeadline(300_000),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toMatch(/pdf stage timed out/);
  });

  test("believes the run budget when both have expired", async () => {
    // Order matters: a deferral that reported itself as a stage fault would
    // book the article as failed and lose the reassuring outcome.
    await expect(
      convertPdf({
        ...options(),
        stageTimeoutMs: -1,
        deadline: createDeadline(-1),
      }),
    ).rejects.toThrow(DeadlineExceededError);
  });
});

describe("convertPdf when a clock runs out mid-download", () => {
  const chat: ChatFn = async (request) =>
    request.messages.find((m) => m.role === "user")?.content ?? "";

  const options = {
    url: "https://example.com/paper.pdf",
    maxBytes: 25 * 1024 * 1024,
    timeoutMs: 60_000,
    maxPages: 200,
    minCharsPerPage: 100,
    minPageCoverage: 0.5,
    allowPrivateHosts: true,
    stageTimeoutMs: 300_000,
    chat,
    model: "m",
  };

  test("an expiring run budget defers rather than failing the article", async () => {
    // AbortSignal.timeout raises TimeoutError whichever clock ran out, so
    // without re-reading them a routine end-of-budget stop was booked as a
    // broken article. The clock is driven by hand: at real speed this is a
    // race against the abort, and the boundary is exactly the interesting case.
    let now = 0;
    const deadline = createDeadline(100, () => now);
    const fetchImpl: FetchLike = async () => {
      now = 200; // the run budget expires while the request is in flight
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const error = await convertPdf({
      ...options,
      fetchImpl,
      deadline,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlineExceededError);
  });

  test("a download that simply failed is still a fault about this document", async () => {
    // The clock must not be blamed for everything: with budget left, the
    // original error has to survive.
    const error = await convertPdf({
      ...options,
      fetchImpl: async () => new Response("nope", { status: 500 }),
      deadline: createDeadline(300_000),
    }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DeadlineExceededError);
    expect(String(error)).toMatch(/HTTP 500/);
  });
});

describe("pdfSource", () => {
  const base = {
    url: "https://example.com/paper.pdf",
    clipped_at: "2026-09-20T10:00:00.000Z",
  };

  test("a web PDF is downloaded", () => {
    expect(pdfSource({ ...base, tiro: { schema: 1 } })).toEqual({
      kind: "download",
      url: "https://example.com/paper.pdf",
    });
  });

  test("follows source_url when the article is filed elsewhere", () => {
    // A canonicalized publisher files an article under a URL nobody visited
    // (ADR 0013), and the bytes are at the other one.
    expect(
      pdfSource({
        ...base,
        url: "https://arxiv.org/abs/2404.19756",
        tiro: { schema: 1, source_url: "https://arxiv.org/pdf/2404.19756v1" },
      }),
    ).toEqual({
      kind: "download",
      url: "https://arxiv.org/pdf/2404.19756v1",
    });
  });

  test("an import awaiting conversion carries its stamp", () => {
    // The stamp is the import's, and only an import gets one: a re-import
    // writes byte-identical text, so content addressing cannot tell it from a
    // resumed run.
    expect(
      pdfSource({
        ...base,
        url: "local:report.pdf",
        tiro: { schema: 1, pdf_unstructured: true },
      }),
    ).toEqual({ kind: "extracted", stamp: "2026-09-20T10:00:00.000Z" });
  });

  test("a converted import is done", () => {
    expect(
      pdfSource({ ...base, url: "local:report.pdf", tiro: { schema: 1 } }),
    ).toEqual({ kind: "converted" });
  });

  test("reads the flag, not processed_at", () => {
    // markPending strips processed_at when a forced run is deferred and leaves
    // the finished body, so the marker says "unconverted" over Markdown. The
    // flag is the fact about the body; this is the whole reason it exists.
    expect(
      pdfSource({
        ...base,
        url: "local:report.pdf",
        tiro: { schema: 1 },
      }).kind,
    ).toBe("converted");
    expect(
      pdfSource({
        ...base,
        url: "local:report.pdf",
        tiro: { schema: 1, processed_at: "2026-09-20T11:00:00.000Z" },
      }).kind,
    ).toBe("converted");
  });

  test("never stamps a download", () => {
    // Stamping those discarded every batch of every re-clip.
    const source = pdfSource({ ...base, tiro: { schema: 1 } });
    expect("stamp" in source).toBe(false);
  });
});
