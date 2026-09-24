import { describe, expect, test } from "bun:test";
import {
  applyCollectionOps,
  type CollectionOp,
  FAVORITES_ID,
  type ParsedCollection,
  parseCollection,
  parseCoverPath,
  renameCollectionMember,
  stringifyCollection,
} from "../src/collections.ts";
import { compareInstants } from "../src/frontmatter.ts";
import { collectionPath } from "../src/paths.ts";
import { collectionId, isValidCollectionId } from "../src/slug.ts";

const T1 = "2026-09-22T10:00:00.000Z";
const T2 = "2026-09-22T11:00:00.000Z";
const T3 = "2026-09-22T12:00:00.000Z";

function collection(
  items: { slug: string; added_at?: string }[],
  body = "",
): ParsedCollection {
  return {
    id: FAVORITES_ID,
    frontmatter: {
      title: "收藏",
      created_at: T1,
      updated_at: T1,
      items,
      tiro: { schema: 1 },
    },
    body,
  };
}

function op(
  action: "add" | "remove",
  slug: string,
  at: string,
  extra: Partial<CollectionOp> = {},
): CollectionOp {
  return { collection: FAVORITES_ID, slug, action, at, ...extra };
}

describe("parseCollection", () => {
  test("reads a full collection file", () => {
    const parsed = parseCollection(
      "ai-safety",
      `---\ntitle: "AI 安全"\ndescription: "值得反复读的几篇"\ncreated_at: "${T1}"\nupdated_at: "${T2}"\nitems:\n  - slug: "a-1234abcd"\n    added_at: "${T2}"\ntiro:\n  schema: 1\n---\n\n为什么留着这个列表。\n`,
    );
    expect(parsed.id).toBe("ai-safety");
    expect(parsed.frontmatter.title).toBe("AI 安全");
    expect(parsed.frontmatter.description).toBe("值得反复读的几篇");
    expect(parsed.frontmatter.items).toEqual([
      { slug: "a-1234abcd", added_at: T2 },
    ]);
    expect(parsed.body).toBe("为什么留着这个列表。\n");
  });

  test("a hand-written collection needs only a title and the schema", () => {
    const parsed = parseCollection(
      "reading",
      "---\ntitle: Reading\ntiro:\n  schema: 1\n---\n",
    );
    expect(parsed.frontmatter.items).toEqual([]);
    expect(parsed.frontmatter.created_at).toBeUndefined();
    expect(parsed.body).toBe("");
  });

  test("an item may be a bare slug, so the file stays hand-editable", () => {
    const parsed = parseCollection(
      "reading",
      "---\ntitle: Reading\nitems:\n  - slug: a-1234abcd\ntiro:\n  schema: 1\n---\n",
    );
    expect(parsed.frontmatter.items).toEqual([{ slug: "a-1234abcd" }]);
  });

  test("refuses a file with no frontmatter", () => {
    expect(() => parseCollection("x", "just prose\n")).toThrow(
      "collection has no frontmatter block",
    );
  });

  test("refuses a missing title and a foreign schema version", () => {
    expect(() =>
      parseCollection("x", "---\ntiro:\n  schema: 1\n---\n"),
    ).toThrow();
    expect(() =>
      parseCollection("x", "---\ntitle: X\ntiro:\n  schema: 2\n---\n"),
    ).toThrow();
  });
});

