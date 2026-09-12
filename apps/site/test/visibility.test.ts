import { describe, expect, test } from "bun:test";
import type { ArticleFrontmatter } from "@tiro/shared";
import { isUnlisted } from "../src/lib/visibility.ts";

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
