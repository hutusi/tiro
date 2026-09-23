import type { QueuedOp } from "../collection-queue.ts";
import type { Messages } from "../i18n.ts";
import type { TiroPage } from "../tiro-page.ts";
import type { CollectionsState } from "./collections-view.ts";
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
  source: null,
  gated: false,
  fetchOffered: false,
  fetching: false,
  note: null,
  pdfStub: false,
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
      preview: null,
      pdfStub: true,
    },
    "arxiv-offer": {
      ...base,
      source: "arxiv",
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
    // The tab is Chrome's PDF viewer and the fetch is already running. The
    // verdict is about the tab, and the fetch is the only thing that can clear
    // it — so this must not sit on the offer to do what is in progress.
    "arxiv-pdf-fetching": {
      ...base,
      source: "arxiv",
      phase: "blocked",
      preview: null,
      problem: { text: m.fetchSources.arxiv.offer, error: false },
      fetching: true,
    },
    "arxiv-fetching": {
      ...base,
      source: "arxiv",
      phase: "reading",
      fetching: true,
    },
    "arxiv-abstract": {
      ...base,
      source: "arxiv",
      preview: { ...preview, host: "arxiv.org", fromFetch: true },
      note: m.fetchSources.arxiv.partial,
    },
    // The other publisher, in the two states its flow can be seen in. A
    // GitHub file has no partial answer to show: the bytes arrive or they
    // do not.
    "github-offer": {
      ...base,
      source: "github",
      preview: {
        ...preview,
        title: "Simple Made Easy",
        host: "github.com",
        words: 9600,
        minutes: 42,
      },
      gated: true,
      fetchOffered: true,
    },
    "github-fetching": {
      ...base,
      source: "github",
      phase: "reading",
      fetching: true,
    },
    // A retry in flight over the preview the refusal left on screen. The
    // caption is the whole point: before the attempt was reset wholesale, this
    // painted the refusal instead and the retry looked like it did nothing.
    "github-retrying": {
      ...base,
      source: "github",
      phase: "reading",
      preview: { ...preview, title: "Simple Made Easy", host: "github.com" },
      fetching: true,
    },
    // The dead end: the fetch answered and the file did not arrive, so the
    // rendering on screen is not something to commit. The offer comes back so
    // the denial can be reconsidered or the failure retried.
    "github-refused": {
      ...base,
      source: "github",
      phase: "blocked",
      preview: { ...preview, title: "Simple Made Easy", host: "github.com" },
      problem: {
        text: m.fetchSources.github.instead(
          "https://raw.githubusercontent.com/matthiasn/talk-transcripts/master/Hickey_Rich/SimpleMadeEasy.md",
        ),
        error: true,
      },
      note: m.fetchSources.github.denied,
      gated: true,
      fetchOffered: true,
    },
  };
}

/**
 * The popup on a Tiro page (ADR 0029), by name: `popup.html?collections=<name>`
 * in a `build:dev` build. Same contract as the clip fixtures above — painted
 * before any `chrome.*` call, so `dist/` served over plain HTTP shows them.
 */
export function collectionFixtures(
  m: Messages,
): Record<string, CollectionsState> {
  const at = "2026-09-22T10:00:00.000Z";
  const article: TiroPage = {
    kind: "article",
    slug: "example-net-papers-attention-notes-278b43cb",
    member: ["reading-notes"],
    catalog: [
      { id: "favorites", title: "收藏" },
      { id: "reading-notes", title: "重读清单" },
      { id: "empty-shelf", title: "空书架" },
    ],
  };
  const op = (
    id: string,
    collection: string,
    action: "add" | "remove",
    state: "pending" | "sent",
    title?: string,
  ): QueuedOp => ({
    id,
    collection,
    slug: article.slug,
    action,
    at,
    state,
    ...(title === undefined ? {} : { title }),
  });
  const idle = { status: null, syncing: false, report: null };
  // What every state has unless it says otherwise: nothing stranded in the
  // popup, and the last save reached the worker.
  const reached = { unrecorded: 0, saveUnreachable: false };
  const pending = [
    op("1", "favorites", "add", "pending"),
    op("2", "reading-notes", "remove", "pending"),
  ];
  const states: Record<
    string,
    Omit<CollectionsState, "unrecorded" | "saveUnreachable"> &
      Partial<Pick<CollectionsState, "unrecorded" | "saveUnreachable">>
  > = {
    article: { page: article, queue: [], ...idle },
    "no-favorites-yet": {
      page: { ...article, catalog: article.catalog.slice(1) },
      queue: [],
      ...idle,
    },
    pending: { page: article, queue: pending, ...idle },
    created: {
      page: article,
      queue: [op("3", "collection-4f1c2a9e", "add", "pending", "待读 · 长文")],
      ...idle,
    },
    saving: {
      page: article,
      queue: pending,
      status: null,
      syncing: true,
      report: null,
    },
    saved: {
      page: article,
      queue: [op("1", "favorites", "add", "sent")],
      status: { at, ok: true },
      syncing: false,
      report: { pending: 1, ok: true, committed: "c0ffee", refused: 0 },
    },
    refused: {
      page: article,
      queue: [],
      status: { at, ok: true, refused: 1 },
      syncing: false,
      report: { pending: 1, ok: true, committed: null, refused: 1 },
    },
    failed: {
      page: article,
      queue: pending,
      status: { at, ok: false, error: "Bad credentials", httpStatus: 401 },
      syncing: false,
      report: null,
    },
    site: { page: { kind: "site" }, queue: [], ...idle },
    "not-recorded": { page: article, queue: pending, ...idle, unrecorded: 1 },
    "save-unreachable": {
      page: article,
      queue: pending,
      ...idle,
      saveUnreachable: true,
    },
  };
  return Object.fromEntries(
    Object.entries(states).map(([name, state]) => [
      name,
      { ...reached, ...state },
    ]),
  );
}
