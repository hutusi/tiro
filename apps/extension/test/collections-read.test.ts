import { describe, expect, test } from "bun:test";
import {
  type CollectionFrontmatter,
  stringifyCollection,
} from "@tiro/shared/documents";
import { readClipCollections } from "../src/collections-read.ts";
import type { FetchLike } from "../src/github.ts";
import type { TiroExtensionConfig } from "../src/storage.ts";
import { fakeGitHub } from "./fake-github.ts";

const config: TiroExtensionConfig = {
  owner: "o",
  repo: "r",
  branch: "main",
  token: "t",
};
const A = "example-com-a-1234abcd";
const B = "example-com-b-5678abcd";

function collectionFile(
  title: string,
  items: string[],
  extra: Partial<CollectionFrontmatter> = {},
): string {
  return stringifyCollection(
    {
      title,
      ...extra,
      items: items.map((slug) => ({ slug })),
      tiro: { schema: 1 },
    },
    "",
  );
}

describe("readClipCollections", () => {
  test("a vault with no collections offers none, and the article is in none", async () => {
    const gh = fakeGitHub({ [`articles/${A}/index.md`]: "---\n---\n" });
    expect(await readClipCollections(config, A, gh.fetch)).toEqual({
      slug: A,
      member: [],
      catalog: [],
      unreadable: [],
    });
  });

  test("lists every collection in the site's order and says which hold the article", async () => {
    const gh = fakeGitHub({
      "collections/reading.md": collectionFile("Reading", [B, A], {
        updated_at: "2026-09-22T10:00:00.000Z",
      }),
      "collections/alpha.md": collectionFile("Alpha", [], {
        updated_at: "2026-09-22T10:00:00.000Z",
      }),
      "collections/undated.md": collectionFile("Undated", [A]),
      "collections/favorites.md": collectionFile("收藏", [B], {
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      // Newer by instant, older by its digits: ordered by what it means.
      "collections/offset.md": collectionFile("Offset", [], {
        updated_at: "2026-09-22T09:00:00.000-05:00",
      }),
    });
    const read = await readClipCollections(config, A, gh.fetch);
    expect(read.catalog).toEqual([
      { id: "favorites", title: "收藏" },
      { id: "offset", title: "Offset" },
      { id: "alpha", title: "Alpha" },
      { id: "reading", title: "Reading" },
      { id: "undated", title: "Undated" },
    ]);
    expect(read.member.sort()).toEqual(["reading", "undated"]);
    expect(read.unreadable).toEqual([]);
  });

  test("a broken collection is left out and named, never fatal", async () => {
    const gh = fakeGitHub({
      "collections/reading.md": collectionFile("Reading", [A]),
      "collections/broken.md": "---\nitems: nope\n---\n",
      "collections/Not_An_Id.md": collectionFile("Bad name", [A]),
      "collections/notes.txt": "not a collection",
    });
    const read = await readClipCollections(config, A, gh.fetch);
    expect(read.catalog).toEqual([{ id: "reading", title: "Reading" }]);
    expect(read.member).toEqual(["reading"]);
    expect(read.unreadable.sort()).toEqual(["Not_An_Id", "broken"]);
  });

  test("every read is pinned to the head it started from", async () => {
    const gh = fakeGitHub({
      "collections/reading.md": collectionFile("Reading", []),
      "collections/later.md": collectionFile("Later", []),
    });
    const refs = new Set<string | null>();
    let heads = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/git/ref/heads/")) {
        heads += 1;
      } else if (url.pathname.includes("/contents/")) {
        refs.add(url.searchParams.get("ref"));
        // Another writer lands mid-read: the catalog must not mix the two.
        gh.commitDirect({
          "collections/intruder.md": collectionFile("Intruder", [A]),
        });
      }
      return gh.fetch(input, init);
    };
    const read = await readClipCollections(config, A, fetchImpl);
    expect(heads).toBe(1);
    expect(refs.size).toBe(1);
    expect([...refs][0]).not.toBe("main");
    expect(read.catalog.map((entry) => entry.id)).not.toContain("intruder");
  });

  test("an unreachable vault throws rather than reading as empty", async () => {
    const gh = fakeGitHub({}, "trunk");
    await expect(readClipCollections(config, A, gh.fetch)).rejects.toThrow();
  });
});
