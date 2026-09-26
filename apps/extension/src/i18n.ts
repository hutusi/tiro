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
  articleMeta: (host: string, minutes: number, words: number) =>
    `${host} · ${minutes} min · ${words.toLocaleString("en")} words`,

  // Popup header labels — short, beside the wordmark; the sentences above
  // go under the card.
  labelSetUp: "Set up",
  labelCannotClip: "Cannot clip",
  labelReading: "Reading…",
  labelReady: "Ready",
  labelSavedOn: (date: string) => `Saved ${date}`,
  labelSaving: "Saving…",
  labelSaved: "Saved ✓",
  labelUpdated: "Updated ✓",
  labelFailed: "Failed",
  loadingExtract: "Extracting article text",
  loadingSave: "Saving to your vault…",
  openInTiro: "Open in Tiro →",
  openHint:
    "Appears on the site once processing finishes — usually a few minutes.",

  // Popup static text
  warningReadability:
    "Readability could not extract an article; clipping the raw page instead.",
  /**
   * Shown where a PDF has no HTML twin to fetch, in place of the refusal
   * this replaced.
   * The clip is real but the body is not built yet, and saying so is the
   * honest version: the reader is agreeing to an article that will look
   * different from a page clip — no figures, flattened equations (ADR 0026).
   */
  pdfWillBeConverted:
    "This is a PDF. Tiro will clip the link now and build the text when it processes — without figures, and with equations flattened.",
  /**
   * The one flow that reads a document instead of the tab, per publisher.
   * Grouped rather than prefixed so a third publisher adds a block instead of
   * seven more top-level keys, and so the popup picks a set by name rather
   * than by a switch that has to be found in three files.
   */
  fetchSources: {
    arxiv: {
      offer:
        "This is an arXiv paper. Tiro can fetch its HTML full text instead of this page.",
      button: "Fetch HTML full text",
      fetching: "Fetching the full text from arxiv.org…",
      denied:
        "Without access to arxiv.org, Tiro can only clip the page you are on.",
      failed: (detail: string) =>
        `Could not fetch the full text (${detail}); clipping this page instead.`,
      notice:
        "Fetched from arxiv.org to build this preview. Nothing is sent to your vault until you clip.",
      /** The fetch worked and returned something that is not the document. */
      partial:
        "arXiv has no HTML full text for this paper; clipping its abstract page.",
      /** Null where the tab's own body is a fair article under this slug: an
       * abstract page is the paper's canonical URL, so a fetch that cannot
       * happen costs a fuller body rather than the article. The behaviour is
       * `degradesToTab` in `fetch-source.ts`; this is only its sentence. */
      instead: null,
    },
    github: {
      offer:
        "This is a markdown file on GitHub. Tiro can fetch the file itself instead of this page.",
      button: "Fetch the markdown file",
      fetching: "Fetching the file from raw.githubusercontent.com…",
      denied:
        "Without access to raw.githubusercontent.com, Tiro cannot read the file itself.",
      failed: (detail: string) => `Could not fetch the file (${detail}).`,
      notice:
        "Fetched from raw.githubusercontent.com to build this preview. Nothing is sent to your vault until you clip.",
      /** Null because there is no partial answer: the file arrives or it does
       * not. */
      partial: null,
      /** Shown *instead of* enabling Clip. GitHub's rendering of a file is
       * filed under the file's own slug, so committing it would replace the
       * file's clip rather than add one (ADR 0023, clause 7). */
      instead: (rawUrl: string) =>
        `Clipping this page would replace the file's own clip with GitHub's rendering of it. Open ${rawUrl} and clip that instead.`,
    },
  },
  noticePreview:
    "Read in your browser to build this preview. Nothing is sent to your vault until you clip.",
  disclosureTitle: "Before Tiro reads this page",
  disclosureBody1:
    "To show you a preview, Tiro reads the open page in your browser — its article text, title, and address. For an arXiv paper, or a markdown file on GitHub, it can fetch the document itself — from arxiv.org or raw.githubusercontent.com — instead, once you allow it.",
  disclosureBody2:
    "None of it is sent to your vault until you press “Clip to vault”, which commits it to the GitHub repository you configured. Close this popup without clipping and the result is discarded. On a Tiro site — any page carrying Tiro's marker — the popup offers collections instead: a box you tick is kept, and committed to the same repository when you close the popup or press “Save now”, for an article it already holds. “Clip link to Tiro”, in a link's right-click menu, sends only that link's address to the same repository, the moment you choose it — the page itself is read later, by the processor in your repository, not by the extension. Your token and settings stay on this machine unless you turn on settings sync, which lets Chrome copy them to your other devices.",
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
    "Scope the token to the vault repository only, with Contents: Read and write. It is stored in chrome.storage.local on this machine, and also in chrome.storage.sync if you turn on settings sync.",
  labelLanguage: "Language",
  labelSync: "Sync settings across my devices",
  syncHint:
    "Stores these settings, token included, in your Chrome profile, so another computer signed into it needs no setup. Chrome copies them through Google's servers, and only while Chrome Sync is on for this profile and includes extensions — see chrome://settings/syncSetup, which a work or school profile can lock. Off unless you turn it on.",
  syncOn:
    "Settings sync is on. Your other computer should open Settings with this box already ticked; if it does not, Chrome is not syncing extension data there.",
  syncOff: "Settings sync is off — these settings stay on this computer.",
  syncedElsewhere:
    "These settings changed on another device. Reopen this page to load them.",
  syncRepaired:
    "Another device had left empty settings in the synced copy; this computer's have replaced them.",
  syncKeptEdits:
    "Your unsaved changes are still here — press Save to store them.",
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
  connTokenExpires: (date: string, days: number) =>
    `The token expires on ${date} (${days} ${days === 1 ? "day" : "days"} left).`,

  // "Clip link", from the context menu on a link (ADR 0034). The menu label is
  // short; the rest show as the toolbar button's tooltip beside its badge.
  linkMenu: "Clip link to Tiro",
  linkSaved: (url: string) => `Saved to Tiro — the next run clips it: ${url}`,
  linkExists: (url: string) => `Already in Tiro: ${url}`,
  linkNotALink: "Only http and https links can be saved.",
  linkUnconfigured: "Set your repository and token in Tiro's Settings first.",
  linkNoDisclosure:
    "Open Tiro from the toolbar once first — it says what it sends where.",
  linkFailed: (error: string) => `Could not save the link: ${error}`,
  connTokenExpiresSoon: (date: string, days: number) =>
    days < 1
      ? `The token expires today (${date}) — make a new one now.`
      : `The token expires in ${days} ${days === 1 ? "day" : "days"} (${date}) — make a new one soon.`,

  /**
   * Importing a PDF from disk (ADR 0027).
   *
   * The hint says what the article will be missing before anything is
   * committed, for the same reason the popup does on a web PDF: the reader is
   * agreeing to something that will not look like a page clip.
   */
  importHeading: "Import a PDF",
  importHint:
    "Reads the text out of a PDF on this computer and files it in your vault, unlisted. No figures, equations come through as plain text, and a scanned PDF cannot be read at all.",
  importButton: "Choose a PDF…",
  importReading: (name: string) => `Reading ${name}…`,
  importSaving: (name: string) => `Saving ${name} to your vault…`,
  importSaved: (name: string) =>
    `Imported ${name}. It appears once processing finishes.`,
  importUpdated: (name: string) =>
    `Re-imported ${name}, replacing what was there.`,
  importNotPdf: "That file is not a PDF.",
  importFailed: (detail: string) => `Could not import it: ${detail}`,
  importNeedsSettings: "Fill in your vault settings and save them first.",

  // Collections, on a Tiro page (ADR 0029)
  // "Tiro site", not "Your Tiro": the popup knows the page by its marker and
  // cannot tell whose site it is. Only a save checks that against the vault.
  labelTiroPage: "Tiro site",
  tiroArticleIntro:
    "Choose the collections this article belongs in. Only an article already in your vault can be added.",
  tiroSiteIntro:
    "This is a Tiro site. Open an article on it to add it to a collection.",
  /** Favorites before the vault has a `favorites.md` to title it. */
  favorites: "Favorites",
  collectionsLabel: "Collections",
  newCollectionPlaceholder: "New collection…",
  newCollectionAdd: "Add",
  clipAnyway: "Clip this page anyway",
  collectionsPending: (n: number) =>
    `${n === 1 ? "1 change" : `${n} changes`} not yet saved — saved when you close this popup.`,
  collectionsSaving: "Saving to your vault…",
  collectionsSyncNow: "Save now",
  collectionsSaved: "Saved to your vault. The site updates in a minute or two.",
  collectionsRefused: (n: number) =>
    `${n === 1 ? "1 change was" : `${n} changes were`} dropped: that article is not in your vault.`,
  collectionsFailed: (reason: string) =>
    `Could not save: ${reason} Your changes are kept and will be retried.`,
  /** A toggle the worker could not record, even after a retry. It lives only
   * in this popup until Save now records it, which the sentence has to say. */
  collectionsNotRecorded:
    "A change could not be recorded. Press Save now to try again — it is lost if you close this popup first.",
  /** Save now could not reach the extension's background worker. */
  collectionsSaveUnreachable:
    "Could not reach the extension to save. Your changes are kept; press Save now to try again.",
};

