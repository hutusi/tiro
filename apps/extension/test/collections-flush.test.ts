import { describe, expect, test } from "bun:test";
import { parseCollection } from "@tiro/shared";
import type { QueuedOp } from "../src/collection-queue.ts";
import { flushCollections } from "../src/collections-flush.ts";
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
const vault = {
  [`articles/${A}/index.md`]: "A",
  [`articles/${B}/index.md`]: "B",
};

let n = 0;
function op(
  action: "add" | "remove",
  collection: string,
  slug: string,
  extra: Partial<QueuedOp> = {},
): QueuedOp {
  n += 1;
  return {
    id: `op${n}`,
    collection,
    slug,
    action,
    at: `2026-09-22T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    state: "pending",
    ...extra,
  };
}

function members(files: Map<string, string>, id: string): string[] {
  const text = files.get(`collections/${id}.md`);
  if (text === undefined) return [];
  return parseCollection(id, text).frontmatter.items.map((item) => item.slug);
}

describe("flushCollections", () => {
  test("every toggle across collections lands as one commit", async () => {
    const gh = fakeGitHub(vault);
    const outcome = await flushCollections(
      config,
      [
        op("add", "favorites", A),
        op("add", "favorites", B),
        op("add", "reading", A),
      ],
      gh.fetch,
    );
    expect(gh.log()).toEqual(["root", "collections: favorites +2, reading +1"]);
    expect(members(gh.files(), "favorites")).toEqual([B, A]);
    expect(members(gh.files(), "reading")).toEqual([A]);
    expect(outcome.sent.size).toBe(3);
    expect(outcome.refused).toEqual([]);
  });

  test("a new collection is born with the title the popup gave it", async () => {
    const gh = fakeGitHub(vault);
    await flushCollections(
      config,
      [op("add", "collection-1a2b3c4d", A, { title: "待读" })],
      gh.fetch,
    );
    const text = gh.files().get("collections/collection-1a2b3c4d.md") ?? "";
    expect(parseCollection("collection-1a2b3c4d", text).frontmatter.title).toBe(
      "待读",
    );
  });

  // The marker says "a Tiro site", not "your Tiro site". A slug from someone
  // else's deployment must not become a member with nothing behind it.
  test("refuses an add for an article this vault does not have", async () => {
    const gh = fakeGitHub(vault);
    const foreign = op("add", "favorites", "elsewhere-com-x-deadbeef");
    const outcome = await flushCollections(
      config,
      [op("add", "favorites", A), foreign],
      gh.fetch,
    );
    expect(outcome.refused.map((r) => r.id)).toEqual([foreign.id]);
    expect(outcome.sent.has(foreign.id)).toBe(false);
    expect(members(gh.files(), "favorites")).toEqual([A]);
  });

  // `validate` counts an article only when its `index.md` is there. A
  // directory holding nothing but an orphan translation is not an article.
  test("refuses an add whose directory has no index.md", async () => {
    const gh = fakeGitHub({
      ...vault,
      "articles/orphan-com-x-deadbeef/zh.md": "译文",
    });
    const orphan = op("add", "favorites", "orphan-com-x-deadbeef");
    const outcome = await flushCollections(config, [orphan], gh.fetch);
    expect(outcome.refused.map((r) => r.id)).toEqual([orphan.id]);
    expect(outcome.committed).toBeNull();
    expect(gh.files().has("collections/favorites.md")).toBe(false);
  });

  test("an all-refused flush writes nothing", async () => {
    const gh = fakeGitHub(vault);
    const outcome = await flushCollections(
      config,
      [op("add", "favorites", "elsewhere-com-x-deadbeef")],
      gh.fetch,
    );
    expect(outcome.committed).toBeNull();
    expect(gh.log()).toEqual(["root"]);
  });

  test("ops that already landed are sent without a second commit", async () => {
    const gh = fakeGitHub(vault);
    const ops = [op("add", "favorites", A)];
    await flushCollections(config, ops, gh.fetch);
    const again = await flushCollections(config, ops, gh.fetch);
    expect(again.committed).toBeNull();
    expect(again.sent.has(ops[0]?.id ?? "")).toBe(true);
    expect(gh.log()).toHaveLength(2);
  });

  // A delta against the file as it stands, not an overwrite from a copy: an
  // edit from another machine that lands mid-flush survives.
  test("keeps a concurrent edit made elsewhere", async () => {
    const gh = fakeGitHub({
      ...vault,
      "collections/favorites.md": `---\ntitle: 收藏\nitems:\n  - slug: ${A}\ntiro:\n  schema: 1\n---\n`,
    });
    let raced = false;
    gh.onBeforePatch = () => {
      if (raced) return;
      raced = true;
      gh.commitDirect(
        {
          "collections/favorites.md": `---\ntitle: 收藏\nitems:\n  - slug: ${A}\n  - slug: ${B}\ntiro:\n  schema: 1\n---\n`,
        },
        "other machine",
      );
    };
    await flushCollections(config, [op("remove", "favorites", A)], gh.fetch);
    expect(members(gh.files(), "favorites")).toEqual([B]);
  });

  test("a hand-written collection it cannot parse fails the flush and is left alone", async () => {
    const broken = "---\ntiro:\n  schema: 1\n---\nno title\n";
    const gh = fakeGitHub({ ...vault, "collections/favorites.md": broken });
    await expect(
      flushCollections(config, [op("add", "favorites", A)], gh.fetch),
    ).rejects.toThrow();
    expect(gh.files().get("collections/favorites.md")).toBe(broken);
  });

  test("an id that could not be a filename never becomes a path", async () => {
    const gh = fakeGitHub(vault);
    await expect(
      flushCollections(config, [op("add", "../config/tiro", A)], gh.fetch),
    ).rejects.toThrow("not a usable collection id");
    expect(gh.requests).toEqual([]);
  });

  test("nothing pending makes no request at all", async () => {
    const gh = fakeGitHub(vault);
    await flushCollections(config, [], gh.fetch);
    expect(gh.requests).toEqual([]);
  });
});
