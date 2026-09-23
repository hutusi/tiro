/** UI strings, centralized so switching the site language stays mechanical. */
export const STRINGS = {
  siteTitle: "Tiro",
  siteTagline: "个人稍后读知识库",
  siteDescription:
    "个人稍后读知识库：剪藏网页为 Markdown，自动摘要、打标签并翻译成中文，双语对照阅读。",
  /** The public repo — the header Star button and the footer both link here. */
  repoUrl: "https://github.com/hutusi/tiro",
  nav: {
    home: "首页",
    collections: "合集",
    search: "搜索与标签",
    settings: "设置",
  },
  /** The header's outbound Star link. Kept out of `nav`, which is iterated to
   * build the internal-page nav and carries active-page state. "Star" stays in
   * English because that is the word Chinese developers use; the sentence is
   * for `aria-label` and the hover title. */
  github: { star: "Star", label: "在 GitHub 上给 Tiro 点个 Star" },
  article: {
    original: "原文",
    translation: "中文",
    sideBySide: "左右对照",
    summary: "摘要",
    // The same label on the original's side of the pair, in its own language:
    // 摘要 twice was one word repeated, and the Chinese one sat on an English
    // paragraph. "Summary" rather than "Abstract" because the pipeline writes
    // this after the fact — an abstract is the author's own.
    summaryOriginal: "Summary",
    back: "← 返回",
    layoutLabel: "阅读布局",
    clippedAt: "剪藏于",
    publishedAt: "原文发布于",
    // A document imported off disk was never published, so the line above
    // would be a claim about it that is simply untrue (ADR 0027).
    importedFrom: "导入自",
    translatedDone: "全文已翻译完毕",
    noTranslation: "中文原文，无需翻译",
    misaligned: "译文与原文段落未对齐，以上下排列显示",
    // Shown on the article's own page only — by definition it appears in no
    // list — so it has to say what "unlisted" means, not just name it.
    unlisted: "未公开 · 仅通过链接访问",
    /** The share group. `share` is hidden unless the browser has a share
     * sheet, so on most desktops `copyLink` is the whole feature. */
    share: "分享",
    copyLink: "复制链接",
    copied: "已复制",
    copyFailed: "复制失败",
    /** The sticky way out to the publisher. Labelled with the domain, like the
     * two links to it that already exist in the page — and deliberately *not*
     * 原文, which is already a button in this toolbar meaning "show the
     * original-language column". */
    openSource: "在原站打开",
  },
  /** The `/s/<id>` alias pages, which exist only to bounce to an article.
   * Seen only when the edge redirect did not apply and JavaScript is off. */
  shortLink: {
    redirecting: "正在跳转…",
    open: "直接打开文章",
  },
  list: { empty: "还没有剪藏任何文章" },
  collections: {
    title: "合集",
    /** Favorites' title before the vault has a `favorites.md` to give it one. */
    favorites: "收藏",
    // Says what a collection *is*, because nothing else on the site does:
    // tags and categories are written by the model, and this is the one list
    // that was chosen by hand.
    intro: "手选的文章。标签与分类由模型给出，合集不是。",
    /** No collections in the vault at all. */
    empty: "还没有合集。",
    /** A collection that exists and holds nothing — what you get the moment
     * you create one, so it must not read like a failure. */
    emptyCollection: "这个合集还没有文章。",
    /** Leads the collection chips on an article's page. */
    memberOf: "收录于",
  },
  library: {
    title: "文章",
    viewLabel: "视图",
    viewList: "列表",
    viewCards: "卡片",
    pagerLabel: "分页",
    newer: "← 更新",
    older: "更早 →",
  },
  status: { pending: "待处理", zhOriginal: "中文原文", untranslated: "未翻译" },
  search: {
    title: "搜索与标签",
    placeholder: "搜索标题、正文、标签…",
    tags: "标签",
    categories: "分类",
    more: "显示更多",
    /** `{n}` is the number of matches not yet shown. */
    remaining: "还有 {n} 篇",
    retry: "加载失败，点击重试",
    devNotice: "搜索索引在构建后生成，开发模式下不可用。",
  },
  categories: { title: "分类" },
  notFound: {
    title: "页面不存在",
    hint: "这个地址没有对应的内容，可能已被移动或删除。",
    home: "返回首页",
    search: "搜索文章",
  },
  settings: {
    title: "设置",
    reading: "阅读",
    interface: "界面",
    layout: { label: "默认阅读布局", help: "打开有译文的文章时的排版" },
    libraryView: { label: "首页视图", help: "文章列表的默认排列" },
    width: {
      label: "版面宽度",
      help: "影响首页与左右对照；单栏正文的宽度固定不变",
      options: { compact: "紧凑", standard: "标准", wide: "宽" },
    },
    paper: {
      label: "纸色",
      help: "深色跟随系统，直到你在这里选定",
      options: { cream: "米色", white: "白色", dark: "深色" },
    },
    fontSize: {
      label: "正文字号",
      current: "当前",
      smaller: "缩小字号",
      larger: "放大字号",
      /** Shown in the reader's own type, so the size is visible while it is
       * being chosen. Both scripts, because the reader renders both. */
      sample: {
        en: "A clipped article reads here, at the size you choose.",
        zh: "剪藏的文章在这里以你选择的字号呈现。",
      },
    },
    note: "偏好只保存在这台浏览器的 localStorage 里，不会上传。",
  },
  footer: { privacy: "隐私政策", rss: "RSS" },
} as const;

/**
 * A clip date for list meta: "9 月 3 日" within the current year, the full
 * "2025 年 12 月 1 日" otherwise (spaces per CJK–Latin spacing convention).
 * UTC parts, the same basis as the ISO date the frontmatter records; `now`
 * is injectable so tests do not depend on the build date.
 */
export function dateLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  const day = `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`;
  return year === now.getUTCFullYear() ? day : `${year} 年 ${day}`;
}

export function minutesLabel(minutes: number): string {
  return `${minutes} 分钟`;
}

export function pageTitle(page: number): string {
  return `第 ${page} 页`;
}

export function pageNote(current: number, last: number, total: number): string {
  return `第 ${current} / ${last} 页 · 共 ${total} 篇`;
}

export function resultsLabel(count: number): string {
  return `${count} 篇结果`;
}

export function allTagsLabel(count: number): string {
  return `全部 ${count} 个标签`;
}
