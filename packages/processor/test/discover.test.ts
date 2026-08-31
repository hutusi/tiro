import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverArticles } from "../src/discover.ts";

function clip(slug: string, body: string, processed = false): string {
  return [
    "---",
    `url: "https://example.net/${slug}"`,
    `title: "${slug}"`,
    'domain: "example.net"',
    'clipped_at: "2026-08-23T09:00:00.000Z"',
    "tiro:",
    "  schema: 1",
    ...(processed ? ['  processed_at: "2026-08-23T10:00:00.000Z"'] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function vaultWith(articles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-discover-"));
  for (const [slug, body] of Object.entries(articles)) {
    mkdirSync(join(dir, "articles", slug), { recursive: true });
    writeFileSync(join(dir, "articles", slug, "index.md"), clip(slug, body));
  }
  return dir;
}

describe("discoverArticles ordering", () => {
  test("returns the cheapest article first, regardless of slug", async () => {
    // The regression this guards: under alphabetical order a huge article
    // sorting first ran first on every push, spent the whole run budget
    // without finishing, and starved everything behind it.
    const vault = vaultWith({
      "aaa-enormous-paper-00000000": "x".repeat(5000),
      "mmm-medium-post-11111111": "x".repeat(500),
      "zzz-tiny-note-22222222": "x".repeat(10),
    });
    const { pending } = await discoverArticles(vault);
    expect(pending.map((a) => a.slug)).toEqual([
      "zzz-tiny-note-22222222",
      "mmm-medium-post-11111111",
      "aaa-enormous-paper-00000000",
    ]);
  });

  test("breaks ties on slug so the order stays deterministic", async () => {
    const vault = vaultWith({
      "ccc-same-size-00000000": "identical body",
      "aaa-same-size-11111111": "identical body",
      "bbb-same-size-22222222": "identical body",
    });
    const { pending } = await discoverArticles(vault);
    expect(pending.map((a) => a.slug)).toEqual([
      "aaa-same-size-11111111",
      "bbb-same-size-22222222",
      "ccc-same-size-00000000",
    ]);
  });

  test("still selects only unprocessed articles", async () => {
    const dir = vaultWith({ "aaa-pending-00000000": "short" });
    mkdirSync(join(dir, "articles", "bbb-done-11111111"), { recursive: true });
    writeFileSync(
      join(dir, "articles", "bbb-done-11111111", "index.md"),
      clip("bbb-done-11111111", "a", true),
    );
    const { pending } = await discoverArticles(dir);
    expect(pending.map((a) => a.slug)).toEqual(["aaa-pending-00000000"]);
  });
});
