import { describe, expect, test } from "bun:test";
import {
  applyCollectionOps,
  type CollectionOp,
  FAVORITES_ID,
  type ParsedCollection,
  parseCollection,
  stringifyCollection,
} from "../src/collections.ts";
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
