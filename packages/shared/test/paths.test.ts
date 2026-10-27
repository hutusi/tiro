import { describe, expect, test } from "bun:test";
import {
  memberDir,
  parseMemberRef,
  SNAPSHOT_ID,
  siteAssetsDir,
  siteDir,
  siteIndexPath,
  siteRef,
  snapshotAssetName,
} from "../src/paths.ts";

describe("snapshotAssetName", () => {
  test("is the id and .webp — the processor's own asset shape", () => {
    expect(snapshotAssetName("3f9a0c1b2d4e")).toBe("3f9a0c1b2d4e.webp");
  });

  test("refuses anything that is not twelve lowercase hex digits", () => {
    // The id reaches a vault path, so it is checked where the path is made.
    for (const id of [
      "",
      "3F9A0C1B2D4E",
      "3f9a0c1b2d4",
      "3f9a0c1b2d4e0",
      "../../x",
      "3f9a0c1b2d4e.webp",
    ]) {
      expect(SNAPSHOT_ID.test(id)).toBe(false);
      expect(() => snapshotAssetName(id)).toThrow();
    }
  });
});

describe("site references (ADR 0055)", () => {
  test("a site lives beside articles, under its own slug", () => {
    expect(siteDir("a-1234abcd")).toBe("sites/a-1234abcd");
    expect(siteIndexPath("a-1234abcd")).toBe("sites/a-1234abcd/index.md");
    expect(siteAssetsDir("a-1234abcd")).toBe("sites/a-1234abcd/assets");
  });

  test("sites/<slug> names a site; a bare slug still names an article", () => {
    expect(siteRef("a-1234abcd")).toBe("sites/a-1234abcd");
    expect(parseMemberRef("sites/a-1234abcd")).toEqual({
      kind: "site",
      slug: "a-1234abcd",
    });
    expect(parseMemberRef("a-1234abcd")).toEqual({
      kind: "article",
      slug: "a-1234abcd",
    });
    expect(memberDir("sites/a-1234abcd")).toBe("sites/a-1234abcd");
    expect(memberDir("a-1234abcd")).toBe("articles/a-1234abcd");
  });

  // An article slug is never `sites` — every one ends in its hash — so an
  // article slug that merely begins with the word is still an article.
  test("only the directory prefix makes a site", () => {
    expect(parseMemberRef("sites-example-com-1234abcd").kind).toBe("article");
  });
});
