import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCollections,
  readSites,
  readVault,
  resetVaultCache,
} from "../src/lib/vault-read.ts";

const FIXTURE_COUNT = 9;
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

  // The signature must be committed only after a read succeeds. Recording a
  // broken vault as "seen" would let the next read match it and hand back the
  // pre-edit articles — a malformed article reporting itself once, then
  // serving stale content as though it had been fixed.
  test("keeps throwing while an article stays malformed", () => {
    const dir = makeVault({ a: { index: VALID } });
    try {
      withVault(dir, () => {
        expect(readVault()).toHaveLength(1);
        writeFileSync(
          join(dir, "articles/a/index.md"),
          "---\nurl: 42\n---\n\nBroken.\n",
        );
        expect(() => readVault()).toThrow(/a.index\.md/);
        // The bug: this second call used to return the stale entry silently.
        expect(() => readVault()).toThrow(/a.index\.md/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Zod reports a pretty-printed JSON array; the error names each field on
  // one line instead, so a build log or deploy summary can be read.
  test("says which fields are wrong, on one line", () => {
    const dir = makeVault({
      broken: { index: VALID.replace("schema: 1", "schema: 1\nunlisted: yes") },
    });
    try {
      expect(() => withVault(dir, () => readVault())).toThrow(
        /broken.index\.md: unlisted: Invalid input: expected boolean, received string$/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("picks a repair back up", () => {
    const dir = makeVault({ a: { index: "---\nurl: 42\n---\n\nBroken.\n" } });
    try {
      withVault(dir, () => {
        expect(() => readVault()).toThrow();
        writeFileSync(join(dir, "articles/a/index.md"), VALID);
        expect(readVault()).toHaveLength(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a deploy that publishes what it can read (ADR 0048)", () => {
  const BROKEN = "---\nurl: 42\n---\n\nBroken.\n";

  /** Run with a skip report, returning what the read produced and the report. */
  function withReport<T>(
    dir: string,
    run: () => T,
  ): { value: T; report: string } {
    const report = join(dir, "skipped.txt");
    const previous = process.env.TIRO_SKIP_REPORT;
    process.env.TIRO_SKIP_REPORT = report;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const value = withVault(dir, run);
      return {
        value,
        report: existsSync(report) ? readFileSync(report, "utf8") : "",
      };
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.TIRO_SKIP_REPORT;
      else process.env.TIRO_SKIP_REPORT = previous;
    }
  }

  test("leaves a malformed article out and reports it, keeping the rest", () => {
    const dir = makeVault({
      good: { index: VALID },
      broken: { index: BROKEN },
    });
    try {
      const { value, report } = withReport(dir, () => readVault());
      expect(value.map((entry) => entry.slug)).toEqual(["good"]);
      // Vault-relative, one line per entry, so the deploy summary can list it.
      expect(report).toStartWith("articles/broken/index.md: url: ");
      expect(report.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves a broken or misnamed collection out and reports both", () => {
    const dir = makeVault({ good: { index: VALID } });
    try {
      mkdirSync(join(dir, "collections"));
      writeFileSync(
        join(dir, "collections", "reading.md"),
        '---\ntitle: "读"\ncreated_at: "2026-09-22T09:00:00.000Z"\nupdated_at: "2026-09-22T09:00:00.000Z"\nitems: []\ntiro:\n  schema: 1\n---\n',
      );
      writeFileSync(join(dir, "collections", "broken.md"), "no frontmatter\n");
      writeFileSync(
        join(dir, "collections", "Bad Name.md"),
        "---\ntitle: x\n---\n",
      );
      const { value, report } = withReport(dir, () => readCollections());
      expect(value.map((collection) => collection.id)).toEqual(["reading"]);
      expect(report).toContain("collections/broken.md: ");
      expect(report).toContain(
        "collections/Bad Name.md: not a usable collection id",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ADR 0055: a saved site that will not parse gets an article's treatment.
  test("leaves a broken site out and reports it, keeping the good one", () => {
    const dir = makeVault({ good: { index: VALID } });
    try {
      for (const [slug, text] of [
        [
          "map-1234abcd",
          '---\nurl: "https://maps.example.com/"\ntitle: "Map"\ndomain: "maps.example.com"\nclipped_at: "2026-10-20T08:00:00.000Z"\ntiro:\n  schema: 1\n---\n',
        ],
        ["broken-1234abcd", "---\ntitle: x\npreview: cover.png\n---\n"],
      ] as const) {
        mkdirSync(join(dir, "sites", slug), { recursive: true });
        writeFileSync(join(dir, "sites", slug, "index.md"), text);
      }
      const { value, report } = withReport(dir, () => readSites());
      expect(value.map((site) => site.slug)).toEqual(["map-1234abcd"]);
      expect(report).toContain("sites/broken-1234abcd/index.md: ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a report the build still fails on the first bad entry", () => {
    const dir = makeVault({
      good: { index: VALID },
      broken: { index: BROKEN },
    });
    try {
      expect(() => withVault(dir, () => readVault())).toThrow(
        /broken.index\.md/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readSites", () => {
  test("reads the fixture vault's saved site", () => {
    expect(readSites().map((site) => site.slug)).toEqual([
      "maps-example-org-roman-battles-facc4f75",
    ]);
  });

  // How every vault starts: not an error, and no guard either.
  test("a vault with no sites directory has no sites", () => {
    const dir = makeVault({});
    mkdirSync(join(dir, "articles"));
    try {
      expect(withVault(dir, () => readSites())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
