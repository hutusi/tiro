import { describe, expect, test } from "bun:test";
import { countMarkdown, readUrl, stripFrontmatter } from "../scripts/sweep.ts";

describe("countMarkdown", () => {
  test("counts images and the subset that carry a folded caption", () => {
    const md = [
      "![a](x.png)  ", // folded: hard break, then a caption line
      "A caption.",
      "",
      "![b](y.png)", // bare image, no caption
      "",
      "Prose mentioning ![c](z.png) inline.",
    ].join("\n");
    expect(countMarkdown(md)).toEqual({ images: 3, captions: 1 });
  });

  test("a caption is an image line, so captions never exceed images", () => {
    const { images, captions } = countMarkdown("![a](x.png)  \nCap.");
    expect(captions).toBeLessThanOrEqual(images);
  });

  test("a line of prose ending in a hard break is not a caption", () => {
    // The trailing spaces alone must not count — an image has to be on the line.
    expect(countMarkdown("Just prose.  \nMore.")).toEqual({
      images: 0,
      captions: 0,
    });
  });

  test("counts nothing in empty markdown", () => {
    expect(countMarkdown("")).toEqual({ images: 0, captions: 0 });
  });
});

describe("stripFrontmatter", () => {
  test("removes the head and keeps the body verbatim", () => {
    expect(stripFrontmatter("---\nurl: https://e.com/\n---\nBody.\n")).toBe(
      "Body.\n",
    );
  });

  test("leaves a document with no frontmatter alone", () => {
    expect(stripFrontmatter("# Heading\n")).toBe("# Heading\n");
  });

  test("returns an unterminated head unchanged rather than throwing", () => {
    // A malformed head should surface as a wrong count, not stop the sweep.
    const broken = "---\nurl: https://e.com/\n";
    expect(stripFrontmatter(broken)).toBe(broken);
  });

  test("keeps a --- inside the body", () => {
    const body = stripFrontmatter("---\na: 1\n---\nOne\n\n---\n\nTwo\n");
    expect(body).toBe("One\n\n---\n\nTwo\n");
  });
});

describe("readUrl", () => {
  test("reads the url from frontmatter", () => {
    expect(readUrl("---\ntitle: T\nurl: https://e.com/a\n---\n")).toBe(
      "https://e.com/a",
    );
  });

  test("returns null when there is no url", () => {
    expect(readUrl("---\ntitle: T\n---\n")).toBeNull();
  });

  test("does not match a url nested under another key", () => {
    // `source_url:` and an indented `url:` are both something else.
    expect(readUrl("---\n  url: https://e.com/nested\n---\n")).toBeNull();
  });
});
