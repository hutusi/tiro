/**
 * An article's title: the headline the page displays (ADR 0042).
 *
 * Readability takes the title from the first source that has one, and JSON-LD
 * comes first. A publisher that writes one headline for search engines and
 * another for readers puts the search one there: The Atlantic's JSON-LD
 * `headline` and `<title>` say "I'm 53 years old. I'm 36 in my head." over an
 * article whose `<h1>`, `og:title` and `alternativeHeadline` all say "The
 * Puzzling Gap Between How Old You Are and How Old You Think You Are". 44 of
 * the vault's 97 Atlantic articles were filed under the headline nobody saw.
 *
 * The fix is not a better-ranked source. `og:title` is right for 40 of those
 * 44, but for "Masters of Love" it is the search headline too, and elsewhere
 * it carries a "| Site" suffix. Nor is it the `<h1>` alone: plenty of pages
 * spend theirs on a logo or a section name. It is the two together — an `<h1>`
 * the page's own metadata names as its headline, which neither a logo nor a
 * search headline can be.
 */

import {
  articleJsonLd,
  headlineText,
  hiddenWithin,
  metaContents,
  plainText,
  wordsOf,
} from "./page-claims.ts";

/** What a page says its title is, read before Readability consumes it. */
export interface TitleEvidence {
  /** Every non-empty `<h1>` the page shows, as the reader saw its text. */
  headlines: string[];
  /** The page's metadata titles, as plain text: `og:title`, `twitter:title`,
   * and every JSON-LD article's `headline`, `name` and `alternativeHeadline`.
   * Evidence only — never the title itself, since JSON-LD strings arrive with
   * their markup still in them. */
  claims: string[];
}

const TITLE_KEYS = ["headline", "name", "alternativeHeadline"] as const;

/**
 * A C1 control character: what Readability makes of a numeric reference into
 * the Windows-1252 range. It decodes `&#151;` with `fromCharCode`, where a
 * browser maps it to an em dash, so "How Google—and 104 Other Companies—Are"
 * was filed with U+0097 in place of each dash. No title means one.
 */
const C1 = /[\u0080-\u009f]/;

export function readTitleEvidence(doc: Document): TitleEvidence {
  const headlines: string[] = [];
  for (const h1 of Array.from(doc.querySelectorAll("h1"))) {
    // A hidden `<h1>` is not the headline the page displays, even when its
    // metadata names it: a sticky header's copy, a screen-reader-only heading,
    // or one of two responsive heroes. Taken, it could also win over the
    // visible one just by coming first.
    if (hiddenWithin(h1)) continue;
    const text = headlineText(h1);
    if (text !== "") headlines.push(text);
  }

  const claims = metaContents(doc, ["og:title", "twitter:title"]);
  for (const node of articleJsonLd(doc)) {
    for (const key of TITLE_KEYS) {
      const value = node[key];
      if (typeof value === "string") claims.push(value);
    }
  }
  return { headlines, claims: claims.map(plainText) };
}

/**
 * The title to file the article under: Readability's, unless the page shows a
 * headline its own metadata confirms and Readability's does not match it.
 *
 * Matching is by words — letters and digits, case-folded — so "Don't" and
 * "Don’t" are one headline. That is also why a title already matching an
 * `<h1>` is kept as it is rather than swapped for the `<h1>`'s text: six
 * corpus pages differ from their `<h1>` only in quote curl or case, and a re-clip
 * should not rewrite those for nothing. A title carrying a C1 character is the
 * exception, because there the `<h1>` is the same words spelled correctly.
 */
export function chooseTitle(title: string, evidence: TitleEvidence): string {
  const own = wordsOf(title);
  if (
    own !== "" &&
    !C1.test(title) &&
    evidence.headlines.some((headline) => wordsOf(headline) === own)
  ) {
    return title;
  }
  const claimed = new Set(
    [own, ...evidence.claims.map(wordsOf)].filter((words) => words !== ""),
  );
  return (
    evidence.headlines.find((headline) => claimed.has(wordsOf(headline))) ??
    title
  );
}

/** How X labels an Article's headline, the view that shows one in full, and
 * its text. */
const X_ARTICLE_TITLE = '[data-testid="twitter-article-title"]';
const X_ARTICLE_VIEW = '[data-testid="twitterArticleReadView"]';
const X_ARTICLE_TEXT = '[data-testid="twitterArticleRichTextView"]';

/**
 * An X Article's headline, taken out of the page so the body does not open by
 * repeating it (ADR 0043).
 *
 * X fits neither half of the rule above. Its headline is a `<div>`, not an
 * `<h1>` — the article's own section headings are the `<h1>`s — and the page a
 * browser renders carries no `og:title` and no JSON-LD, which X serves only to
 * crawlers. With nothing to confirm, Readability's title stands, and that is
 * the tab's: `(5) X` on an Article's own URL, the reader's unread count and the
 * site's name. All three X clips in the vault were filed under a tab title.
 *
 * X does label the headline, on `/article/` and `/status/` URLs alike. This
 * keys on that label rather than on the host, the way a Hacker News thread is
 * recognised (ADR 0038), so a page without it is untouched. Two guards:
 *
 * - **The label must sit in the view showing that Article's text**, as it did
 *   on all three pages measured. A post quoting an Article may preview it in
 *   a card, and that Article's title is not the post's.
 * - **Exactly one may be shown.** A page with several has no single headline.
 *
 * Removed, not just read. It sits in the same view as the text, so if
 * Readability ever takes that whole view as the article, the body would open
 * by repeating the title. None of the three did. Jensen Huang's Article does
 * open with its headline, but as the first paragraph of its own text: the
 * author's words, which the clip keeps.
 */
export function takeXArticleTitle(doc: Document): string | undefined {
  const shown = Array.from(doc.querySelectorAll(X_ARTICLE_TITLE)).filter(
    (element) =>
      element.closest(X_ARTICLE_VIEW)?.querySelector(X_ARTICLE_TEXT) != null &&
      !hiddenWithin(element),
  );
  const [only] = shown;
  if (only === undefined || shown.length > 1) return undefined;
  const text = headlineText(only);
  if (text === "") return undefined;
  only.remove();
  return text;
}