export type Messages = typeof en;

/** Publishers whose documents Tiro fetches rather than reads from the tab. */
export type FetchSourceKind = keyof Messages["fetchSources"];

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
  articleMeta: (host: string, minutes: number, words: number) =>
    `${host} · ${minutes} 分钟 · ${words} 词`,

  labelSetUp: "待设置",
  labelCannotClip: "无法剪藏",
  labelReading: "读取中…",
  labelReady: "可剪藏",
  labelSavedOn: (date: string) => `${date} 已剪藏`,
  labelSaving: "保存中…",
  labelSaved: "已保存 ✓",
  labelUpdated: "已更新 ✓",
  labelFailed: "失败",
  loadingExtract: "正在提取正文",
  loadingSave: "正在保存到你的仓库…",
  openInTiro: "在 Tiro 打开 →",
  openHint: "处理完成后会出现在站点上，通常需要几分钟。",

  warningReadability: "Readability 未能提取正文，将剪藏原始页面。",
  pdfWillBeConverted:
    "这是 PDF。Tiro 先剪藏链接，正文在处理时生成——没有插图，公式会被压平。",
  fetchSources: {
    arxiv: {
      offer: "这是 arXiv 论文，Tiro 可以改为抓取其 HTML 全文。",
      button: "抓取 HTML 全文",
      fetching: "正在从 arxiv.org 抓取全文…",
      denied: "未获得 arxiv.org 访问权限，只能剪藏当前页面。",
      failed: (detail: string) =>
        `无法抓取全文（${detail}），改为剪藏当前页面。`,
      notice:
        "已从 arxiv.org 抓取全文以生成预览。剪藏前不会向你的仓库发送任何内容。",
      partial: "该论文没有 HTML 全文，改为剪藏摘要页。",
      instead: null,
    },
    github: {
      offer: "这是 GitHub 上的 Markdown 文件，Tiro 可以改为抓取文件本身。",
      button: "抓取 Markdown 文件",
      fetching: "正在从 raw.githubusercontent.com 抓取文件…",
      denied: "未获得 raw.githubusercontent.com 访问权限，无法读取文件本身。",
      failed: (detail: string) => `无法抓取文件（${detail}）。`,
      notice:
        "已从 raw.githubusercontent.com 抓取文件以生成预览。剪藏前不会向你的仓库发送任何内容。",
      partial: null,
      instead: (rawUrl: string) =>
        `剪藏此页面会用 GitHub 的渲染结果覆盖该文件自身的剪藏。请打开 ${rawUrl} 并剪藏该页面。`,
    },
  },
  noticePreview: "预览在你的浏览器中生成，剪藏前不会向你的仓库发送任何内容。",
  disclosureTitle: "在 Tiro 读取此页面之前",
  disclosureBody1:
    "为了生成预览，Tiro 会在你的浏览器中读取当前页面的正文、标题和网址。对于 arXiv 论文或 GitHub 上的 Markdown 文件，在你授权后，它会改为从 arxiv.org 或 raw.githubusercontent.com 抓取文档本身。",
  disclosureBody2:
    "在你点击「剪藏到仓库」之前，这些内容不会发送到你的仓库；点击后会提交到你配置的 GitHub 仓库。不剪藏直接关闭弹窗，结果即被丢弃。在 Tiro 站点上（任何带有 Tiro 标记的页面），弹窗改为提供合集：你勾选的改动会被保留，并在关闭弹窗或点击「立即保存」时提交到同一个仓库——仅限仓库中已有的文章。在链接的右键菜单中选择「用 Tiro 剪藏链接」，只会立即把该链接的地址发送到同一个仓库——页面本身稍后由你仓库中的处理程序读取，而不是由扩展读取。除非你开启设置同步，你的令牌与设置只保存在本机；开启后由 Chrome 将它们复制到你的其他设备。",
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
    "令牌只需授权该仓库，权限为 Contents: Read and write。令牌保存在本机的 chrome.storage.local 中；若开启设置同步，则同时保存在 chrome.storage.sync 中。",
  labelLanguage: "语言",
  labelSync: "在我的设备间同步设置",
  syncHint:
    "把这些设置（含令牌）保存到你的 Chrome 账户中，登录同一账户的另一台电脑便无需再次配置。同步由 Chrome 经 Google 的服务器完成，且只在该账户已开启 Chrome 同步、并且同步范围包含扩展程序时才会发生——可在 chrome://settings/syncSetup 查看，单位或学校管理的账户可能已将其锁定。默认关闭，只有你亲自开启才会生效。",
  syncOn:
    "设置同步已开启。在另一台电脑上打开设置时，这个勾选框应当已经是勾上的；若没有，说明 Chrome 并未在那台电脑上同步扩展数据。",
  syncOff: "设置同步已关闭——这些设置只保存在本机。",
  syncedElsewhere: "这些设置已在其他设备上更改。重新打开本页即可载入。",
  syncRepaired: "其他设备在同步副本中留下了空的设置，已用本机的设置替换。",
  syncKeptEdits: "你未保存的修改仍保留在表单中——点击「保存」即可存下。",
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
  connTokenExpires: (date: string, days: number) =>
    `令牌将于 ${date} 到期（还有 ${days} 天）。`,

  linkMenu: "用 Tiro 剪藏链接",
  linkSaved: (url: string) => `已保存到 Tiro，下次运行时剪藏：${url}`,
  linkExists: (url: string) => `Tiro 里已有：${url}`,
  linkNotALink: "只能保存 http 和 https 链接。",
  linkUnconfigured: "请先在 Tiro 的设置中填写仓库和令牌。",
  linkNoDisclosure: "请先从工具栏打开一次 Tiro，它会说明会把什么发送到哪里。",
  linkFailed: (error: string) => `无法保存链接：${error}`,
  connTokenExpiresSoon: (date: string, days: number) =>
    days < 1
      ? `令牌今天（${date}）到期，请立即更换。`
      : `令牌将在 ${days} 天后（${date}）到期，请尽快更换。`,

  importHeading: "导入 PDF",
  importHint:
    "读取本机 PDF 中的文字并存入你的仓库，默认不公开列出。没有插图，公式会变成普通文本，扫描件无法读取。",
  importButton: "选择 PDF…",
  importReading: (name: string) => `正在读取 ${name}…`,
  importSaving: (name: string) => `正在保存 ${name} 到你的仓库…`,
  importSaved: (name: string) => `已导入 ${name}，处理完成后即可查看。`,
  importUpdated: (name: string) => `已重新导入 ${name}，覆盖了原有内容。`,
  importNotPdf: "该文件不是 PDF。",
  importFailed: (detail: string) => `导入失败：${detail}`,
  importNeedsSettings: "请先填写并保存仓库设置。",

  labelTiroPage: "Tiro 站点",
  tiroArticleIntro: "选择这篇文章所属的合集。只有你仓库中已有的文章才能加入。",
  tiroSiteIntro: "这是一个 Tiro 站点。打开其中一篇文章即可加入合集。",
  favorites: "收藏",
  collectionsLabel: "合集",
  newCollectionPlaceholder: "新建合集…",
  newCollectionAdd: "添加",
  clipAnyway: "仍要剪藏此页",
  collectionsPending: (n: number) =>
    `${n} 处改动尚未保存，关闭弹窗时自动保存。`,
  collectionsSaving: "正在保存到仓库…",
  collectionsSyncNow: "立即保存",
  collectionsSaved: "已保存到仓库，站点将在一两分钟内更新。",
  collectionsRefused: (n: number) =>
    `${n} 处改动已丢弃：你的仓库中没有这篇文章。`,
  collectionsFailed: (reason: string) =>
    `保存失败：${reason} 改动已保留，稍后会重试。`,
  collectionsNotRecorded:
    "有改动未能记下。请点击「立即保存」重试——若先关闭弹窗，这项改动将丢失。",
  collectionsSaveUnreachable:
    "无法连接扩展以保存。改动已保留，请点击「立即保存」重试。",
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
