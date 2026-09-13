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

describe("isSitemapEligible, short links", () => {
  // The aliases redirect; listing them would offer a crawler a second address
  // for content that already has a canonical one.
  test("drops every /s/ alias", () => {
    expect(isSitemapEligible(`${SITE}/s/e8446b12/`)).toBe(false);
    expect(isSitemapEligible(`${SITE}/s/e8446b12`)).toBe(false);
  });

  // An unlisted article's short link must not reach the sitemap either — that
  // would publish in one file what the flag keeps out of the other.
  test("drops the unlisted article's alias too", () => {
    expect(isSitemapEligible(`${SITE}/s/8145cda3/`)).toBe(false);
  });

  test("keeps a page that merely starts with an s", () => {
    expect(isSitemapEligible(`${SITE}/search/`)).toBe(true);
    expect(isSitemapEligible(`${SITE}/settings/`)).toBe(true);
  });

  test("keeps a deeper path under /s/", () => {
    // Only the alias route itself is a redirect; nothing else lives here, but
    // the rule should say what it means rather than claim the whole prefix.
    expect(isSitemapEligible(`${SITE}/s/e8446b12/more/`)).toBe(true);
  });
});
