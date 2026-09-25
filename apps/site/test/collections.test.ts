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

function writeArticle(
  dir: string,
  slug: string,
  unlisted = false,
  body = `Body of ${slug}.`,
): void {
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

${body}
`,
  );
}

/** A PNG as far as `imageSize` reads: signature and IHDR, then padding to
 * `bytes` — so size on disk and pixel size can be set independently. */
function png(width: number, height: number, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 33));
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

function writeAsset(
  dir: string,
  slug: string,
  file: string,
  bytes: Uint8Array,
): void {
  const assets = join(dir, "articles", slug, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, file), bytes);
}

/** An article whose body references each file in order, each one written. */
function writeIllustrated(
  dir: string,
  slug: string,
  images: [file: string, bytes: Uint8Array][],
  unlisted = false,
): void {
  writeArticle(
    dir,
    slug,
    unlisted,
    images.map(([file]) => `![](./assets/${file})`).join("\n\n"),
  );
  for (const [file, bytes] of images) writeAsset(dir, slug, file, bytes);
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
  // `/favorites/` redirects unconditionally, so favorites needs a page even
  // before the vault has a file for it — or the shortcut is a 404.
  test("a vault with no collections still has favorites, virtually", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      const collections = await getCollections();
      expect(collections.map((c) => [c.id, c.title, c.virtual])).toEqual([
        ["favorites", "收藏", true],
      ]);
      expect(collections[0]?.articles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a real favorites.md is used, not doubled", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "favorites",
        'title: "My picks"\nitems:\n  - slug: "a"\n',
      );
      resetVaultCache();
      const favorites = (await getCollections()).filter(
        (c) => c.id === "favorites",
      );
      expect(favorites.map((c) => [c.title, c.virtual])).toEqual([
        ["My picks", false],
      ]);
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

  // Codex's pair: the offset one is five hours earlier, and sorts first as text.
  test("most recently updated is judged by instant, not by text", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(
        dir,
        "shanghai",
        'title: "S"\nupdated_at: "2026-09-23T01:00:00+08:00"\n',
      );
      writeCollection(
        dir,
        "utc",
        'title: "U"\nupdated_at: "2026-09-22T22:00:00Z"\n',
      );
      writeCollection(dir, "favorites", 'title: "收藏"\n');
      resetVaultCache();

      expect((await getCollections()).map((c) => c.id)).toEqual([
        "favorites",
        "utc",
        "shanghai",
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

      const shelf = (await getCollections()).find(
        (c) => c.id === "empty-shelf",
      );
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

      const reading = (await getCollections()).find((c) => c.id === "reading");
      expect(reading?.description).toBe("值得再读");
      expect(reading?.body.trim()).toBe("为什么留着这个列表。");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collection covers", () => {
  const PHOTO = png(1200, 800);

  async function coverOf(id: string): Promise<string[] | undefined> {
    resetVaultCache();
    return (await getCollections()).find((c) => c.id === id)?.coverImages;
  }

  test("up to three members' lead images, in the owner's order", async () => {
    const dir = vault();
    try {
      for (const slug of ["a", "b", "c", "d"]) {
        writeIllustrated(dir, slug, [[`${slug}.png`, PHOTO]]);
      }
      writeCollection(
        dir,
        "shelf",
        'title: "S"\nitems:\n  - slug: c\n  - slug: a\n  - slug: d\n  - slug: b\n',
      );
      expect(await coverOf("shelf")).toEqual([
        "/vault-assets/c/c.png",
        "/vault-assets/a/a.png",
        "/vault-assets/d/d.png",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the lead image is the first one worth a cover, not the first one", async () => {
    const dir = vault();
    try {
      writeIllustrated(dir, "a", [
        ["avatar.png", png(64, 64, 8000)], // heavy, but an avatar
        ["banner.png", png(1320, 189)], // a strip a crop would smear
        ["diagram.svg", new TextEncoder().encode("<svg/>".padEnd(9000))],
        ["anim.gif", new Uint8Array(9000)],
        ["missing.png", PHOTO],
        ["photo.png", PHOTO],
      ]);
      rmSync(join(dir, "articles", "a", "assets", "missing.png"));
      writeCollection(dir, "shelf", 'title: "S"\nitems:\n  - slug: a\n');
      expect(await coverOf("shelf")).toEqual(["/vault-assets/a/photo.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // What the page renders, not what a regex over the source finds (ADR 0030).
  test("follows the images the article renders", async () => {
    const dir = vault();
    try {
      const body = (file: string) =>
        [
          "```md",
          `![quoted](./assets/${file}-fenced.png)`,
          "```",
          "",
          `Inline code: \`![quoted](./assets/${file}-inline.png)\``,
          "",
          `<p><img src="./assets/${file}-html.png" alt=""></p>`,
        ].join("\n");
      writeArticle(dir, "a", false, body("a"));
      for (const suffix of ["fenced", "inline", "html"]) {
        writeAsset(dir, "a", `a-${suffix}.png`, PHOTO);
      }
      writeArticle(dir, "b", false, "![a [nested] alt](./assets/b.png)");
      writeAsset(dir, "b", "b.png", PHOTO);
      writeCollection(
        dir,
        "shelf",
        'title: "S"\nitems:\n  - slug: a\n  - slug: b\n',
      );
      expect(await coverOf("shelf")).toEqual([
        "/vault-assets/a/a-html.png",
        "/vault-assets/b/b.png",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AVIF, or a header the reader does not know: judged by weight instead.
  test("an image it cannot size is judged by its bytes", async () => {
    const dir = vault();
    try {
      writeIllustrated(dir, "a", [
        ["pixel.avif", new Uint8Array(200)],
        ["photo.avif", new Uint8Array(6000)],
      ]);
      writeCollection(dir, "shelf", 'title: "S"\nitems:\n  - slug: a\n');
      expect(await coverOf("shelf")).toEqual(["/vault-assets/a/photo.avif"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unlisted member lends no picture", async () => {
    const dir = vault();
    try {
      writeIllustrated(dir, "hidden", [["h.png", PHOTO]], true);
      writeIllustrated(dir, "shown", [["s.png", PHOTO]]);
      writeCollection(
        dir,
        "shelf",
        'title: "S"\nitems:\n  - slug: hidden\n  - slug: shown\n',
      );
      expect(await coverOf("shelf")).toEqual(["/vault-assets/shown/s.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hand-set cover wins, and may name a non-member", async () => {
    const dir = vault();
    try {
      writeIllustrated(dir, "a", [["a.png", PHOTO]]);
      writeArticle(dir, "b");
      // Too small to be picked, but a person chose it.
      writeAsset(dir, "b", "chosen.gif", new Uint8Array(40));
      writeCollection(
        dir,
        "shelf",
        'title: "S"\ncover: articles/b/assets/chosen.gif\nitems:\n  - slug: a\n',
      );
      expect(await coverOf("shelf")).toEqual(["/vault-assets/b/chosen.gif"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `validate` is the gate; the build shows what it would have built anyway.
  test("a hand-set cover that is gone, unlisted or not an image falls back", async () => {
    const dir = vault();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
      writeIllustrated(dir, "a", [["a.png", PHOTO]]);
      writeIllustrated(dir, "hidden", [["h.png", PHOTO]], true);
      writeCollection(
        dir,
        "gone",
        'title: "G"\ncover: articles/a/assets/pruned.png\nitems:\n  - slug: a\n',
      );
      writeCollection(
        dir,
        "secret",
        'title: "S"\ncover: articles/hidden/assets/h.png\nitems:\n  - slug: a\n',
      );
      writeAsset(dir, "a", "notes.txt", PHOTO);
      writeCollection(
        dir,
        "text",
        'title: "T"\ncover: articles/a/assets/notes.txt\nitems:\n  - slug: a\n',
      );
      resetVaultCache();
      const collections = await getCollections();
      for (const id of ["gone", "secret", "text"]) {
        expect(collections.find((c) => c.id === id)?.coverImages).toEqual([
          "/vault-assets/a/a.png",
        ]);
      }
      expect(warnings).toHaveLength(3);
      expect(warnings.join("\n")).toContain("collections/secret.md");
    } finally {
      console.warn = warn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no pictures at all is an empty cover, drawn as type", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(dir, "shelf", 'title: "S"\nitems:\n  - slug: a\n');
      expect(await coverOf("shelf")).toEqual([]);
      expect(await coverOf("favorites")).toEqual([]);
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

  // The clipper names a collection only when it is missing from this
  // catalog; listing virtual favorites would get `favorites.md` born titled
  // "favorites" instead of whatever the clipper would have called it.
  test("virtual favorites is not offered to the clipper as a real collection", async () => {
    const dir = vault();
    try {
      writeArticle(dir, "a");
      writeCollection(dir, "reading", 'title: "重读"\n');
      resetVaultCache();

      const payload = JSON.parse(await tiroPagePayload("a"));
      expect(payload.collections.map((c: { id: string }) => c.id)).toEqual([
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
