import {
  needsProcessing,
  type ParsedArticle,
  parseArticle,
} from "@tiro/shared";

export interface DiscoveredArticle {
  year: string;
  slug: string;
  dirAbs: string;
  indexAbs: string;
  parsed: ParsedArticle;
}

export interface DiscoverOptions {
  slug?: string;
  force?: boolean;
}

/**
 * Scan the vault for articles to process. Selection is by the frontmatter
 * marker (`tiro.processed_at` absent), never by push diffs — idempotent and
 * retry-safe (ADR 0002). Invalid articles are reported, not thrown, so one
 * bad file can't wedge the whole pipeline.
 */
export async function discoverArticles(
  vaultDir: string,
  options: DiscoverOptions = {},
): Promise<{
  pending: DiscoveredArticle[];
  invalid: { path: string; error: string }[];
}> {
  const articlesDir = `${vaultDir}/articles`;
  const pending: DiscoveredArticle[] = [];
  const invalid: { path: string; error: string }[] = [];

  const relPaths = Array.from(
    new Bun.Glob("*/*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();
  for (const relPath of relPaths) {
    const [year, slug] = relPath.split("/");
    if (year === undefined || slug === undefined) continue;
    if (options.slug !== undefined && options.slug !== slug) continue;
    const indexAbs = `${articlesDir}/${relPath}`;
    try {
      const parsed = parseArticle(await Bun.file(indexAbs).text());
      if (options.force === true || needsProcessing(parsed.frontmatter)) {
        pending.push({
          year,
          slug,
          dirAbs: `${articlesDir}/${year}/${slug}`,
          indexAbs,
          parsed,
        });
      }
    } catch (error) {
      invalid.push({ path: indexAbs, error: String(error) });
    }
  }

  return { pending, invalid };
}
