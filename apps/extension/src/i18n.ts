import { loadLanguage } from "./storage.ts";

export type Locale = "en" | "zh";

/** What the user picks in Settings: an explicit locale, or "auto" to follow
 * the browser's UI language. */
export type LanguageSetting = "auto" | Locale;

/** Chrome's own i18n system (`_locales/` + `chrome.i18n.getMessage`) always
 * follows the browser locale and cannot honor a per-extension override, so
 * the extension ships its own message tables. `en` is the master shape;
 * `Messages` derives from it so the compiler enforces key parity in `zh`. */
const en = {
  // Popup statuses
  settingsFirst: "Set your GitHub repository and token in Settings first.",
  cannotClip: "This page cannot be clipped.",
  readingPage: "Reading page…",
  cannotRead: (detail: string) => `Cannot read this page: ${detail}`,
  noClipResult: "The page did not produce a clip. Reload it and try again.",
  readyToClip: "Ready to clip.",
  alreadyClipped: (date: string) =>
    `Already clipped ${date} — clipping again updates it.`,
  clipping: "Clipping…",
  clipped: "Clipped.",
  updatedExisting: "Updated existing clip.",
  articleMeta: (host: string, words: number) => `${host} · ${words} words`,

  // Popup static text
  warningReadability:
    "Readability could not extract an article; clipping the raw page instead.",
  cannotClipPdf:
    "This is a PDF, not a web page — its text is rendered by a plugin the extension cannot read.",
  arxivOffer:
    "This is an arXiv paper. Tiro can fetch its HTML full text instead of this page.",
  arxivFetchButton: "Fetch HTML full text",
  arxivFetching: "Fetching the full text from arxiv.org…",
  arxivDenied:
    "Without access to arxiv.org, Tiro can only clip the page you are on.",
  arxivFailed: (detail: string) =>
    `Could not fetch the full text (${detail}); clipping this page instead.`,
  arxivAbstractOnly:
    "arXiv has no HTML full text for this paper; clipping its abstract page.",
  arxivNotice:
    "Fetched from arxiv.org to build this preview. Nothing is sent to your vault until you clip.",
  noticePreview:
    "Read in your browser to build this preview. Nothing is sent to your vault until you clip.",
  disclosureTitle: "Before Tiro reads this page",
  disclosureBody1:
    "To show you a preview, Tiro reads the open page in your browser — its article text, title, and address. For an arXiv paper it can fetch the HTML full text from arxiv.org instead, once you allow it.",
  disclosureBody2:
    "None of it is sent to your vault until you press “Clip to vault”, which commits it to the GitHub repository you configured. Close this popup without clipping and the result is discarded.",
  disclosureAccept: "I understand — continue",
  clipButton: "Clip to vault",
  reclipButton: "Re-clip to vault",
  viewInVault: "View in vault",
  settingsLink: "Settings",

  // Clip errors (describeClipError)
  errTokenInvalid:
    "GitHub token is invalid or expired — update it in Settings.",
  errRepoNotFound:
    "Repository or branch not found: check the repository and branch in Settings, and confirm the token can access the repository (a private repository the token cannot access also returns 404).",
  errForbidden:
    "GitHub refused the request (403): the token lacks permission or the rate limit was hit — try again later.",
  errHttp: (status: number) => `GitHub returned ${status} — try again later.`,
  errNetwork:
    "Network error: could not reach GitHub. Check your connection and try again.",
  errClipFailed: (detail: string) => `Clip failed: ${detail}`,

  // Options page
  optionsTitle: "Tiro Settings",
  labelOwner: "GitHub owner",
  ownerPlaceholder: "your GitHub username",
  labelRepo: "Vault repository",
  repoPlaceholder: "your vault repository name",
  labelBranch: "Branch",
  labelToken: "Fine-grained personal access token",
  tokenHint:
    "Scope the token to the vault repository only, with Contents: Read and write. It is stored in chrome.storage.local on this machine.",
  labelLanguage: "Language",
  langAuto: "Auto (browser language)",
  langEn: "English",
  langZh: "中文",
  saveButton: "Save",
  testButton: "Test connection",
  saved: "Saved.",
  couldNotSave: (detail: string) => `Could not save: ${detail}`,
  couldNotLoad: (detail: string) => `Could not load saved settings: ${detail}`,
  fieldOwner: "owner",
  fieldRepo: "repository",
  fieldToken: "token",
  fillFields: (fields: string[]) =>
    `Fill in the ${fields.join(", ")} field(s) first.`,
  testing: "Testing…",
  connOk: (fullName: string) => `Connected to ${fullName}`,
  connNotFound: "Repository not found (check name and token scope)",
  connUnauthorized: "Token rejected (401)",
  connHttp: (status: number) => `GitHub returned ${status}`,
  connNetwork: (detail: string) => `Network error: ${detail}`,
};

export type Messages = typeof en;

