import { type ArticleFrontmatter, type Block, splitBlocks } from "@tiro/shared";
import { readingMinutes } from "./reading-time.ts";

/**
 * Per-article facts the templates need that the contract does not carry,
 * derived at build time (ADR 0014). Structural input rather than the site's
 * `Article` so this stays testable without `astro:content`.
 */
export interface ArticleLike {
  frontmatter: ArticleFrontmatter;
  body: string;
  /** Already gated by `usableTranslation` — null when nothing vouches for it. */
  zhBody: string | null;
}

export type ArticleStatus =
  | "pending"
  | "zh-original"
  | "untranslated"
  | "translated";

/** Pending beats everything: a fresh clip has no `lang` to judge yet. */
export function articleStatus(frontmatter: ArticleFrontmatter): ArticleStatus {
  if (frontmatter.tiro.processed_at === undefined) return "pending";
  if (frontmatter.lang === "zh") return "zh-original";
  if (frontmatter.tiro.translation_failed === true) return "untranslated";
  return "translated";
}

export interface LiftedTitles {
  /** The translated title, when the body opens with an H1 that `zh.md`
   * mirrors — `zh.md` has no frontmatter, so this is the only place a
   * Chinese title can come from. */
  titleZh: string | null;
  /** The reader shows the title in its own block, so a body that opens with
   * an H1 would show it twice; when this is set the first row is skipped. */
  liftedH1: boolean;
}

// ATX H1 only: `# text`, optionally closed by ` #…`. A closing run must be
// preceded by whitespace (CommonMark), so "# Learn C#" keeps its "#".
const ATX_H1 = /^#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/s;

function h1Text(block: Block | undefined): string | null {
  if (block === undefined || block.type !== "heading") return null;
  const match = ATX_H1.exec(block.text.trim());
  return match === null ? null : (match[1] ?? "").trim();
}

export function liftTitles(body: string, zhBody: string | null): LiftedTitles {
  const bodyH1 = h1Text(splitBlocks(body)[0]);
  if (bodyH1 === null) return { titleZh: null, liftedH1: false };
  if (zhBody === null) return { titleZh: null, liftedH1: true };
  const zhH1 = h1Text(splitBlocks(zhBody)[0]);
  // Alignment says the zh first block is a heading too, but never drop a row
  // the translation pane would still need to show.
  if (zhH1 === null) return { titleZh: null, liftedH1: false };
  return { titleZh: zhH1, liftedH1: true };
}

export interface ArticleMeta extends LiftedTitles {
  minutes: number;
  status: ArticleStatus;
}

// `getArticles()` caches its array, so article identity is stable across the
// list pages and the reader — one derivation per article per build.
const cache = new WeakMap<ArticleLike, ArticleMeta>();

export function articleMeta(article: ArticleLike): ArticleMeta {
  let meta = cache.get(article);
  if (meta === undefined) {
    meta = {
      minutes: readingMinutes(article.body),
      status: articleStatus(article.frontmatter),
      ...liftTitles(article.body, article.zhBody),
    };
    cache.set(article, meta);
  }
  return meta;
}
