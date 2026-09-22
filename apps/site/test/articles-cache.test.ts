import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAllArticles,
  getArticles,
  shortLinks,
  tagPageUrl,
} from "../src/lib/articles.ts";
import { resetVaultCache } from "../src/lib/vault-read.ts";

/** `articles.ts` became unit-testable when it stopped importing
 * `astro:content` (ADR 0020); these are the caches it derives from a read. */
function article(slug: string, url: string): string {
  return `---
url: "${url}"
title: "${slug}"
domain: "example.com"
clipped_at: "2026-08-22T08:00:00.000Z"
tiro:
  schema: 1
---

Body of ${slug}.
`;
}

function write(dir: string, slug: string, url: string): void {
  const articleDir = join(dir, "articles", slug);
  mkdirSync(articleDir, { recursive: true });
  writeFileSync(join(articleDir, "index.md"), article(slug, url));
}

afterEach(() => {
  delete process.env.TIRO_VAULT_DIR;
  resetVaultCache();
});

describe("caches derived from a vault read", () => {
  // Every derived cache has to fall with the read it came from. shortLinkCache
  // used to survive one, so after a dev edit the articles were rebuilt while
  // `/s/<id>/` still mapped the slugs from before it.
  test("a changed vault invalidates the short links too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-articles-"));
    try {
      write(dir, "example-com-a-3a0f9c1e", "https://example.com/a");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();

      expect(await getAllArticles()).toHaveLength(1);
      expect((await shortLinks()).byId.size).toBe(1);

      // A second article appears, as a clip lands while dev is running.
      write(dir, "example-com-b-77d21b04", "https://example.com/b");
      resetVaultCache();

      expect(await getAllArticles()).toHaveLength(2);
      const links = await shortLinks();
      expect(links.byId.size).toBe(2);
      expect(links.bySlug.get("77d21b04")).toBe("example-com-b-77d21b04");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every list, feed and index goes through `getArticles`, and the reader is
  // the only caller of `getAllArticles` — so if the listed memo can only be
  // dropped by a call the listing pages never make, a dev edit shows up on
  // the article page and nowhere else. It short-circuited on the stale value
  // and never ran the invalidation it depended on.
  test("getArticles on its own notices a changed vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-listed-"));
    try {
      write(dir, "example-com-a-3a0f9c1e", "https://example.com/a");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();

      expect(await getArticles()).toHaveLength(1);

      write(dir, "example-com-b-77d21b04", "https://example.com/b");
      resetVaultCache();

      expect(await getArticles()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the term-page index falls with the articles it was built from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-terms-"));
    function tagged(slug: string, tag: string): void {
      const articleDir = join(dir, "articles", slug);
      mkdirSync(articleDir, { recursive: true });
      writeFileSync(
        join(articleDir, "index.md"),
        `---\nurl: "https://example.com/${slug}"\ntitle: "${slug}"\ndomain: "example.com"\nclipped_at: "2026-08-22T08:00:00.000Z"\ntags:\n  - ${tag}\ntiro:\n  schema: 1\n---\n\nBody.\n`,
      );
    }
    try {
      tagged("example-com-a-3a0f9c1e", "alpha");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();

      expect(await tagPageUrl("alpha")).toBe("/tags/alpha/");

      // The tag is retagged in the vault, so its page stops existing.
      tagged("example-com-a-3a0f9c1e", "beta");
      resetVaultCache();

      expect(await tagPageUrl("alpha")).toBeNull();
      expect(await tagPageUrl("beta")).toBe("/tags/beta/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unconverted PDF stubs", () => {
  /** A PDF as the extension commits it: identity and title, no body. */
  function stub(dir: string, slug: string, url: string): void {
    const articleDir = join(dir, "articles", slug);
    mkdirSync(articleDir, { recursive: true });
    writeFileSync(
      join(articleDir, "index.md"),
      `---
url: "${url}"
title: "A paper"
domain: "example.com"
clipped_at: "2026-09-19T08:00:00.000Z"
tiro:
  schema: 1
  source_media: pdf
---
`,
    );
  }

  test("are not published", async () => {
    // A deploy fired by the other article would otherwise give the stub a
    // reader page showing nothing and a library row leading to it — the empty
    // article the clipper refused to commit before PDFs were clippable at all.
    const dir = mkdtempSync(join(tmpdir(), "tiro-articles-"));
    try {
      write(dir, "example-com-a-3a0f9c1e", "https://example.com/a");
      stub(dir, "example-com-p-pdf-11223344", "https://example.com/p.pdf");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();

      const articles = await getAllArticles();
      expect(articles).toHaveLength(1);
      expect(articles[0]?.slug).toBe("example-com-a-3a0f9c1e");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("get no short link either", async () => {
    // Short links are built from the same funnel, so a stub must not acquire
    // an address that resolves to a page that was never built.
    const dir = mkdtempSync(join(tmpdir(), "tiro-articles-"));
    try {
      write(dir, "example-com-a-3a0f9c1e", "https://example.com/a");
      stub(dir, "example-com-p-pdf-11223344", "https://example.com/p.pdf");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();

      expect((await shortLinks()).byId.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appear once the processor has built a body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiro-articles-"));
    try {
      const slug = "example-com-p-pdf-11223344";
      stub(dir, slug, "https://example.com/p.pdf");
      process.env.TIRO_VAULT_DIR = dir;
      resetVaultCache();
      expect(await getAllArticles()).toHaveLength(0);

      writeFileSync(
        join(dir, "articles", slug, "index.md"),
        `---
url: "https://example.com/p.pdf"
title: "A paper"
domain: "example.com"
clipped_at: "2026-09-19T08:00:00.000Z"
tiro:
  schema: 1
  source_media: pdf
  processed_at: "2026-09-19T09:00:00.000Z"
---

## Section 1

Converted at last.
`,
      );
      resetVaultCache();
      expect(await getAllArticles()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
