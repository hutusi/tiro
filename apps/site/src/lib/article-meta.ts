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
  /** Anchor ids carried by the lifted H1, unscoped, in document order — empty
   * unless `liftedH1`. Skipping that row would otherwise drop the only target
   * a `#top` link has, and an anchor lands on a heading only because something
   * links to it, so losing it is a guaranteed dead link (ADR 0024). The title
   * block re-emits them, which is why they are ids rather than markup: the
   * title is not rendered through `render.ts`, and nothing that bypasses the
   * sanitizer may carry clipped *markup* (invariant 5). */
  titleAnchors: string[];
  /** The same, for the lifted `zh.md` H1 — a separate list because the panes
   * are scoped apart and the translator may not have kept every anchor. */
  titleZhAnchors: string[];
}

/** Anchors as `placeAnchorsIn` writes them, which is the only shape that can
 * appear: a validated id in an empty span, never nested, never attributed. */
const ANCHOR_SPAN = /<span id="([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})"><\/span>/g;

function anchorIdsIn(block: Block | undefined): string[] {
  if (block === undefined) return [];
  return Array.from(block.text.matchAll(ANCHOR_SPAN), (m) => m[1] as string);
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
  // `includeHtml: false` because a clipped body's heading may carry an anchor
  // (ADR 0024), and mdast-util-to-string returns an `html` node's raw markup as
  // its value — so `# <span id="top"></span>Hello` stringified to the markup,
  // failed the title comparison, and silently stopped the lift: the reader then
  // printed the title twice and lost the Chinese one.
  return mdastToString(node, { includeHtml: false })
    .replace(/\s+/g, " ")
    .trim();
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
  const none = { titleAnchors: [], titleZhAnchors: [] };
  const bodyBlock = splitBlocks(body)[0];
  const bodyH1 = h1Text(bodyBlock);
  if (bodyH1 === null || normalizeTitle(bodyH1) !== normalizeTitle(title)) {
    return { titleZh: null, liftedH1: false, ...none };
  }
  const titleAnchors = anchorIdsIn(bodyBlock);
  if (zhBody === null) {
    return { titleZh: null, liftedH1: true, titleAnchors, titleZhAnchors: [] };
  }
  const zhBlock = splitBlocks(zhBody)[0];
  const zhH1 = h1Text(zhBlock);
  // Alignment says the zh first block is a heading too, but never drop a row
  // the translation pane would still need to show.
  if (zhH1 === null) return { titleZh: null, liftedH1: false, ...none };
  return {
    titleZh: zhH1,
    liftedH1: true,
    titleAnchors,
    titleZhAnchors: anchorIdsIn(zhBlock),
  };
}

export interface ArticleMeta extends LiftedTitles {
  minutes: number;
  status: ArticleStatus;
  /**
   * The summary in the article's own language — the counterpart to 摘要 in the
   * reader's title block, and null unless there is something for it to be the
   * counterpart *of*.
   */
  summaryOrig: string | null;
}

/**
 * The title the processor wrote, when there is one to trust.
 *
 * The `lang` guard is not redundant with the processor's own — the site reads a
 * hand-editable repo, and `usableTranslation` refuses `zh.md` on exactly these
 * grounds. A stray `title_zh` on a Chinese original would print the article's
 * title twice, once as the heading and once as its own translation.
 */
function storedTitleZh(frontmatter: ArticleFrontmatter): string | null {
  if (frontmatter.lang === "zh") return null;
  return frontmatter.title_zh ?? null;
}

/**
 * `summary_orig` is half of a pair, and shows only when the other half is there.
 *
 * Without a Chinese title above it the two summaries stop opposing each other:
 * side by side, `.zh.no-title` pads the Chinese one down to sit level with the
 * `h1` while this one sits below that `h1`; stacked, they become two paragraphs
 * labelled 摘要 with nothing between them. The article keeps the field either
 * way — a later run that produces a title makes it visible — but a half pair is
 * not a layout the reader has.
 *
 * Passing `titleZh` in rather than re-deriving it also carries the `lang` guard
 * for free: a Chinese original has no Chinese title, so it cannot show a second
 * same-language summary either.
 */
function pairedSummaryOrig(
  frontmatter: ArticleFrontmatter,
  titleZh: string | null,
): string | null {
  if (titleZh === null) return null;
  return frontmatter.summary_orig ?? null;
}

// `getArticles()` caches its array, so article identity is stable across the
// list pages and the reader — one derivation per article per build.
const cache = new WeakMap<ArticleLike, ArticleMeta>();

export function articleMeta(article: ArticleLike): ArticleMeta {
  let meta = cache.get(article);
  if (meta === undefined) {
    const lifted = liftTitles(
      article.body,
      article.zhBody,
      article.frontmatter.title,
    );
    const titleZh = storedTitleZh(article.frontmatter) ?? lifted.titleZh;
    meta = {
      minutes: readingMinutes(article.body),
      status: articleStatus(article.frontmatter),
      summaryOrig: pairedSummaryOrig(article.frontmatter, titleZh),
      // `liftedH1` is taken from `lifted` untouched, and must stay that way: it
      // answers "does the body repeat its own title", which has nothing to do
      // with where the Chinese title came from. Re-deriving it from
      // `titleZh !== null` would drop a `zh.md` row the translation pane still
      // needs — the case `liftTitles` refuses on purpose.
      ...lifted,
      // The stored title wins. The lifted one stays the fallback for articles
      // processed before `title_zh` existed (ADR 0016).
      titleZh,
    };
    cache.set(article, meta);
  }
  return meta;
}
