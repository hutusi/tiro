import {
  type ArticleFrontmatter,
  type Block,
  readingMinutes,
  splitBlocks,
} from "@tiro/shared";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

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

const parser = unified().use(remarkParse).use(remarkGfm);

/** The plain text of a block when it is an H1 (ATX or setext), else null.
 * Plain text, not source: `# Hello *AI*` is the title "Hello AI", and a
 * Chinese title lifted from `zh.md` must not show its emphasis markers. */
function h1Text(block: Block | undefined): string | null {
  if (block === undefined || block.type !== "heading") return null;
  const node = (parser.parse(block.text) as Root).children[0];
  if (node === undefined || node.type !== "heading" || node.depth !== 1) {
    return null;
  }
  return mdastToString(node).replace(/\s+/g, " ").trim();
}

/** Fold the differences a scraped `<title>` and a body heading disagree on
 * for no reason — curly quotes, dash widths, case, whitespace — so the
 * comparison in `liftTitles` asks "is this the same title" and nothing more. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Lift the body's opening H1 into the title block — only when it *is* the
 * title. A body may legitimately open with a section heading
 * (`# Introduction`); dropping that row would lose content and show its
 * translation as the article's Chinese title, so anything that does not match
 * `frontmatter.title` is left exactly where it is.
 */
export function liftTitles(
  body: string,
  zhBody: string | null,
  title: string,
): LiftedTitles {
  const bodyH1 = h1Text(splitBlocks(body)[0]);
  if (bodyH1 === null || normalizeTitle(bodyH1) !== normalizeTitle(title)) {
    return { titleZh: null, liftedH1: false };
  }
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
      ...liftTitles(article.body, article.zhBody, article.frontmatter.title),
    };
    cache.set(article, meta);
  }
  return meta;
}
