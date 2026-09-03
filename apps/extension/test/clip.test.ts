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
  clipperVersion: "0.7.0",
  clipperCommit: "ext-v0.7.0-3-gabc1234",
};

describe("buildClipFile", () => {
  test("produces a schema-valid index.md at the contract path", async () => {
    const file = await buildClipFile(input);
    expect(file.slug).toBe(await slugForUrl(input.url));
    expect(file.path).toBe(`articles/${file.slug}/index.md`);

    const { frontmatter, body } = parseArticle(file.content);
    // The stored URL is normalized — tracking params never reach the vault.
    expect(frontmatter.url).toBe("https://example.com/posts/hello-ai");
    expect(frontmatter.title).toBe(input.title);
    expect(frontmatter.domain).toBe("example.com");
    expect(frontmatter.clipped_at).toBe(input.clippedAt);
    expect(frontmatter.excerpt).toBe(input.excerpt);
    expect(frontmatter.author).toBe(input.author);
    expect(frontmatter.tiro).toEqual({
      schema: 1,
      clipper_version: "0.7.0",
      clipper_commit: "ext-v0.7.0-3-gabc1234",
    });
    expect(body).toBe("# Hello\n\nA paragraph.\n");
  });

  test("omits the clipper version when it is unavailable", async () => {
    // `chrome.runtime.getManifest()` is the only source, and an article with no
    // version recorded is better than one claiming an empty string.
    const file = await buildClipFile({
      ...input,
      clipperVersion: "",
      clipperCommit: "",
    });
    expect(parseArticle(file.content).frontmatter.tiro).toEqual({ schema: 1 });
    expect(file.content).not.toContain("clipper_version:");
  });

  test("omits the commit when the build had no git to ask", async () => {
    // A source zip, or a checkout with no history: the build injects "" and an
    // absent field is honest where an empty one would not be.
    for (const clipperCommit of ["", undefined]) {
      const file = await buildClipFile({ ...input, clipperCommit });
      expect(parseArticle(file.content).frontmatter.tiro).toEqual({
        schema: 1,
        clipper_version: "0.7.0",
      });
      expect(file.content).not.toContain("clipper_commit:");
    }
  });

  test("records a dirty build as dirty", async () => {
    // The common case for an unpacked build. Recording the bare commit would
    // claim the tree was clean, which is the one thing the field must not do.
    const file = await buildClipFile({
      ...input,
      clipperCommit: "ext-v0.11.0-8-gbe3dcc8-dirty",
    });
    expect(parseArticle(file.content).frontmatter.tiro.clipper_commit).toBe(
      "ext-v0.11.0-8-gbe3dcc8-dirty",
    );
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
