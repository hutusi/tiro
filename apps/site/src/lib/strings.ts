/** UI strings, centralized so switching the site language stays mechanical. */
export const STRINGS = {
  siteTitle: "Tiro",
  siteTagline: "个人稍后读知识库",
  nav: { home: "首页", categories: "分类", tags: "标签", search: "搜索" },
  article: {
    original: "原文",
    translation: "译文",
    sideBySide: "对照",
    summary: "摘要",
    source: "查看原网页",
    clippedAt: "剪藏于",
    noTranslation: "中文原文，无需翻译",
    misaligned: "译文与原文段落未对齐，以上下排列显示",
  },
  list: { empty: "还没有剪藏任何文章" },
  search: {
    title: "搜索",
    devNotice: "搜索索引在构建后生成，开发模式下不可用。",
  },
  categories: { title: "分类" },
  tags: { title: "标签" },
} as const;
