import { describe, expect, test } from "bun:test";
import {
  type ArticleFrontmatter,
  parseArticle,
  slugForUrl,
} from "@tiro/shared";
import { recanonicalize } from "../scripts/sweep.ts";
import type { ClipPayload } from "../src/messages.ts";

const frontmatter = (url: string): ArticleFrontmatter => ({
  url,
  title: "Old title",
  domain: "arxiv.org",
  clipped_at: "2026-09-01T06:13:19.432Z",
  author: "Stephen Chung\nThanks: DualverseAI; University of Cambridge",
  excerpt: "††thanks: zmliu@mit.edu",
  tiro: {
    schema: 1,
    clipper_version: "0.9.0",
    processed_at: "2026-09-02T02:28:11.614Z",
    processor_version: "0.1.0",
  },
});

const article = (slug: string, url: string, body = "Body text.\n") => ({
  slug,
  url,
  body,
  frontmatter: frontmatter(url),
});

const payload = (over: Partial<ClipPayload> = {}): ClipPayload => ({
  url: "https://arxiv.org/abs/2404.19756",
  title: "KAN: Kolmogorov–Arnold Networks",
  excerpt: "Inspired by the representation theorem.",
  author: "Ziming Liu, Yixuan Wang",
  markdown: "# KAN\n",
  readabilityFailed: false,
  hasMath: true,
  pdfViewer: false,
  latexmlFullText: true,
  ...over,
});

describe("recanonicalize", () => {
  const old = "arxiv-org-html-2404-19756v1-18854016";
  const url = "https://arxiv.org/html/2404.19756v1";

  test("moves the article to the slug its URL now derives to", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    expect(plan?.to).toBe(await slugForUrl(url));
    expect(plan?.to).toBe("arxiv-org-abs-2404-19756-637af334");
  });

  test("files it under the canonical URL and records where it was read", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.url).toBe("https://arxiv.org/abs/2404.19756");
    expect(written.tiro.source_url).toBe(url);
  });

  // The reason this mode exists rather than a re-clip: the body is what costs
  // an LLM run to reproduce, and it is exactly what does not need to change.
  test("leaves the body byte-identical", async () => {
    const body = "Para one.\n\nPara two.\n";
    const plan = await recanonicalize(article(old, url, body), payload());
    expect(parseArticle(plan?.index ?? "").body).toBe(body);
  });

  test("keeps the article processed, so nothing is re-queued", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.tiro.processed_at).toBe("2026-09-02T02:28:11.614Z");
  });

  test("refreshes the metadata the fresh clip improved, and says which", async () => {
    const plan = await recanonicalize(article(old, url), payload());
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(written.author).toBe("Ziming Liu, Yixuan Wang");
    expect(written.excerpt).not.toContain("thanks");
    expect(plan?.refreshed).toEqual(["title", "author", "excerpt"]);
  });

  // A page that no longer loads still has to be moved: left where it is, the
  // next clip of it would create a second article beside this one.
  test("renames without a fresh clip, leaving the metadata alone", async () => {
    const plan = await recanonicalize(article(old, url), null);
    const { frontmatter: written } = parseArticle(plan?.index ?? "");
    expect(plan?.to).toBe("arxiv-org-abs-2404-19756-637af334");
    expect(written.author).toStartWith("Stephen Chung");
    expect(plan?.refreshed).toEqual([]);
  });

  test("does nothing for an article already at its slug", async () => {
    const settled = "example-com-posts-hello-ai-e8446b12";
    const plan = await recanonicalize(
      article(settled, "https://example.com/posts/hello-ai"),
      payload(),
    );
    expect(plan).toBeNull();
  });

  // source_url would be noise on an article whose URL was never rewritten.
  test("omits source_url when only the slug rule changed the name", async () => {
    const plan = await recanonicalize(
      article("stale-name-00000000", "https://example.com/posts/hello-ai"),
      null,
    );
    expect(
      parseArticle(plan?.index ?? "").frontmatter.tiro.source_url,
    ).toBeUndefined();
  });
});
