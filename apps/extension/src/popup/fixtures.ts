import type { Messages } from "../i18n.ts";
import type { PopupState } from "./view.ts";

/**
 * Canned states for eyeballing the popup outside a real clip:
 * `popup.html?state=<name>[&lang=zh]` in a development build
 * (`bun run build:dev`). UI sentences come from the selected message table so
 * the Chinese check is a Chinese page; article content stays as clipped.
 * Never bundled into a production build — popup.ts only imports this module
 * behind `__DEV_FIXTURES__`.
 */
const preview = {
  title: "Harness Engineering for Self-Improvement",
  host: "lilianweng.github.io",
  words: 6812,
  minutes: 28,
  excerpt:
    "Recursive self-improvement dates back to I. J. Good. This post looks at the harness around a model — orchestration, memory, tools — as the layer where most recent self-improvement research actually happens.",
  readabilityFailed: false,
  fromFetch: false,
};

const links = {
  site: "https://tiro.ainaive.com/articles/lilianweng-github-io-posts-2026-07-04-harness-2c589c36/",
  vault:
    "https://github.com/hutusi/tiro-vault/blob/main/articles/lilianweng-github-io-posts-2026-07-04-harness-2c589c36/index.md",
};

const base: PopupState = {
  phase: "ready",
  configured: true,
  preview,
  problem: null,
  clippedOn: null,
  updated: false,
  gated: false,
  fetchOffered: false,
  fetching: false,
  note: null,
  links: null,
};

export function fixtures(m: Messages): Record<string, PopupState> {
  return {
    reading: { ...base, phase: "reading", preview: null },
    ready: base,
    "ready-zh": {
      ...base,
      preview: {
        ...preview,
        title: "科技爱好者周刊（第 320 期）",
        host: "www.ruanyifeng.com",
        words: 2400,
        minutes: 6,
        excerpt:
          "本周话题：AI 编程助手对初级工程师就业的影响、几个值得关注的开源工具，以及读者来信精选。",
      },
    },
    "ready-raw": {
      ...base,
      preview: { ...preview, readabilityFailed: true, excerpt: "" },
    },
    already: { ...base, clippedOn: "Sep 2, 2026", links },
    clipping: { ...base, phase: "clipping" },
    saved: { ...base, phase: "saved", links },
    updated: { ...base, phase: "saved", updated: true, links },
    failed: {
      ...base,
      phase: "failed",
      problem: { text: m.errTokenInvalid, error: true },
    },
    unconfigured: {
      ...base,
      phase: "blocked",
      configured: false,
      problem: { text: m.settingsFirst, error: true },
    },
    pdf: {
      ...base,
      phase: "blocked",
      preview: null,
      problem: { text: m.cannotClipPdf, error: true },
    },
    "arxiv-offer": {
      ...base,
      preview: {
        ...preview,
        title: "KAN: Kolmogorov–Arnold Networks",
        host: "arxiv.org",
        words: 380,
        minutes: 2,
      },
      gated: true,
      fetchOffered: true,
    },
    "arxiv-fetching": { ...base, phase: "reading", fetching: true },
    "arxiv-abstract": {
      ...base,
      preview: { ...preview, host: "arxiv.org", fromFetch: true },
      note: m.arxivAbstractOnly,
    },
  };
}