describe("cover", () => {
  const withCover = (cover: string) =>
    `---\ntitle: X\ncover: "${cover}"\ntiro:\n  schema: 1\n---\n`;

  test("accepts an article asset named by its vault path", () => {
    const parsed = parseCollection(
      "x",
      withCover("articles/a-1234abcd/assets/0f71f771c929.png"),
    );
    expect(parsed.frontmatter.cover).toBe(
      "articles/a-1234abcd/assets/0f71f771c929.png",
    );
    expect(parseCoverPath("articles/a-1234abcd/assets/cover.png")).toEqual({
      slug: "a-1234abcd",
      file: "cover.png",
    });
  });

  test("refuses anything that is not one article asset", () => {
    for (const bad of [
      "https://example.com/cover.png",
      "/articles/a-1234abcd/assets/c.png",
      "articles/a-1234abcd/assets/../../../etc/passwd",
      "articles/a-1234abcd/assets/nested/c.png",
      "articles/a-1234abcd/assets/.hidden.png",
      "articles/a-1234abcd/index.md",
      "articles/A-Upper/assets/c.png",
      "collections/assets/c.png",
    ]) {
      expect(() => parseCollection("x", withCover(bad))).toThrow();
      expect(parseCoverPath(bad)).toBeNull();
    }
  });

  // The clipper parses a collection, applies its ops and writes the result
  // back. A field the schema did not declare would be stripped by the parse,
  // so a hand-set cover would vanish on the next toggle.
  test("survives the clipper's parse, apply and write", () => {
    const text = stringifyCollection(
      {
        ...collection([]).frontmatter,
        description: "值得反复读的几篇",
        cover: "articles/a-1234abcd/assets/cover.png",
      },
      "为什么留着这个列表。",
    );
    const result = applyCollectionOps(
      FAVORITES_ID,
      parseCollection(FAVORITES_ID, text),
      [op("add", "b-1234abcd", T2)],
    );
    if (result === null) throw new Error("expected a change");
    const written = parseCollection(
      FAVORITES_ID,
      stringifyCollection(result.frontmatter, result.body),
    );
    expect(written.frontmatter.cover).toBe(
      "articles/a-1234abcd/assets/cover.png",
    );
    expect(written.frontmatter.description).toBe("值得反复读的几篇");
    expect(written.body).toBe("为什么留着这个列表。\n");
  });
});

describe("stringifyCollection", () => {
  test("round-trips through parseCollection", () => {
    const original = collection(
      [{ slug: "a-1234abcd", added_at: T2 }],
      "Why.\n",
    );
    const text = stringifyCollection(original.frontmatter, original.body);
    expect(parseCollection(FAVORITES_ID, text)).toEqual(original);
  });

  test("an empty body leaves no trailing blank line to churn the diff", () => {
    const text = stringifyCollection(collection([]).frontmatter, "");
    expect(text.endsWith("---\n")).toBe(true);
  });

  test("the yaml serializer owns quoting, not a template", () => {
    const text = stringifyCollection(
      { ...collection([]).frontmatter, title: 'Reading: "2026" # notes' },
      "",
    );
    expect(parseCollection("x", text).frontmatter.title).toBe(
      'Reading: "2026" # notes',
    );
  });
});

describe("collectionId", () => {
  test("folds a name to lowercase ascii", () => {
    expect(collectionId("AI Safety")).toBe("ai-safety");
    expect(collectionId("Long-form  reads!")).toBe("long-form-reads");
    expect(collectionId("Café notes")).toBe("cafe-notes");
  });

  test("a name that folds to nothing falls back to a hash, not an empty id", () => {
    const id = collectionId("收藏");
    expect(id).toMatch(/^collection-[0-9a-f]{8}$/);
    expect(collectionId("收藏")).toBe(id);
    expect(collectionId("待读")).not.toBe(id);
  });

  test("two long names sharing a prefix stay distinct", () => {
    const a = collectionId(`${"long ".repeat(20)}alpha`);
    const b = collectionId(`${"long ".repeat(20)}beta`);
    expect(a).not.toBe(b);
    expect(isValidCollectionId(a)).toBe(true);
  });

  test("everything it produces passes the id rule", () => {
    for (const name of ["AI Safety", "收藏", "  ", "--x--", "a".repeat(200)]) {
      expect(isValidCollectionId(collectionId(name))).toBe(true);
    }
  });
});

describe("isValidCollectionId", () => {
  test("accepts the shapes collectionId emits", () => {
    expect(isValidCollectionId("favorites")).toBe(true);
    expect(isValidCollectionId("ai-safety")).toBe(true);
    expect(isValidCollectionId("2026")).toBe(true);
  });

  test("rejects what would break a filename or a route", () => {
    for (const bad of [
      "",
      "-x",
      "x-",
      "a--b",
      "Favorites",
      "ai safety",
      "ai/safety",
      "..",
      ".hidden",
      "收藏",
      "a".repeat(80),
    ]) {
      expect(isValidCollectionId(bad)).toBe(false);
    }
  });
});

test("collectionPath puts collections beside articles, not inside them", () => {
  expect(collectionPath("favorites")).toBe("collections/favorites.md");
});

