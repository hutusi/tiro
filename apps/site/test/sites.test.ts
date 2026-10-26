import { describe, expect, test } from "bun:test";
import type { SiteFrontmatter } from "@tiro/shared";
import {
  getSites,
  previewSize,
  previewSrc,
  type Site,
  siteHref,
  sitesPageUrl,
  siteUrl,
} from "../src/lib/sites.ts";

/** ADR 0055, the site's side of saved sites. */

const FIXTURE = "maps-example-org-roman-battles-facc4f75";

function site(over: Partial<SiteFrontmatter> = {}): Site {
  return {
    slug: "map-1234abcd",
    ref: "sites/map-1234abcd",
    frontmatter: {
      url: "https://maps.example.com/",
      title: "Map",
      domain: "maps.example.com",
      clipped_at: "2026-10-20T08:00:00.000Z",
      tiro: { schema: 1 },
      ...over,
    },
  };
}

describe("saved sites on the site", () => {
  test("the fixture site is listed, with its page, screenshot and size", () => {
    const [fixture] = getSites();
    expect(fixture?.slug).toBe(FIXTURE);
    expect(fixture?.ref).toBe(`sites/${FIXTURE}`);
    if (fixture === undefined) return;
    expect(siteUrl(fixture)).toBe(`/sites/${FIXTURE}/`);
    expect(previewSrc(fixture)).toBe(
      `/vault-assets/sites/${FIXTURE}/54ea819b7af4.webp`,
    );
    expect(previewSize(fixture)).toEqual({ width: 480, height: 300 });
  });

  test("open goes to the view that was saved, else the URL", () => {
    const view = "https://maps.example.com/#year=-216";
    expect(siteHref(site({ tiro: { schema: 1, source_url: view } }))).toBe(
      view,
    );
    expect(siteHref(site())).toBe("https://maps.example.com/");
  });

  // A hand edit reaches the vault, and this becomes an href on a public page.
  test("open is never anything but an http(s) address", () => {
    expect(
      siteHref(
        site({
          url: "javascript:alert(1)",
          tiro: { schema: 1, source_url: "data:text/html,x" },
        }),
      ),
    ).toBeNull();
    expect(
      siteHref(
        site({
          tiro: { schema: 1, source_url: "javascript:alert(1)" },
        }),
      ),
    ).toBe("https://maps.example.com/");
  });

  test("a site saved without a screenshot has none to show", () => {
    expect(previewSrc(site())).toBeNull();
    expect(previewSize(site())).toBeNull();
  });

  test("the gallery pages like the library, under its own path", () => {
    expect(sitesPageUrl(1)).toBe("/sites/");
    expect(sitesPageUrl(2)).toBe("/sites/page/2/");
  });
});
