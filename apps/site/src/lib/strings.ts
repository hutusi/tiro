/** UI strings, centralized so switching the site language stays mechanical. */
export const STRINGS = {
  siteTitle: "Tiro",
  siteTagline: "个人稍后读知识库",
  siteDescription:
    "个人稍后读知识库：剪藏网页为 Markdown，自动摘要、打标签并翻译成中文，双语对照阅读。",
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
  notFound: {
    title: "页面不存在",
    hint: "这个地址没有对应的内容，可能已被移动或删除。",
    home: "返回首页",
    search: "搜索文章",
  },
  footer: { privacy: "隐私政策", rss: "RSS 订阅" },
} as const;

/** "2026-08" → "2026 年 8 月" (spaces per CJK–Latin spacing convention). */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${year} 年 ${Number(m)} 月`;
}
