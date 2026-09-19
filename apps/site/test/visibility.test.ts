import { describe, expect, test } from "bun:test";
import type { ArticleFrontmatter } from "@tiro/shared";
import { hasReadableBody, isUnlisted } from "../src/lib/visibility.ts";

function frontmatter(
  overrides: Partial<ArticleFrontmatter> = {},
): ArticleFrontmatter {
  return {
    url: "https://example.com/posts/hello",
    title: "Hello",
    domain: "example.com",
    clipped_at: "2026-09-12T09:00:00.000Z",
    tiro: { schema: 1 },
    ...overrides,
  };
}

describe("isUnlisted", () => {
  test("an article carrying the flag is unlisted", () => {
    expect(isUnlisted(frontmatter({ unlisted: true }))).toBe(true);
  });

  test("an article without the key is listed", () => {
    // The overwhelming majority: every article clipped before the flag
    // existed, and every one clipped since. Absence must mean listed.
    expect(isUnlisted(frontmatter())).toBe(false);
  });

  test("an explicit false is listed", () => {
    // `unlisted: false` is how someone un-hides an article without deleting
    // the line, and the obvious way to read the field back.
    expect(isUnlisted(frontmatter({ unlisted: false }))).toBe(false);
  });
});

describe("hasReadableBody", () => {
  test("publishes an article with a body", () => {
    expect(hasReadableBody({ body: "A paragraph.\n" })).toBe(true);
  });

  test("withholds an unconverted PDF stub", () => {
    // Between the clip and the conversion the article has nothing in it, and
    // a deploy triggered by some other article would otherwise give it a
    // reader page and a library row (ADR 0026).
    expect(hasReadableBody({ body: "" })).toBe(false);
  });

  test("withholds one that is only whitespace", () => {
    expect(hasReadableBody({ body: "\n  \n" })).toBe(false);
  });

  test("publishes a re-clipped PDF that carried its old body forward", () => {
    // Unprocessed but not empty: it has something to read, so hiding it would
    // withdraw a page over staleness rather than emptiness.
    expect(hasReadableBody({ body: "## Section 1\n\nStill here.\n" })).toBe(
      true,
    );
  });
});
