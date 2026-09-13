import { describe, expect, test } from "bun:test";
import {
  buildShortLinks,
  redirectRules,
  shortLinkPath,
  shortPathForSlug,
} from "../src/lib/short-links.ts";

const HELLO = "example-com-posts-hello-ai-e8446b12";
const UNLISTED = "example-cn-notes-unlisted-shelf-8145cda3";
const TIMES = "example-cn-posts-ai-times-0d21367e";

describe("buildShortLinks", () => {
  test("maps each slug both ways", () => {
    const links = buildShortLinks([HELLO, TIMES]);
    expect(links.bySlug.get("e8446b12")).toBe(HELLO);
    expect(links.byId.get(HELLO)).toBe("e8446b12");
    expect(links.bySlug.size).toBe(2);
    expect(links.collisions.size).toBe(0);
    expect(links.underivable).toEqual([]);
  });

  // The URL is the whole sharing mechanism for an unlisted article, so it is
  // the one that most wants to be short.
  test("gives an unlisted article a short link", () => {
    const links = buildShortLinks([UNLISTED]);
    expect(shortPathForSlug(links, UNLISTED)).toBe("/s/8145cda3/");
  });

  // Keeping one and reassigning the other would make the id depend on which
  // article was seen first, and a rebuild could flip it — silently re-pointing
  // a link someone already shared.
  test("drops the id from every article in a clash, not all but one", () => {
    const other = `other-com-notes-thing-${"e8446b12"}`;
    const links = buildShortLinks([HELLO, other, TIMES]);
    expect(links.bySlug.has("e8446b12")).toBe(false);
    expect(links.byId.has(HELLO)).toBe(false);
    expect(links.byId.has(other)).toBe(false);
    expect(links.collisions.get("e8446b12")).toEqual([HELLO, other].sort());
    // The clash costs the clashing articles their id and nothing else.
    expect(links.byId.get(TIMES)).toBe("0d21367e");
  });

  test("a clashing article falls back to no short path", () => {
    const other = `other-com-notes-thing-${"e8446b12"}`;
    const links = buildShortLinks([HELLO, other]);
    expect(shortPathForSlug(links, HELLO)).toBeNull();
  });

  test("reports a name with no derivable id instead of inventing one", () => {
    const links = buildShortLinks([HELLO, "hand-made-directory"]);
    expect(links.underivable).toEqual(["hand-made-directory"]);
    expect(shortPathForSlug(links, "hand-made-directory")).toBeNull();
    expect(links.byId.get(HELLO)).toBe("e8446b12");
  });

  test("is a pure function of the slugs, in any order", () => {
    const forward = buildShortLinks([HELLO, TIMES, UNLISTED]);
    const reversed = buildShortLinks([UNLISTED, TIMES, HELLO]);
    expect([...forward.byId].sort()).toEqual([...reversed.byId].sort());
  });

  test("asks for a slug it never saw", () => {
    expect(shortPathForSlug(buildShortLinks([]), HELLO)).toBeNull();
  });
});

describe("shortLinkPath", () => {
  test("is /s/<id>/, matching the route", () => {
    expect(shortLinkPath("e8446b12")).toBe("/s/e8446b12/");
  });
});

describe("redirectRules", () => {
  test("emits one rule per article, pointing at the long path", () => {
    expect(redirectRules(buildShortLinks([HELLO, TIMES]))).toEqual([
      `/s/0d21367e/  /articles/${TIMES}/  301`,
      `/s/e8446b12/  /articles/${HELLO}/  301`,
    ]);
  });

  // The bug this pins: the generator spelled the path itself as `/s/<id>` while
  // the share button copied `/s/<id>/`. Cloudflare matches those literally, so
  // every shared link fell through to the 200 fallback page instead of the 301.
  test("the rule's source is exactly what the share button copies", () => {
    const links = buildShortLinks([HELLO, TIMES, UNLISTED]);
    const sources = redirectRules(links).map((rule) => rule.split(/\s+/)[0]);
    const shared = [...links.byId.values()].map(shortLinkPath).sort();
    expect(sources.sort()).toEqual(shared);
  });

  test("is sorted, so an unchanged vault rebuilds byte-identically", () => {
    const slugs = [HELLO, TIMES, UNLISTED];
    expect(redirectRules(buildShortLinks(slugs))).toEqual(
      redirectRules(buildShortLinks([...slugs].reverse())),
    );
  });

  test("emits nothing for an article that lost its id", () => {
    const other = `other-com-notes-thing-${"e8446b12"}`;
    const rules = redirectRules(buildShortLinks([HELLO, other]));
    expect(rules).toEqual([]);
  });
});
