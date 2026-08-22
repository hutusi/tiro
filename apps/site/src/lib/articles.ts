import { getCollection } from "astro:content";
import {
  type ArticleFrontmatter,
  ArticleFrontmatterSchema,
} from "@tiro/shared";

export interface Article {
  /** "year/slug" */
  id: string;
  year: string;
  slug: string;
  frontmatter: ArticleFrontmatter;
  body: string;
  zhBody: string | null;
}

let cache: Article[] | null = null;

/** All articles, newest first, validated through the shared contract and
 * joined with their translations. Throws (failing the build) on any invalid
 * frontmatter and on an empty production collection — both are signs the
 * vault checkout or glob base is wrong, never something to ship silently. */
export async function getArticles(): Promise<Article[]> {
  if (cache !== null) return cache;
  const [entries, translations] = await Promise.all([
    getCollection("articles"),
    getCollection("translations"),
  ]);
  const zhById = new Map(translations.map((t) => [t.id, t.body ?? ""]));

  const articles = entries.map((entry): Article => {
    const frontmatter = ArticleFrontmatterSchema.parse(entry.data);
    const [year, slug] = entry.id.split("/");
    if (year === undefined || slug === undefined) {
      throw new Error(`unexpected article id: ${entry.id}`);
    }
    return {
      id: entry.id,
      year,
      slug,
      frontmatter,
      body: entry.body ?? "",
      zhBody: zhById.get(entry.id) ?? null,
    };
  });

  if (articles.length === 0 && import.meta.env.PROD) {
    throw new Error(
      "the articles collection is empty — refusing to build an empty site",
    );
  }

  articles.sort((a, b) =>
    b.frontmatter.clipped_at.localeCompare(a.frontmatter.clipped_at),
  );
  cache = articles;
  return articles;
}

export function articleUrl(article: Article): string {
  return `/articles/${article.year}/${article.slug}/`;
}
