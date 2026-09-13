import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllArticles, shortLinks } from "../src/lib/articles.ts";
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
});
