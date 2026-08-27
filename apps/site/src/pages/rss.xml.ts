import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { articleUrl, getArticles } from "../lib/articles.ts";
import { STRINGS } from "../lib/strings.ts";

/** Summary+link items only — the feed never carries clipped HTML, so the
 * sanitize pipeline (invariant 5) stays out of the picture. */
export async function GET(context: APIContext): Promise<Response> {
  const articles = await getArticles();
  return rss({
    title: STRINGS.siteTitle,
    description: STRINGS.siteDescription,
    site: context.site ?? "https://tiro.ainaive.com",
    customData: "<language>zh-CN</language>",
    items: articles.map((article) => {
      const description =
        article.frontmatter.summary ?? article.frontmatter.excerpt;
      return {
        title: article.frontmatter.title,
        link: articleUrl(article),
        pubDate: new Date(article.frontmatter.clipped_at),
        ...(description === undefined ? {} : { description }),
      };
    }),
  });
}
