import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVault, resetVaultCache } from "../src/lib/vault-read.ts";

const FIXTURE_COUNT = 8;
const PAIRED = "example-com-posts-hello-ai-e8446b12";
const SINGLE = "example-org-blog-raw-clip-b5de6fbd";

/** A throwaway vault, for the shapes the fixture vault must not contain. */
function makeVault(
  articles: Record<string, { index?: string; zh?: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "tiro-vault-read-"));
  for (const [slug, files] of Object.entries(articles)) {
    const articleDir = join(dir, "articles", slug);
    mkdirSync(articleDir, { recursive: true });
    if (files.index !== undefined) {
      writeFileSync(join(articleDir, "index.md"), files.index);
    }
    if (files.zh !== undefined)
      writeFileSync(join(articleDir, "zh.md"), files.zh);
  }
  return dir;
}

function withVault<T>(dir: string, run: () => T): T {
  const previous = process.env.TIRO_VAULT_DIR;
  process.env.TIRO_VAULT_DIR = dir;
  resetVaultCache();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TIRO_VAULT_DIR;
    else process.env.TIRO_VAULT_DIR = previous;
    resetVaultCache();
  }
}

const VALID = `---
url: "https://example.com/a"
title: "A"
domain: "example.com"
clipped_at: "2026-08-22T08:00:00.000Z"
tiro:
  schema: 1
---

Body.
`;

afterEach(() => {
  resetVaultCache();
});

describe("readVault", () => {
  test("reads every article in the fixture vault", () => {
    const entries = readVault();
    expect(entries).toHaveLength(FIXTURE_COUNT);
    expect(entries.map((e) => e.slug).sort()).toContain(PAIRED);
  });

  test("attaches zh.md when there is one, null when there is not", () => {
    const bySlug = new Map(readVault().map((e) => [e.slug, e]));
    expect(bySlug.get(PAIRED)?.zhBody).toContain("你好");
    expect(bySlug.get(SINGLE)?.zhBody).toBeNull();
  });

  test("validates frontmatter through the shared contract", () => {
    const entry = readVault().find((e) => e.slug === PAIRED);
    expect(entry?.frontmatter.url).toBe("https://example.com/posts/hello-ai");
    expect(entry?.frontmatter.domain).toBe("example.com");
  });

  test("strips the frontmatter block from the body", () => {
    const entry = readVault().find((e) => e.slug === PAIRED);
    expect(entry?.body.startsWith("---")).toBe(false);
    expect(entry?.body).not.toContain("clipped_at:");
  });

  // zh.md carries no frontmatter in this system, so it is read verbatim — a
  // translation opening with a thematic break must not lose its first lines.
  test("reads zh.md verbatim, including a leading thematic break", () => {
    const dir = makeVault({ a: { index: VALID, zh: "---\n\nTranslated.\n" } });
    try {
      const entry = withVault(dir, () => readVault())[0];
      expect(entry?.zhBody).toBe("---\n\nTranslated.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names the file when frontmatter will not parse", () => {
    const dir = makeVault({
      broken: { index: "---\nurl: 42\n---\n\nBody.\n" },
    });
    try {
      expect(() => withVault(dir, () => readVault())).toThrow(
        /broken.index\.md/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A stray directory is not an article; the glob loader ignored it too.
  test("skips a directory with no index.md", () => {
    const dir = makeVault({ a: { index: VALID }, "not-an-article": {} });
    try {
      expect(withVault(dir, () => readVault())).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Callers memoize off the identity of this array rather than repeating the
  // staleness check, so an unchanged vault must keep handing back the same one.
  test("returns the same array while the vault is unchanged", () => {
    expect(readVault()).toBe(readVault());
  });
});
