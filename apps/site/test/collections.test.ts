import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectionsOf,
  getCollections,
  tiroPagePayload,
} from "../src/lib/collections.ts";
import { resetVaultCache } from "../src/lib/vault-read.ts";

function writeArticle(dir: string, slug: string, unlisted = false): void {
  const articleDir = join(dir, "articles", slug);
  mkdirSync(articleDir, { recursive: true });
  writeFileSync(
    join(articleDir, "index.md"),
    `---
url: "https://example.com/${slug}"
title: "${slug}"
domain: "example.com"
clipped_at: "2026-08-22T08:00:00.000Z"
${unlisted ? "unlisted: true\n" : ""}tiro:
  schema: 1
---

Body of ${slug}.
`,
  );
}

function writeCollection(
  dir: string,
  id: string,
  frontmatter: string,
  body = "",
): void {
  const collectionsDir = join(dir, "collections");
  mkdirSync(collectionsDir, { recursive: true });
  writeFileSync(
    join(collectionsDir, `${id}.md`),
    `---\n${frontmatter}tiro:\n  schema: 1\n---\n${body === "" ? "" : `\n${body}\n`}`,
  );
}

function vault(): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-collections-"));
  mkdirSync(join(dir, "articles"), { recursive: true });
  process.env.TIRO_VAULT_DIR = dir;
  resetVaultCache();
  return dir;
}

afterEach(() => {
  delete process.env.TIRO_VAULT_DIR;
  resetVaultCache();
});

describe("getCollections", () => {
  test("a vault with no collections directory has no collections", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      expect(await getCollections()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unlisted member is not listed, but is still a member", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "public-one");
      writeArticle(dir, "hidden-one", true);
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "hidden-one"\n  - slug: "public-one"\n',
      );
      resetVaultCache();

      const [favorites] = await getCollections();
      // ADR 0017: a public list must not put back what the flag removed.
      expect(favorites?.articles.map((a) => a.slug)).toEqual(["public-one"]);
      // But the membership itself is untouched — the clipper's tick reads this.
      expect(favorites?.memberSlugs).toEqual(["hidden-one", "public-one"]);
      expect((await collectionsOf("hidden-one")).map((c) => c.id)).toEqual([
        "favorites",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a member with no article is skipped rather than fatal", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "gone-3a0f9c1e"\n  - slug: "a"\n',
      );
      resetVaultCache();

      const [favorites] = await getCollections();
      expect(favorites?.articles.map((c) => c.slug)).toEqual(["a"]);
      expect(favorites?.memberSlugs).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps file order, which is the curation order", async () => {
    const dir = vault();
    try {
      for (const slug of ["a", "b", "c"]) writeArticle(dir, slug);
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "c"\n  - slug: "a"\n  - slug: "b"\n',
      );
      resetVaultCache();

      const [favorites] = await getCollections();
      expect(favorites?.articles.map((a) => a.slug)).toEqual(["c", "a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("favorites leads, then most recently updated, then id", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "zeta",
        'title: "Z"\nupdated_at: "2026-09-01T00:00:00.000Z"\n',
      );
      writeCollection(
        dir,
        "alpha",
        'title: "A"\nupdated_at: "2026-09-05T00:00:00.000Z"\n',
      );
      writeCollection(dir, "favorites", 'title: "收藏"\n');
      writeCollection(dir, "never-touched", 'title: "N"\n');
      resetVaultCache();

      expect((await getCollections()).map((c) => c.id)).toEqual([
        "favorites",
        "alpha",
        "zeta",
        "never-touched",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty collection is still listed", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(dir, "empty-shelf", 'title: "空书架"\nitems: []\n');
      resetVaultCache();

      const [shelf] = await getCollections();
      expect(shelf?.id).toBe("empty-shelf");
      expect(shelf?.articles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("carries the description and the prose body", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "reading",
        'title: "重读"\ndescription: "值得再读"\n',
        "为什么留着这个列表。",
      );
      resetVaultCache();

      const [reading] = await getCollections();
      expect(reading?.description).toBe("值得再读");
      expect(reading?.body.trim()).toBe("为什么留着这个列表。");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a collection file the site cannot use", () => {
  test("an unreadable one fails the build, naming the file", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      mkdirSync(join(dir, "collections"), { recursive: true });
      writeFileSync(join(dir, "collections", "broken.md"), "no frontmatter\n");
      resetVaultCache();

      // Skipping it silently would drop a curated list and report success.
      await expect(getCollections()).rejects.toThrow("broken.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a filename that cannot be a route is refused", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(dir, "Favorites", 'title: "收藏"\n');
      resetVaultCache();

      await expect(getCollections()).rejects.toThrow("collection id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("caches derived from a vault read", () => {
  // The membership index is derived from the collections, so it has to fall
  // with them. Reading the memo before asking for a fresh list would serve
  // yesterday's chips for as long as the dev server lives.
  test("a changed vault invalidates the membership index", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "a"\n',
      );
      resetVaultCache();

      expect((await collectionsOf("a")).map((c) => c.id)).toEqual([
        "favorites",
      ]);

      // The owner un-favorites it while dev is running.
      writeCollection(dir, "favorites", 'title: "收藏"\nitems: []\n');
      resetVaultCache();

      expect(await collectionsOf("a")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the #tiro-page payload", () => {
  test("carries the catalog, not just this article's membership", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "a"\n',
      );
      writeCollection(dir, "reading", 'title: "重读"\n');
      resetVaultCache();

      const payload = JSON.parse(await tiroPagePayload("a"));
      expect(payload.v).toBe(1);
      expect(payload.slug).toBe("a");
      expect(payload.member).toEqual(["favorites"]);
      // The whole catalog, so the popup can draw every tick from the DOM and
      // ask nothing over the network until the reader toggles something.
      expect(payload.collections.map((c: { id: string }) => c.id)).toEqual([
        "favorites",
        "reading",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unlisted article still reports what it is a member of", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "hidden-one", true);
      writeArticle(dir, "public-one");
      writeCollection(
        dir,
        "favorites",
        'title: "收藏"\nitems:\n  - slug: "hidden-one"\n',
      );
      resetVaultCache();

      // The tick says what is true of the vault, not what this site publishes.
      expect(JSON.parse(await tiroPagePayload("hidden-one")).member).toEqual([
        "favorites",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a title holding </script> cannot close the island", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "hostile",
        "title: 'x</script><img src=y onerror=alert(1)>'\n",
      );
      resetVaultCache();

      const payload = await tiroPagePayload("a");
      expect(payload).not.toContain("</script>");
      expect(payload).not.toContain("<img");
      // Still one JSON document, and `\u003c` is still `<` to any parser, so
      // nothing downstream has to know about the escape.
      expect(
        JSON.parse(payload).collections.map((c: { title: string }) => c.title),
      ).toContain("x</script><img src=y onerror=alert(1)>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
