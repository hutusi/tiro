import {
  needsProcessing,
  type ParsedArticle,
  parseArticle,
} from "@tiro/shared";

export interface DiscoveredArticle {
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
 *
 * Returned cheapest-first — see the sort below for why the order matters.
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
    new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();
  for (const relPath of relPaths) {
    const [slug] = relPath.split("/");
    if (slug === undefined) continue;
    if (options.slug !== undefined && options.slug !== slug) continue;
    const indexAbs = `${articlesDir}/${relPath}`;
    try {
      const parsed = parseArticle(await Bun.file(indexAbs).text());
      if (options.force === true || needsProcessing(parsed.frontmatter)) {
        pending.push({
          slug,
          dirAbs: `${articlesDir}/${slug}`,
          indexAbs,
          parsed,
        });
      }
    } catch (error) {
      invalid.push({ path: indexAbs, error: String(error) });
    }
  }

  // Cheapest first. Translation cost is roughly linear in body length, and a
  // run has a finite budget: under the old alphabetical order one 170 KB paper
  // ran first on every push, consumed the entire budget without finishing, and
  // starved every article behind it — articles that would each have taken two
  // minutes sat unprocessed for days. Sorting by size cannot prevent a
  // pathological article from failing, but it does confine the damage to that
  // article. Slug breaks ties so the order stays deterministic; the comparison
  // is codepoint-wise rather than locale-aware for the same reason.
  pending.sort(
    (a, b) =>
      a.parsed.body.length - b.parsed.body.length ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );

  return { pending, invalid };
}
