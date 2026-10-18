import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIContext } from "astro";
import { resetVaultCache } from "../src/lib/vault-read.ts";
import { FEED_ITEMS, GET } from "../src/pages/rss.xml.ts";

afterEach(() => {
  delete process.env.TIRO_VAULT_DIR;
  resetVaultCache();
});

test("the feed carries only the newest articles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tiro-rss-"));
  try {
    const total = FEED_ITEMS + 5;
    for (let i = 0; i < total; i += 1) {
      const slug = `example-com-a${i}-0000000${i % 10}`;
      mkdirSync(join(dir, "articles", slug), { recursive: true });
      // One minute apart, so article i is newer than article i - 1.
      const clippedAt = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
      writeFileSync(
        join(dir, "articles", slug, "index.md"),
        `---\nurl: "https://example.com/a${i}"\ntitle: "Article ${i}"\ndomain: "example.com"\nclipped_at: "${clippedAt}"\ntiro:\n  schema: 1\n---\n\nBody ${i}.\n`,
      );
    }
    process.env.TIRO_VAULT_DIR = dir;
    resetVaultCache();

    const response = await GET({
      site: new URL("https://tiro.example"),
    } as APIContext);
    const xml = await response.text();
    const titles = [...xml.matchAll(/<title>Article (\d+)<\/title>/g)].map(
      (match) => Number(match[1]),
    );
    expect(titles).toHaveLength(FEED_ITEMS);
    // The newest is first, and the oldest five are the ones left out.
    expect(titles[0]).toBe(total - 1);
    expect(Math.min(...titles)).toBe(total - FEED_ITEMS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