describe("applyCollectionOps", () => {
  test("creates the file from the first op, titled by it", () => {
    const result = applyCollectionOps(FAVORITES_ID, null, [
      op("add", "a-1234abcd", T1, { title: "收藏" }),
    ]);
    expect(result?.frontmatter.title).toBe("收藏");
    expect(result?.frontmatter.created_at).toBe(T1);
    expect(result?.frontmatter.updated_at).toBe(T1);
    expect(result?.frontmatter.items).toEqual([
      { slug: "a-1234abcd", added_at: T1 },
    ]);
    expect(result?.body).toBe("");
  });

  test("an untitled op names the collection after its id rather than guessing", () => {
    const result = applyCollectionOps(FAVORITES_ID, null, [
      op("add", "a-1234abcd", T1),
    ]);
    expect(result?.frontmatter.title).toBe(FAVORITES_ID);
  });

  test("prepends, so a collection reads newest-first", () => {
    const result = applyCollectionOps(
      FAVORITES_ID,
      collection([{ slug: "old" }]),
      [op("add", "new", T2)],
    );
    expect(result?.frontmatter.items.map((i) => i.slug)).toEqual([
      "new",
      "old",
    ]);
  });

  test("adding a member again is a no-op and keeps its place and date", () => {
    const existing = collection([
      { slug: "first", added_at: T1 },
      { slug: "second", added_at: T2 },
    ]);
    expect(
      applyCollectionOps(FAVORITES_ID, existing, [op("add", "second", T3)]),
    ).toBeNull();
  });

  test("removing a non-member changes nothing", () => {
    expect(
      applyCollectionOps(FAVORITES_ID, collection([{ slug: "a" }]), [
        op("remove", "b", T2),
      ]),
    ).toBeNull();
  });

  test("removing from a collection that does not exist writes nothing", () => {
    expect(
      applyCollectionOps(FAVORITES_ID, null, [op("remove", "a", T1)]),
    ).toBeNull();
  });

  test("add then remove in one flush is nothing, not an empty commit", () => {
    expect(
      applyCollectionOps(FAVORITES_ID, null, [
        op("add", "a", T1),
        op("remove", "a", T2),
      ]),
    ).toBeNull();
    expect(
      applyCollectionOps(FAVORITES_ID, collection([{ slug: "a" }]), [
        op("remove", "a", T1),
        op("add", "a", T2),
      ]),
    ).toBeNull();
  });

  test("the last toggle wins regardless of queue order", () => {
    const result = applyCollectionOps(FAVORITES_ID, collection([]), [
      op("remove", "a", T3),
      op("add", "a", T2),
    ]);
    expect(result).toBeNull();
  });

  test("ops for another collection are left alone", () => {
    expect(
      applyCollectionOps(FAVORITES_ID, collection([]), [
        { ...op("add", "a", T1), collection: "ai-safety" },
      ]),
    ).toBeNull();
  });

  test("keeps the body and every field it does not own", () => {
    const existing: ParsedCollection = {
      id: FAVORITES_ID,
      frontmatter: {
        title: "收藏",
        description: "留着重读",
        created_at: T1,
        updated_at: T1,
        items: [],
        tiro: { schema: 1 },
      },
      body: "手写的说明。\n",
    };
    const result = applyCollectionOps(FAVORITES_ID, existing, [
      op("add", "a", T2),
    ]);
    expect(result?.body).toBe("手写的说明。\n");
    expect(result?.frontmatter.description).toBe("留着重读");
    expect(result?.frontmatter.created_at).toBe(T1);
    expect(result?.frontmatter.updated_at).toBe(T2);
  });

  test("applying the same flush twice lands on the same file", () => {
    const ops = [op("add", "a", T1), op("add", "b", T2)];
    const once = applyCollectionOps(FAVORITES_ID, collection([]), ops);
    expect(once).not.toBeNull();
    expect(applyCollectionOps(FAVORITES_ID, once, ops)).toBeNull();
  });
});

