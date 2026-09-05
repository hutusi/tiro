/** UI strings, centralized so switching the site language stays mechanical. */
export const STRINGS = {
  siteTitle: "Tiro",
  siteTagline: "个人稍后读知识库",
  siteDescription:
    "个人稍后读知识库：剪藏网页为 Markdown，自动摘要、打标签并翻译成中文，双语对照阅读。",
  nav: { home: "首页", search: "搜索与标签", settings: "设置" },
  article: {
    original: "原文",
    translation: "中文",
    sideBySide: "左右对照",
    summary: "摘要",
    back: "← 返回",
    layoutLabel: "阅读布局",
    clippedAt: "剪藏于",
    publishedAt: "原文发布于",
    translatedDone: "全文已翻译完毕",
    noTranslation: "中文原文，无需翻译",
    misaligned: "译文与原文段落未对齐，以上下排列显示",
  },
  list: { empty: "还没有剪藏任何文章" },
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
    layout: { label: "默认阅读布局", help: "打开有译文的文章时的排版" },
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

export function readingAboutLabel(minutes: number): string {
  return `阅读约 ${minutes} 分钟`;
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
