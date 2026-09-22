import { describe, expect, test } from "bun:test";
import { checkAlignment, splitBlocks } from "../src/blocks.ts";
import { parseCollection } from "../src/collections.ts";
import { needsProcessing, parseArticle } from "../src/frontmatter.ts";
import { isValidCollectionId, slugForUrl } from "../src/slug.ts";

/**
 * The fixture vault anchors the content contract for the processor and site
 * test suites — every fixture article must itself honor the contract.
 */
const vaultDir = `${import.meta.dir}/../../../fixtures/vault`;
const articlesDir = `${vaultDir}/articles`;
const collectionsDir = `${vaultDir}/collections`;

const indexFiles = Array.from(
  new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
).sort();

describe("fixture vault", () => {
  test("contains the expected articles", () => {
    expect(indexFiles.length).toBeGreaterThanOrEqual(3);
    for (const expected of [
      "example-cn-posts-ai-times-0d21367e/index.md",
      "example-com-posts-hello-ai-e8446b12/index.md",
      // Processed, English, with a stored title_zh and a Chinese summary — but
      // no zh.md, because its translation was refused. The site renders it
      // single-pane while still holding a Chinese title, which is the one
      // combination every reader-mode rule has to survive.
      "example-dev-notes-a-clip-awaiting-retranslation-6d1b7b92/index.md",
      // The shape every live article has and no other fixture did: processed,
      // English, a stored title_zh, and a body that opens with a paragraph
      // rather than repeating its own title. The reader's two-column title
      // block is only exercised by this one.
      "example-io-notes-the-cost-of-a-second-opinion-e72f13a9/index.md",
      // Paired and translated, but with no title_zh and a body that does not
      // repeat its own title, so nothing can be lifted either. This was every
      // article in the vault before translated titles existed, and stays the
      // shape of any article whose title the model omitted.
      "example-org-essays-before-the-backfill-80754d43/index.md",
      "example-org-blog-raw-clip-b5de6fbd/index.md",
      // The only unlisted fixture: processed and complete, but flagged out of
      // every list, the search index and the sitemap. The site build against
      // this vault is what proves the flag actually removes it from each of
      // those surfaces while still rendering its page.
      "example-cn-notes-unlisted-shelf-8145cda3/index.md",
    ]) {
      expect(indexFiles).toContain(expected);
    }
  });

  test("contains no legacy year-nested articles", () => {
    // The flat glob above would silently ignore a stale
    // articles/<year>/<slug>/ fixture; enforce the flat layout explicitly.
    const nested = Array.from(
      new Bun.Glob("*/*/index.md").scanSync({ cwd: articlesDir }),
    );
    expect(nested).toEqual([]);
  });

  for (const relPath of indexFiles) {
    const [slug] = relPath.split("/");

    test(`${slug} honors the content contract`, async () => {
      const text = await Bun.file(`${articlesDir}/${relPath}`).text();
      const { frontmatter, body } = parseArticle(text);

      expect(await slugForUrl(frontmatter.url)).toBe(slug ?? "");
      expect(splitBlocks(body).length).toBeGreaterThan(0);

      const zhFile = Bun.file(`${articlesDir}/${slug}/zh.md`);
      if (await zhFile.exists()) {
        const alignment = checkAlignment(
          splitBlocks(body),
          splitBlocks(await zhFile.text()),
        );
        expect(alignment.errors).toEqual([]);
        expect(alignment.ok).toBe(true);
      }
    });
  }

  test("processing state markers are as expected", async () => {
    const raw = parseArticle(
      await Bun.file(
        `${articlesDir}/example-org-blog-raw-clip-b5de6fbd/index.md`,
      ).text(),
    );
    expect(needsProcessing(raw.frontmatter)).toBe(true);

    const processed = parseArticle(
      await Bun.file(
        `${articlesDir}/example-com-posts-hello-ai-e8446b12/index.md`,
      ).text(),
    );
    expect(needsProcessing(processed.frontmatter)).toBe(false);
  });
});

const collectionFiles = Array.from(
  new Bun.Glob("*.md").scanSync({ cwd: collectionsDir }),
).sort();

describe("fixture collections", () => {
  test("contains the expected collections", () => {
    expect(collectionFiles).toEqual([
      // No items. What a collection looks like the moment it is created, and
      // the only fixture that renders a collection page's empty state.
      "empty-shelf.md",
      // Holds the unlisted fixture on purpose. A collection page joins through
      // the listed funnel, so this is what proves an unlisted member stays out
      // of a public list while its own page still renders.
      "favorites.md",
      // A prose body, a description, and one item with no `added_at` — the
      // shape a hand-written collection has, which the extension never emits.
      "reading-notes.md",
    ]);
  });

  for (const relPath of collectionFiles) {
    const id = relPath.replace(/\.md$/, "");

    test(`${id} honors the collection contract`, async () => {
      const parsed = parseCollection(
        id,
        await Bun.file(`${collectionsDir}/${relPath}`).text(),
      );
      expect(isValidCollectionId(id)).toBe(true);

      const slugs = parsed.frontmatter.items.map((item) => item.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) {
        // A dangling member would render as a missing row rather than an
        // error, so the fixture vault has to be the one place it cannot
        // happen — `validate` enforces the same rule on a real vault.
        expect(indexFiles).toContain(`${slug}/index.md`);
      }
    });
  }
});