describe("renameCollectionMember", () => {
  test("keeps the member's place and date under its new slug", () => {
    const existing = collection([
      { slug: "first", added_at: T1 },
      { slug: "old-slug", added_at: T2 },
      { slug: "last", added_at: T3 },
    ]);
    const [renamed] = renameCollectionMember(
      [existing],
      "old-slug",
      "new-slug",
    );
    expect(renamed?.frontmatter.items).toEqual([
      { slug: "first", added_at: T1 },
      { slug: "new-slug", added_at: T2 },
      { slug: "last", added_at: T3 },
    ]);
    // Nothing the owner decided has changed.
    expect(renamed?.frontmatter.updated_at).toBe(T1);
  });

  test("drops the old entry when the new slug is already a member", () => {
    const existing = collection([{ slug: "new-slug" }, { slug: "old-slug" }]);
    const [renamed] = renameCollectionMember(
      [existing],
      "old-slug",
      "new-slug",
    );
    expect(renamed?.frontmatter.items).toEqual([{ slug: "new-slug" }]);
  });

  test("carries a cover that lives in the renamed article", () => {
    const existing = collection([{ slug: "old-slug" }]);
    existing.frontmatter.cover = "articles/old-slug/assets/c.png";
    const [renamed] = renameCollectionMember(
      [existing],
      "old-slug",
      "new-slug",
    );
    expect(renamed?.frontmatter.cover).toBe("articles/new-slug/assets/c.png");
  });

  test("carries a cover even when its article is not a member", () => {
    const existing = collection([{ slug: "x" }]);
    existing.frontmatter.cover = "articles/old-slug/assets/c.png";
    const changed = renameCollectionMember([existing], "old-slug", "new-slug");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.frontmatter.items).toEqual([{ slug: "x" }]);
    expect(changed[0]?.frontmatter.cover).toBe(
      "articles/new-slug/assets/c.png",
    );
    // A slug that merely starts with the old one is a different article.
    const other = collection([]);
    other.frontmatter.cover = "articles/old-slug-2/assets/c.png";
    expect(renameCollectionMember([other], "old-slug", "new")).toEqual([]);
  });

  test("returns only the collections that changed", () => {
    const holding = collection([{ slug: "old-slug" }]);
    const other = { ...collection([{ slug: "x" }]), id: "other" };
    const changed = renameCollectionMember([holding, other], "old-slug", "new");
    expect(changed.map((c) => c.id)).toEqual([FAVORITES_ID]);
  });

  test("leaves the input alone", () => {
    const existing = collection([{ slug: "old-slug" }]);
    renameCollectionMember([existing], "old-slug", "new-slug");
    expect(existing.frontmatter.items).toEqual([{ slug: "old-slug" }]);
  });
});

describe("timestamps with offsets", () => {
  // Five hours apart, and in the opposite order as text.
  const EARLIER = "2026-09-23T01:00:00+08:00"; // 2026-09-22T17:00:00Z
  const LATER = "2026-09-22T22:00:00Z";

  test("compareInstants orders by the instant, not the digits", () => {
    expect(EARLIER > LATER).toBe(true); // the trap
    expect(compareInstants(EARLIER, LATER)).toBeLessThan(0);
    expect(compareInstants(LATER, EARLIER)).toBeGreaterThan(0);
    expect(compareInstants("2026-09-22T22:00:00+00:00", LATER)).toBe(0);
  });

  test("a missing value orders first, so newest-first puts it last", () => {
    expect(compareInstants(undefined, LATER)).toBeLessThan(0);
    expect(compareInstants(LATER, null)).toBeGreaterThan(0);
    expect(compareInstants("", undefined)).toBe(0);
  });

  test("applyCollectionOps settles on the chronologically last toggle", () => {
    // Added at 17:00Z, removed at 22:00Z: the article is out. By text the
    // add would come last and put it back.
    expect(
      applyCollectionOps(FAVORITES_ID, collection([]), [
        op("add", "a", EARLIER),
        op("remove", "a", LATER),
      ]),
    ).toBeNull();
  });

  // Another machine saved after this one queued its toggle. The flush applies
  // a delta so that save survives; its timestamp has to survive too.
  test("updated_at never moves backwards past what the file says", () => {
    const existing = collection([]);
    existing.frontmatter.updated_at = "2026-09-23T12:00:00.000Z";
    const result = applyCollectionOps(FAVORITES_ID, existing, [
      op("add", "a", "2026-09-23T10:00:00.000Z"),
    ]);
    expect(result?.frontmatter.updated_at).toBe("2026-09-23T12:00:00.000Z");
    // …and still advances when the ops are the newer ones.
    const later = applyCollectionOps(FAVORITES_ID, existing, [
      op("add", "a", "2026-09-23T14:00:00.000Z"),
    ]);
    expect(later?.frontmatter.updated_at).toBe("2026-09-23T14:00:00.000Z");
  });

  test("updated_at is the latest instant, not the largest string", () => {
    const result = applyCollectionOps(FAVORITES_ID, collection([]), [
      op("add", "a", EARLIER),
      op("add", "b", LATER),
    ]);
    expect(result?.frontmatter.updated_at).toBe(LATER);
  });
});
