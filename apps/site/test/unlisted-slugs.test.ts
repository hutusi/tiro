import { describe, expect, test } from "bun:test";
import { isSitemapEligible, unlistedSlugs } from "../src/lib/unlisted-slugs.ts";

const UNLISTED = "example-cn-notes-unlisted-shelf-8145cda3";
const LISTED = "example-org-blog-raw-clip-b5de6fbd";
const SITE = "https://tiro.ainaive.com";

describe("unlistedSlugs", () => {
  test("reads exactly the flagged article out of the fixture vault", () => {
    // Exactly, not merely "contains": a filter that matched too much would
    // silently strip the whole sitemap, and the site would look deindexed
    // without anything failing.
    expect([...unlistedSlugs()]).toEqual([UNLISTED]);
  });
});

describe("isSitemapEligible", () => {
  test("drops the unlisted article", () => {
    expect(isSitemapEligible(`${SITE}/articles/${UNLISTED}/`)).toBe(false);
  });

  test("keeps every other article", () => {
    expect(isSitemapEligible(`${SITE}/articles/${LISTED}/`)).toBe(true);
  });

  test("keeps pages that are not articles", () => {
    for (const page of ["/", "/page/2/", "/search/", "/settings/"]) {
      expect(isSitemapEligible(`${SITE}${page}`)).toBe(true);
    }
  });

  test("matches the slug as a whole path segment", () => {
    // A slug is a publisher's own path, so a substring test would drop pages
    // that merely contain one — and, worse, keep `/articles/<slug>-2/`.
    expect(isSitemapEligible(`${SITE}/articles/${UNLISTED}-2/`)).toBe(true);
    expect(isSitemapEligible(`${SITE}/notes/${UNLISTED}/`)).toBe(true);
  });
});
