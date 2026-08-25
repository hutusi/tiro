import { describe, expect, test } from "bun:test";
import { parseArticle, slugForUrl } from "@tiro/shared";
import { buildClipFile } from "../src/clip.ts";

const input = {
  url: "https://example.com/posts/hello-ai?utm_source=x",
  title: 'Hello, AI: A "Practical" Guide — 实用指南',
  markdown: "# Hello\n\nA paragraph.",
  excerpt: "A short excerpt.",
  author: "Jane Doe",
  clippedAt: "2026-08-22T10:00:00.000Z",
};

describe("buildClipFile", () => {
  test("produces a schema-valid index.md at the contract path", async () => {
    const file = await buildClipFile(input);
    expect(file.slug).toBe(await slugForUrl(input.url));
    expect(file.path).toBe(`articles/${file.slug}/index.md`);

    const { frontmatter, body } = parseArticle(file.content);
    expect(frontmatter.url).toBe(input.url);
    expect(frontmatter.title).toBe(input.title);
    expect(frontmatter.domain).toBe("example.com");
    expect(frontmatter.clipped_at).toBe(input.clippedAt);
    expect(frontmatter.excerpt).toBe(input.excerpt);
    expect(frontmatter.author).toBe(input.author);
    expect(frontmatter.tiro).toEqual({ schema: 1 });
    expect(body).toBe("# Hello\n\nA paragraph.\n");
  });

  test("falls back to the domain when the title is empty", async () => {
    const file = await buildClipFile({ ...input, title: "  " });
    expect(parseArticle(file.content).frontmatter.title).toBe("example.com");
  });

  test("omits empty optional fields and records readability failure", async () => {
    const file = await buildClipFile({
      ...input,
      excerpt: "",
      author: "",
      readabilityFailed: true,
    });
    const { frontmatter } = parseArticle(file.content);
    expect(frontmatter.excerpt).toBeUndefined();
    expect(frontmatter.author).toBeUndefined();
    expect(frontmatter.readability_failed).toBe(true);
    expect(file.content).not.toContain("excerpt:");
  });
});
