import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { articleUrl, getArticles } from "../lib/articles.ts";
import { STRINGS } from "../lib/strings.ts";

/**
 * How many of the newest articles the feed carries. A feed is polled, often
 * hourly, by every reader subscribed to it, and it used to list every article:
 * 436 items, 634 KB, fetched in full on each poll. A reader keeps the items it
 * has already seen, so the feed only needs to reach back far enough to cover a
 * reader that polls weekly. In October 2026 the vault took in about 13
 * articles a day, so a hundred is about a week. Fifty would have been three
 * days.
 */
export const FEED_ITEMS = 100;

/** Summary+link items only — the feed never carries clipped HTML, so the
 * sanitize pipeline (invariant 5) stays out of the picture. */
export async function GET(context: APIContext): Promise<Response> {
  // No fallback domain here on purpose: astro.config.mjs is the single place
  // the domain lives, and losing it should fail the build loudly rather than
  // ship feed links on a stale host.
  if (context.site === undefined) {
    throw new Error("astro.config `site` is required to build the RSS feed");
  }
  // Newest first already, so the slice is the latest ones.
  const articles = (await getArticles()).slice(0, FEED_ITEMS);
  return rss({
    title: STRINGS.siteTitle,
    description: STRINGS.siteDescription,
    site: context.site,
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
