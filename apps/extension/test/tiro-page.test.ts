import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { parseTiroPage, readTiroMarker } from "../src/tiro-page.ts";

const payload = {
  v: 1,
  slug: "example-com-a-1234abcd",
  member: ["favorites"],
  collections: [
    { id: "favorites", title: "收藏" },
    { id: "reading", title: "重读" },
  ],
};

describe("readTiroMarker", () => {
  // It runs in the tab from serialized source, so it is exercised the way
  // Chrome runs it: as a string, rebuilt into a function, with no module
  // scope around it. A reference to anything outside its own body throws here.
  function runInPage(html: string) {
    const window = new Window();
    window.document.write(html);
    const fn = new Function(
      "document",
      `return (${readTiroMarker.toString()})();`,
    );
    return fn(window.document);
  }

  test("reads the marker and the payload off an article page", () => {
    const marker = runInPage(
      `<html><head><meta name="tiro:site" content="1"><script type="application/json" id="tiro-page">${JSON.stringify(payload)}</script></head><body></body></html>`,
    );
    expect(marker.site).toBe(true);
    expect(JSON.parse(marker.payload)).toEqual(payload);
  });

  test("an ordinary page has neither", () => {
    expect(runInPage("<html><body><p>hi</p></body></html>")).toEqual({
      site: false,
      payload: null,
    });
  });
});

describe("parseTiroPage", () => {
  const marker = (p: unknown) => ({
    site: true,
    payload: typeof p === "string" ? p : JSON.stringify(p),
  });

  test("an ordinary page is not a Tiro page", () => {
    expect(parseTiroPage({ site: false, payload: null })).toBeNull();
    expect(parseTiroPage(null)).toBeNull();
    // The island alone is not the marker.
    expect(
      parseTiroPage({ site: false, payload: JSON.stringify(payload) }),
    ).toBeNull();
  });

  test("an article page yields its slug, membership and catalog", () => {
    expect(parseTiroPage(marker(payload))).toEqual({
      kind: "article",
      slug: payload.slug,
      member: ["favorites"],
      catalog: payload.collections,
    });
  });

  test("a Tiro page with no readable payload is still a Tiro page", () => {
    expect(parseTiroPage({ site: true, payload: null })).toEqual({
      kind: "site",
    });
    expect(parseTiroPage(marker("{not json"))).toEqual({ kind: "site" });
    expect(parseTiroPage(marker({ ...payload, v: 2 }))).toEqual({
      kind: "site",
    });
  });

  // Any page can carry the marker. Nothing it says may become a path.
  test("a slug or id that could not be a path segment is refused", () => {
    expect(parseTiroPage(marker({ ...payload, slug: "../config" }))).toEqual({
      kind: "site",
    });
    const parsed = parseTiroPage(
      marker({
        ...payload,
        member: ["favorites", "../x", "not-in-catalog"],
        collections: [
          { id: "favorites", title: "收藏" },
          { id: "../config/tiro", title: "evil" },
          { id: "Upper", title: "x" },
          { id: "favorites", title: "dup" },
        ],
      }),
    );
    expect(parsed).toEqual({
      kind: "article",
      slug: payload.slug,
      member: ["favorites"],
      catalog: [{ id: "favorites", title: "收藏" }],
    });
  });

  test("a missing or blank title falls back to the id", () => {
    const parsed = parseTiroPage(
      marker({
        ...payload,
        collections: [{ id: "reading" }, { id: "x-1", title: "  " }],
      }),
    );
    expect(parsed).toMatchObject({
      catalog: [
        { id: "reading", title: "reading" },
        { id: "x-1", title: "x-1" },
      ],
    });
  });
});
