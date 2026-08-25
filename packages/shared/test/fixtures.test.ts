import { describe, expect, test } from "bun:test";
import { checkAlignment, splitBlocks } from "../src/blocks.ts";
import { needsProcessing, parseArticle } from "../src/frontmatter.ts";
import { slugForUrl } from "../src/slug.ts";

/**
 * The fixture vault anchors the content contract for the processor and site
 * test suites — every fixture article must itself honor the contract.
 */
const articlesDir = `${import.meta.dir}/../../../fixtures/vault/articles`;

const indexFiles = Array.from(
  new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
).sort();

describe("fixture vault", () => {
  test("contains the expected articles", () => {
    expect(indexFiles.length).toBeGreaterThanOrEqual(3);
    for (const expected of [
      "example-cn-posts-ai-times-0d21367e/index.md",
      "example-com-posts-hello-ai-e8446b12/index.md",
      "example-org-blog-raw-clip-b5de6fbd/index.md",
    ]) {
      expect(indexFiles).toContain(expected);
    }
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
