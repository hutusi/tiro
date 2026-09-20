import { describe, expect, test } from "bun:test";
import {
  isLocalDocument,
  LOCAL_DOCUMENT_DOMAIN,
  localDocumentName,
  localDocumentUrl,
} from "../src/local-document.ts";
import { normalizeUrl, slugForUrl } from "../src/slug.ts";

describe("localDocumentUrl", () => {
  test("files a document under its own name", () => {
    expect(localDocumentUrl("stacked-prs-guide.pdf")).toBe(
      "local:stacked-prs-guide.pdf",
    );
  });

  test("keeps only the basename", () => {
    // A path would put the owner's directory layout into a public slug, and it
    // says nothing about the document: the same file in two folders is one
    // document, and the same name next week is the same document.
    expect(localDocumentUrl("/Users/someone/Downloads/report.pdf")).toBe(
      "local:report.pdf",
    );
    expect(localDocumentUrl("C:\\Users\\someone\\report.pdf")).toBe(
      "local:report.pdf",
    );
  });

  test("survives spaces and punctuation", () => {
    expect(localDocumentUrl("Q3 Report (final).pdf")).toBe(
      "local:Q3%20Report%20(final).pdf",
    );
  });

  test("trims, so a dragged name does not change the identity", () => {
    expect(localDocumentUrl("  report.pdf  ")).toBe("local:report.pdf");
  });
});

describe("a local identity through the existing URL rules", () => {
  test("normalizes to itself", () => {
    // canonicalizeUrl declines anything that is not http(s), so nothing here
    // rewrites it.
    const url = localDocumentUrl("stacked-prs-guide.pdf");
    expect(normalizeUrl(url)).toBe(url);
  });

  test("produces a readable slug with no rule changes", async () => {
    expect(await slugForUrl(localDocumentUrl("stacked-prs-guide.pdf"))).toBe(
      "stacked-prs-guide-pdf-6ae040b1",
    );
  });

  test("is stable across re-imports of the same name", async () => {
    const a = await slugForUrl(localDocumentUrl("/tmp/report.pdf"));
    const b = await slugForUrl(localDocumentUrl("/elsewhere/report.pdf"));
    expect(a).toBe(b);
  });

  test("still separates two different documents", async () => {
    const a = await slugForUrl(localDocumentUrl("a.pdf"));
    const b = await slugForUrl(localDocumentUrl("b.pdf"));
    expect(a).not.toBe(b);
  });

  test("a CJK name falls back to the hash, as any CJK path already does", async () => {
    // Not new and not local-specific: slugify drops CJK, so
    // https://example.cn/posts/同步设计 is already example-cn-posts-<hash>. A
    // local identity has no hostname to soften it, so the slug is only the
    // hash — unique, unreadable, and the title still carries the name.
    const slug = await slugForUrl(localDocumentUrl("同步设计.pdf"));
    expect(slug).toMatch(/^pdf-[0-9a-f]{8}$/);
  });
});

describe("isLocalDocument", () => {
  test("recognises a local identity", () => {
    expect(isLocalDocument("local:report.pdf")).toBe(true);
  });

  test("leaves web articles alone", () => {
    expect(isLocalDocument("https://example.com/report.pdf")).toBe(false);
    expect(isLocalDocument("http://example.com/a")).toBe(false);
  });

  test("does not mistake a lookalike path for a scheme", () => {
    expect(isLocalDocument("https://example.com/local:report.pdf")).toBe(false);
  });
});

describe("localDocumentName", () => {
  test("gives the name back for display", () => {
    expect(localDocumentName("local:Q3%20Report%20(final).pdf")).toBe(
      "Q3 Report (final).pdf",
    );
  });

  test("gives back a CJK name intact", () => {
    // The slug loses it; the display name must not.
    expect(localDocumentName(localDocumentUrl("同步设计.pdf"))).toBe(
      "同步设计.pdf",
    );
  });

  test("returns null for a web article", () => {
    // So a caller cannot print a URL as though it were a filename.
    expect(localDocumentName("https://example.com/a")).toBeNull();
  });

  test("survives a malformed escape rather than throwing", () => {
    expect(localDocumentName("local:100%.pdf")).toBe("100%.pdf");
  });
});

describe("the domain sentinel", () => {
  test("is non-empty, which the contract requires", () => {
    expect(LOCAL_DOCUMENT_DOMAIN.length).toBeGreaterThan(0);
  });

  test("cannot be mistaken for a hostname", () => {
    expect(LOCAL_DOCUMENT_DOMAIN).not.toContain(".");
  });
});