const zh: Messages = {
  settingsFirst: "请先在设置中配置 GitHub 仓库和令牌。",
  cannotClip: "此页面无法剪藏。",
  readingPage: "正在读取页面…",
  cannotRead: (detail: string) => `无法读取此页面：${detail}`,
  noClipResult: "页面未产生剪藏结果，请刷新页面后重试。",
  readyToClip: "可以剪藏了。",
  alreadyClipped: (date: string) => `已于 ${date} 剪藏过，再次剪藏将覆盖更新。`,
  clipping: "正在剪藏…",
  clipped: "已剪藏。",
  updatedExisting: "已覆盖更新原有剪藏。",
  articleMeta: (host: string, words: number) => `${host} · ${words} 词`,

  warningReadability: "Readability 未能提取正文，将剪藏原始页面。",
  cannotClipPdf: "这是 PDF 而非网页，其正文由插件渲染，扩展无法读取。",
  arxivOffer: "这是 arXiv 论文，Tiro 可以改为抓取其 HTML 全文。",
  arxivFetchButton: "抓取 HTML 全文",
  arxivFetching: "正在从 arxiv.org 抓取全文…",
  arxivDenied: "未获得 arxiv.org 访问权限，只能剪藏当前页面。",
  arxivFailed: (detail: string) =>
    `无法抓取全文（${detail}），改为剪藏当前页面。`,
  arxivAbstractOnly: "该论文没有 HTML 全文，改为剪藏摘要页。",
  arxivNotice:
    "已从 arxiv.org 抓取全文以生成预览。剪藏前不会向你的仓库发送任何内容。",
  noticePreview: "预览在你的浏览器中生成，剪藏前不会向你的仓库发送任何内容。",
  disclosureTitle: "在 Tiro 读取此页面之前",
  disclosureBody1:
    "为了生成预览，Tiro 会在你的浏览器中读取当前页面的正文、标题和网址。对于 arXiv 论文，在你授权后，它会改为从 arxiv.org 抓取该论文的 HTML 全文。",
  disclosureBody2:
    "在你点击「剪藏到仓库」之前，这些内容不会发送到你的仓库；点击后会提交到你配置的 GitHub 仓库。不剪藏直接关闭弹窗，结果即被丢弃。",
  disclosureAccept: "我知道了，继续",
  clipButton: "剪藏到仓库",
  reclipButton: "再次剪藏",
  viewInVault: "在仓库中查看",
  settingsLink: "设置",

  errTokenInvalid: "GitHub 令牌无效或已过期，请在设置中更新令牌。",
  errRepoNotFound:
    "找不到仓库或分支：请检查设置中的仓库名和分支，并确认令牌有权访问该仓库（无权访问的私有仓库也会返回 404）。",
  errForbidden:
    "GitHub 拒绝了请求（403）：令牌权限不足或已触发频率限制，请稍后再试。",
  errHttp: (status: number) => `GitHub 返回了 ${status}，请稍后重试。`,
  errNetwork: "网络错误：无法连接 GitHub，请检查网络后重试。",
  errClipFailed: (detail: string) => `剪藏失败：${detail}`,

  optionsTitle: "Tiro 设置",
  labelOwner: "GitHub 用户名",
  ownerPlaceholder: "你的 GitHub 用户名",
  labelRepo: "剪藏仓库",
  repoPlaceholder: "你的剪藏仓库名",
  labelBranch: "分支",
  labelToken: "细粒度个人访问令牌（PAT）",
  tokenHint:
    "令牌只需授权该仓库，权限为 Contents: Read and write。令牌保存在本机的 chrome.storage.local 中。",
  labelLanguage: "语言",
  langAuto: "自动（跟随浏览器）",
  langEn: "English",
  langZh: "中文",
  saveButton: "保存",
  testButton: "测试连接",
  saved: "已保存。",
  couldNotSave: (detail: string) => `保存失败：${detail}`,
  couldNotLoad: (detail: string) => `读取已保存的设置失败：${detail}`,
  fieldOwner: "用户名",
  fieldRepo: "仓库名",
  fieldToken: "令牌",
  fillFields: (fields: string[]) => `请先填写：${fields.join("、")}。`,
  testing: "正在测试…",
  connOk: (fullName: string) => `已连接到 ${fullName}`,
  connNotFound: "找不到仓库（请检查仓库名和令牌权限）",
  connUnauthorized: "令牌被拒绝（401）",
  connHttp: (status: number) => `GitHub 返回了 ${status}`,
  connNetwork: (detail: string) => `网络错误：${detail}`,
};

const tables: Record<Locale, Messages> = { en, zh };

export function resolveLocale(
  setting: LanguageSetting,
  uiLanguage: string,
): Locale {
  if (setting !== "auto") return setting;
  return uiLanguage.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** The stored setting resolved against the browser's UI language. */
export async function getLocale(): Promise<Locale> {
  return resolveLocale(await loadLanguage(), chrome.i18n.getUILanguage());
}

export function messages(locale: Locale): Messages {
  return tables[locale];
}

/** Date for the already-clipped status, in the locale's own convention
 * ("Aug 27, 2026" / "2026年8月27日"). */
export function formatClipDate(locale: Locale, iso: string): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
  }).format(new Date(iso));
}
