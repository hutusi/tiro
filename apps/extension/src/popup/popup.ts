import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
import "./popup.css";
import { collectionId, readingMinutes, slugForUrl } from "@tiro/shared";
import { buildClipFile, tabSourceUrl } from "../clip.ts";
import {
  type ClipCandidate,
  clipReady,
  clipRefused,
  type FetchPolicy,
  isSourceBody,
  NO_FETCH,
  prefersCandidate,
} from "../clip-candidate.ts";
import { enqueue, type QueuedOp } from "../collection-queue.ts";
import type { FlushReport } from "../collections-worker.ts";
import { describeClipError } from "../errors.ts";
import { type FetchableSource, fetchableSource } from "../fetch-source.ts";
import { encodeBase64Utf8, findExistingIndex, putFile } from "../github.ts";
import {
  formatClipDate,
  getLocale,
  type Locale,
  type Messages,
  messages,
} from "../i18n.ts";
import {
  type ClipResultMessage,
  type CollectionMessage,
  isClipResult,
  POPUP_PORT,
} from "../messages.ts";
import {
  acceptDisclosure,
  type FlushStatus,
  isConfigComplete,
  lastClippedAt,
  loadCollectionQueue,
  loadConfig,
  loadDisclosure,
  loadFlushStatus,
  needsDisclosure,
  recordClip,
} from "../storage.ts";
import { parseTiroPage, readTiroMarker, type TiroPage } from "../tiro-page.ts";
import { countWords } from "../words.ts";
import {
  type CollectionsFooter,
  type CollectionsView,
  collectionsFooter,
  collectionsView,
  visibleQueue,
} from "./collections-view.ts";
import { createToggleChannel, type ToggleOp } from "./recorder.ts";
import {
  articleUrl,
  type Phase,
  type PopupLinks,
  type PopupState,
  type PopupView,
  popupView,
  vaultFileUrl,
} from "./view.ts";

const el = {
  label: document.getElementById("label") as HTMLSpanElement,
  disclosure: document.getElementById("disclosure") as HTMLElement,
  disclosureTitle: document.getElementById(
    "disclosure-title",
  ) as HTMLHeadingElement,
  disclosureBody1: document.getElementById(
    "disclosure-body-1",
  ) as HTMLParagraphElement,
  disclosureBody2: document.getElementById(
    "disclosure-body-2",
  ) as HTMLParagraphElement,
  accept: document.getElementById("accept") as HTMLButtonElement,
  loading: document.getElementById("loading") as HTMLElement,
  loadingCaption: document.getElementById(
    "loading-caption",
  ) as HTMLParagraphElement,
  preview: document.getElementById("preview") as HTMLElement,
  meta: document.getElementById("article-meta") as HTMLParagraphElement,
  title: document.getElementById("article-title") as HTMLHeadingElement,
  excerpt: document.getElementById("article-excerpt") as HTMLParagraphElement,
  warning: document.getElementById("warning") as HTMLParagraphElement,
  note: document.getElementById("note") as HTMLParagraphElement,
  notice: document.getElementById("notice") as HTMLParagraphElement,
  progress: document.getElementById("progress") as HTMLDivElement,
  progressCaption: document.getElementById(
    "progress-caption",
  ) as HTMLParagraphElement,
  message: document.getElementById("message") as HTMLParagraphElement,
  sourceFetch: document.getElementById("source-fetch") as HTMLButtonElement,
  clip: document.getElementById("clip") as HTMLButtonElement,
  saved: document.getElementById("saved") as HTMLDivElement,
  view: document.getElementById("view") as HTMLAnchorElement,
  open: document.getElementById("open") as HTMLAnchorElement,
  openHint: document.getElementById("open-hint") as HTMLParagraphElement,
  options: document.getElementById("options") as HTMLButtonElement,
  collections: document.getElementById("collections") as HTMLElement,
  collectionsIntro: document.getElementById(
    "collections-intro",
  ) as HTMLParagraphElement,
  collectionList: document.getElementById(
    "collection-list",
  ) as HTMLUListElement,
  collectionNew: document.getElementById("collection-new") as HTMLFormElement,
  collectionNewTitle: document.getElementById(
    "collection-new-title",
  ) as HTMLInputElement,
  collectionNewAdd: document.getElementById(
    "collection-new-add",
  ) as HTMLButtonElement,
  clipAnyway: document.getElementById("clip-anyway") as HTMLButtonElement,
  collectionSync: document.getElementById("collection-sync") as HTMLDivElement,
  collectionSyncText: document.getElementById(
    "collection-sync-text",
  ) as HTMLParagraphElement,
  syncNow: document.getElementById("sync-now") as HTMLButtonElement,
};

/** Paint a view. The only place the DOM is written after startup. */
function apply(view: PopupView): void {
  el.label.textContent = view.label;
  el.label.dataset.tone = view.labelTone;
  el.message.hidden = view.message === null;
  el.message.textContent = view.message ?? "";
  el.message.dataset.tone = view.messageTone;
  el.loading.hidden = view.loading === null;
  el.loadingCaption.textContent = view.loading ?? "";
  el.progress.hidden = view.progress === null;
  el.progressCaption.textContent = view.progress ?? "";
  el.preview.hidden = view.preview === null;
  if (view.preview !== null) {
    el.meta.textContent = view.preview.meta;
    el.title.textContent = view.preview.title;
    el.excerpt.hidden = view.preview.excerpt === null;
    el.excerpt.textContent = view.preview.excerpt ?? "";
    el.warning.hidden = view.preview.warning === null;
    el.warning.textContent = view.preview.warning ?? "";
    el.note.hidden = view.preview.note === null;
    el.note.textContent = view.preview.note ?? "";
    el.notice.textContent = view.preview.notice;
  }
  el.sourceFetch.hidden = !view.sourceFetch.visible;
  el.sourceFetch.textContent = view.sourceFetch.label;
  el.clip.hidden = !view.clip.visible;
  el.clip.disabled = !view.clip.enabled;
  el.clip.textContent = view.clip.label;
  el.clip.classList.toggle("btn-primary", view.clip.primary);
  el.clip.classList.toggle("btn-secondary", !view.clip.primary);
  el.saved.hidden = view.links === null;
  if (view.links !== null) {
    el.view.href = view.links.vault;
    el.open.href = view.links.site;
    el.openHint.hidden = !view.links.hint;
  }
}

/** Paint the queue's status line. Shown on any page while something is
 * pending, not only on a Tiro page. */
function applyCollectionFooter(footer: CollectionsFooter | null): void {
  el.collectionSync.hidden = footer === null;
  if (footer === null) return;
  el.collectionSyncText.textContent = footer.text;
  el.collectionSyncText.dataset.tone = footer.tone;
  el.syncNow.hidden = !footer.sync.visible;
  el.syncNow.disabled = !footer.sync.enabled;
}

/** Paint the collections panel. Rows are rebuilt from the view each time —
 * a handful of elements — and every title goes in as text: it came from a
 * page, and any page can claim to be a Tiro page. */
function applyCollections(view: CollectionsView): void {
  el.collections.hidden = false;
  el.collectionsIntro.textContent = view.intro;
  el.collectionList.hidden = view.rows === null;
  el.collectionNew.hidden = view.rows === null;
  el.collectionList.replaceChildren(
    ...(view.rows ?? []).map((row) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = row.checked;
      input.dataset.id = row.id;
      input.dataset.title = row.title;
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = row.title;
      const label = document.createElement("label");
      label.classList.toggle("favorite", row.favorite);
      label.classList.toggle("pending", row.pending);
      label.append(input, title);
      const item = document.createElement("li");
      item.append(label);
      return item;
    }),
  );
  applyCollectionFooter(view.footer);
}

el.options.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/** The HTML ships English defaults; localizing up front keeps the swap to a
 * single early paint instead of text changing under the user later. */
function localize(locale: Locale, m: Messages): void {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  el.disclosureTitle.textContent = m.disclosureTitle;
  el.disclosureBody1.textContent = m.disclosureBody1;
  el.disclosureBody2.textContent = m.disclosureBody2;
  el.accept.textContent = m.disclosureAccept;
  el.clip.textContent = m.clipButton;
  el.view.textContent = m.viewInVault;
  el.open.textContent = m.openInTiro;
  el.openHint.textContent = m.openHint;
  el.options.textContent = m.settingsLink;
  el.collectionNewTitle.placeholder = m.newCollectionPlaceholder;
  el.collectionNewAdd.textContent = m.newCollectionAdd;
  el.collectionList.setAttribute("aria-label", m.collectionsLabel);
  el.clipAnyway.textContent = m.clipAnyway;
  el.syncNow.textContent = m.collectionsSyncNow;
}

/**
 * What one fetch attempt has said. Session state lives in `main`'s other
 * bindings; everything here describes a single attempt and dies with it.
 */
interface Attempt {
  /** The fetch has run its course: succeeded, declined, or failed. */
  resolved: boolean;
  /** It came back with something that is not the document — an arXiv abstract
   * page. Says nothing about which body is on screen: the tab may still have
   * beaten it. */
  partial: boolean;
  /** A note that belongs beside the preview rather than in the status line,
   * which the next clip result would overwrite. Describes the outcome — a
   * declined permission, a failed fetch — so it outlives any one body, but not
   * the attempt that produced it. */
  note: string | null;
  /** The permission is not held and the offer has not been used. */
  offered: boolean;
}

function freshAttempt(): Attempt {
  return { resolved: false, partial: false, note: null, offered: false };
}

async function main(): Promise<void> {
  if (__DEV_FIXTURES__) {
    // A development build paints a canned state on request and stops there
    // — before any chrome.* call, so the page also works served from dist/
    // by a plain HTTP server. See fixtures.ts. Never reached in production:
    // the define is `false` and this branch, and the import, are removed.
    const params = new URLSearchParams(location.search);
    const name = params.get("state");
    const collectionsName = params.get("collections");
    if (collectionsName !== null) {
      const locale: Locale = params.get("lang") === "zh" ? "zh" : "en";
      const m = messages(locale);
      localize(locale, m);
      const { collectionFixtures } = await import("./fixtures.ts");
      const fixture = collectionFixtures(m)[collectionsName];
      el.label.textContent = m.labelTiroPage;
      el.clip.hidden = true;
      if (fixture !== undefined) applyCollections(collectionsView(fixture, m));
      else el.label.textContent = `no fixture "${collectionsName}"`;
      return;
    }
    if (name !== null) {
      const locale: Locale = params.get("lang") === "zh" ? "zh" : "en";
      const m = messages(locale);
      localize(locale, m);
      const { fixtures } = await import("./fixtures.ts");
      const fixture = fixtures(m)[name];
      if (fixture !== undefined) apply(popupView(fixture, m));
      else el.label.textContent = `no fixture "${name}"`;
      return;
    }
  }

  const [config, locale] = await Promise.all([loadConfig(), getLocale()]);
  const m = messages(locale);
  localize(locale, m);

  const configured = isConfigComplete(config);
  const homepage = chrome.runtime.getManifest().homepage_url;

  /* ---------------------------------------------- collections (ADR 0029) */

  /** This vault's queue as the popup last read it, or as it has just changed
   * it. The worker holds the truth and is the only writer; this is a copy. */
  let queue: QueuedOp[] = [];
  let flushStatus: FlushStatus | null = null;
  let syncing = false;
  let report: FlushReport | null = null;
  /** Set when the tab is a Tiro page and the popup is showing collections. */
  let tiroPage: TiroPage | null = null;
  /** Toggles sent and not yet answered. Re-reading the queue while one is in
   * flight would paint the worker's state from *before* it, and a checkbox the
   * reader just ticked would flick back. */
  let inFlight = 0;

  /** The last Save now could not reach the worker at all. */
  let saveUnreachable = false;

  async function refreshQueue(): Promise<void> {
    const [loaded, status] = await Promise.all([
      loadCollectionQueue(config),
      loadFlushStatus(config),
    ]);
    let next = visibleQueue(loaded, tiroPage, Date.now());
    // Without this a re-read would draw the worker's queue, which lacks these
    // toggles, and the tick would flick back with no word said — the silent
    // revert this list exists to prevent.
    for (const entry of channel.unrecorded()) {
      next = enqueue(next, entry.op, entry.published);
    }
    queue = next;
    flushStatus = status;
  }
  function paintCollections(): void {
    const s = {
      queue,
      status: flushStatus,
      syncing,
      report,
      unrecorded: channel.unrecorded().length,
      saveUnreachable,
    };
    if (tiroPage !== null) {
      applyCollections(collectionsView({ page: tiroPage, ...s }, m));
    } else {
      applyCollectionFooter(collectionsFooter(s, m));
    }
  }
  /** One message to the worker. Any way it can fail — a rejected send, no
   * answer, `ok: false` — comes back as null, so no caller can mistake a
   * failure for a success or leave a rejection unhandled. */
  async function send(
    message: CollectionMessage,
  ): Promise<{ ok: true; result?: unknown } | null> {
    try {
      const response = (await chrome.runtime.sendMessage(message)) as
        | { ok?: unknown; result?: unknown }
        | undefined;
      return response?.ok === true
        ? { ok: true, result: response.result }
        : null;
    } catch {
      return null;
    }
  }
  /**
   * Every toggle goes to the worker through this: in click order, newest per
   * article and collection decided at click time, and failures held here —
   * the popup cannot write the queue, the worker is its one writer — laid back
   * over every re-read and re-sent by Save now. Lost if the popup closes
   * first, which the footer says. See `createToggleChannel` for the races each
   * rule closes.
   */
  const channel = createToggleChannel(send);

  async function toggle(op: ToggleOp): Promise<void> {
    if (tiroPage?.kind !== "article") return;
    const page = tiroPage;
    const entry = {
      op,
      published: page.member.includes(op.collection),
      member: page.member,
    };
    // Drawn now, from the same function the worker will run, so the tick moves
    // under the reader's finger rather than after a round trip.
    queue = enqueue(queue, op, entry.published);
    report = null;
    // Handed over before painting: the channel releases a held toggle for this
    // pair at the click, and the footer should stop reporting it at once rather
    // than after this click's round trip.
    const recording = channel.toggle(entry);
    paintCollections();
    inFlight += 1;
    try {
      await recording;
    } finally {
      inFlight -= 1;
      if (inFlight === 0) {
        try {
          await refreshQueue();
        } catch {
          // The last drawn state stands; the next action re-reads.
        }
        paintCollections();
      }
    }
  }

  el.collectionList.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || tiroPage?.kind !== "article") {
      return;
    }
    const collection = input.dataset.id ?? "";
    // A title travels only with an op that may have to create the file — one
    // for a collection the site has not published. A catalog entry already
    // has its file, and its title there is the owner's.
    const listed = tiroPage.catalog.some((entry) => entry.id === collection);
    void toggle({
      id: crypto.randomUUID(),
      collection,
      slug: tiroPage.slug,
      action: input.checked ? "add" : "remove",
      at: new Date().toISOString(),
      ...(listed ? {} : { title: input.dataset.title ?? collection }),
    });
  });

  el.collectionNew.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = el.collectionNewTitle.value.trim();
    if (title === "" || tiroPage?.kind !== "article") return;
    el.collectionNewTitle.value = "";
    // Named after the typed title, the way the site will route it. A name that
    // folds onto an existing collection simply adds to that one.
    const collection = collectionId(title);
    const listed = tiroPage.catalog.some((entry) => entry.id === collection);
    void toggle({
      id: crypto.randomUUID(),
      collection,
      slug: tiroPage.slug,
      action: "add",
      at: new Date().toISOString(),
      ...(listed ? {} : { title }),
    });
  });

  el.syncNow.addEventListener("click", () => {
    void (async () => {
      syncing = true;
      saveUnreachable = false;
      paintCollections();
      try {
        // Anything this popup is still holding goes to the worker first — after
        // every toggle clicked before this press has had its turn — and a
        // flush now would save the queue without it and report success.
        if (!(await channel.retry())) return;
        const response = await send({ type: "tiro-collection-flush" });
        if (response === null) {
          saveUnreachable = true;
          report = null;
        } else {
          report = (response.result as FlushReport | null) ?? null;
        }
      } finally {
        syncing = false;
        try {
          await refreshQueue();
        } catch {
          // The last drawn state stands; the footer already says what failed.
        }
        paintCollections();
      }
    })();
  });

  if (configured) {
    // Held for the popup's lifetime and never used for messages: its
    // disconnect, when the popup closes, is what tells the worker to flush.
    chrome.runtime.connect({ name: POPUP_PORT });
    await refreshQueue();
    paintCollections();
  }

  let result: ClipResultMessage["payload"] | null = null;
  let clippedAt: string | null = null;
  /** Where the body on screen was read from, when that is not the article's own
   * URL — an arXiv paper read from its HTML full text. Becomes
   * `tiro.source_url`. Set by `offer`, so it always describes the body kept. */
  let sourceUrl: string | undefined;
  /** Non-null when this tab's document could be read from its publisher
   * instead of from the page — an arXiv paper, a GitHub markdown file. */
  let source: FetchableSource | null = null;
  /** Where the body on screen came from, so a second one is judged against it
   * rather than simply overwriting it. */
  let best: ClipCandidate | null = null;
  /**
   * Everything the current fetch attempt has said, replaced wholesale when a
   * new one begins.
   *
   * One value rather than four flags because "a new attempt begins" has to be
   * one assignment. As peers among the session-scoped state below they were
   * four, a retry reset one of them, and the other three went on describing an
   * attempt that had been superseded — the refusal painted over the retry's own
   * "Fetching…", and a successful retry still showed the denial that preceded
   * it. Nothing here outlives the attempt it belongs to.
   */
  let attempt: Attempt = freshAttempt();
  /** The injected clipper has reported, or cannot. Set on failure too — a tab
   * that will not read must not gate the button forever. */
  let tabResolved = false;
  /**
   * A commit has started, and has not failed.
   *
   * Both sources can still deliver while the upload runs, and a body arriving
   * then must change nothing: re-rendering would hand back a second Clip on top
   * of the one in flight — two PUTs to the same path — or relabel a finished
   * clip as ready. It stays set after success, so the screen keeps saying what
   * happened, and is cleared only on failure, the one case where pressing Clip
   * again is the right move.
   *
   * The late body is dropped rather than applied: the preview has to keep
   * describing what was committed. Reopening the popup clips it, which is the
   * "already clipped — clipping again updates it" path.
   */
  let committing = false;
  /** What the popup is doing, for the header label and the card underneath.
   * Without a configured vault nothing can be clipped, so the popup opens
   * blocked on the Settings instruction rather than "Reading…". */
  let phase: Phase = configured ? "reading" : "blocked";
  /** The sentence for a blocked or failed phase. */
  let problem: { text: string; error: boolean } | null = configured
    ? null
    : { text: m.settingsFirst, error: true };
  /** The publisher's copy is being fetched. Owned by `fetchDocument` alone —
   * nothing else may clear a flag describing work still in flight. */
  let fetching = false;
  /** Set once the upload has returned. */
  let saved: { updated: boolean; links: PopupLinks } | null = null;
  /** Local record: where a previous clip of this page landed. */
  let previousLinks: PopupLinks | null = null;

  function fetchPolicy(): FetchPolicy {
    return source === null
      ? NO_FETCH
      : { available: true, degradesToTab: source.degradesToTab };
  }

  /** Everything known, as the view model wants it. */
  function render(): void {
    const policy = fetchPolicy();
    const gated =
      result !== null &&
      !clipReady(best, policy, attempt.resolved, tabResolved);
    // Derived here rather than latched by whoever noticed, because the block
    // would not survive being latched: `settleFetch` ends in `showPayload`,
    // which sets `phase = "ready"` and clears `problem`, and so does every
    // late body after it. `render` is the only place the DOM is written once
    // the popup is running, so one expression covers every path — and reopens
    // on its own when a retry finally produces the document.
    //
    // Never over a commit: a body already on its way to the vault cannot be
    // refused, and repainting a finished clip as blocked would lose what
    // happened.
    const refusal = committing
      ? null
      : source === null || source.degradesToTab
        ? null
        : clipRefused(best, policy, attempt.resolved)
          ? source.instead
          : null;
    // The page is still read when unconfigured — the preview is harmless and
    // shows what Settings would unlock — but the phase stays blocked on the
    // Settings instruction however far the extraction gets.
    const setupBlocked =
      !configured && (phase === "reading" || phase === "ready");
    const state: PopupState = {
      phase: setupBlocked || refusal !== null ? "blocked" : phase,
      configured,
      // True only where the tab's PDF is the document: an arXiv PDF has an
      // HTML twin one click away, and offering to stub it would commit the
      // lesser body under the paper's own slug — the overwrite ADR 0023's
      // arbitration exists to prevent.
      pdfStub: result?.pdfViewer === true && source === null,
      preview:
        result === null || result.pdfViewer
          ? null
          : {
              title: result.title,
              host: new URL(result.url).hostname,
              words: countWords(result.markdown),
              minutes: readingMinutes(result.markdown),
              excerpt: result.excerpt,
              readabilityFailed: result.readabilityFailed,
              fromFetch: best?.fromFetch === true,
            },
      // Settings keep priority: a refusal the reader cannot act on until the
      // vault is configured is the wrong thing to put in front of them.
      problem: setupBlocked
        ? { text: m.settingsFirst, error: true }
        : refusal === null
          ? problem
          : { text: refusal, error: true },
      clippedOn: clippedAt === null ? null : formatClipDate(locale, clippedAt),
      updated: saved?.updated ?? false,
      source: source?.kind ?? null,
      gated,
      fetchOffered: attempt.offered,
      fetching,
      // "This is only the abstract" describes a body, not the session, so it
      // shows only while that body is the one that won. Without the second
      // condition it survived a tab full text beating the fetch, and told the
      // reader an abstract was about to be clipped while the full paper was on
      // screen.
      note:
        attempt.note ??
        (attempt.partial && best?.fromFetch === true && source !== null
          ? m.fetchSources[source.kind].partial
          : null),
      links: saved?.links ?? previousLinks,
    };
    apply(popupView(state, m));
  }

  /** A dead end: nothing more will happen on this page. */
  function block(text: string, error = true): void {
    phase = "blocked";
    problem = { text, error };
    render();
  }

  if (!configured) render();

  /**
   * Take a body if it beats the one in hand, and re-render.
   *
   * Both sources land here, and which wins is `prefersCandidate`'s decision
   * rather than the order they happen to arrive in.
   */
  function offer(
    payload: ClipResultMessage["payload"],
    fromFetch: boolean,
    source: string | undefined,
  ): void {
    if (committing) return;
    const candidate = { isSource: isSourceBody(payload), fromFetch };
    if (!prefersCandidate(best, candidate)) {
      // Still re-render: the losing arrival may have resolved the last source
      // the gate was waiting on. Only the gate — the phase is not this
      // arrival's to settle.
      render();
      return;
    }
    best = candidate;
    // Travels with the body, not beside it — a source URL left over from a
    // candidate that lost would describe a body nobody is going to commit.
    sourceUrl = source;
    showPayload(payload);
  }

  /**
   * Put a body on screen. Called only where there is a *new* body — a caller
   * that just wants the gate re-evaluated calls `render`, because this also
   * settles the phase, and doing that from a re-render wiped a failed commit's
   * error and offered Clip again over an article that had not been saved.
   */
  function showPayload(payload: ClipResultMessage["payload"]): void {
    if (committing) return;
    result = payload;
    // A PDF still has nothing to *preview* — its text is behind a plugin the
    // DOM cannot see — but it now has something to commit: a stub the
    // processor converts from the document's text layer (ADR 0026).
    //
    // Which of the two happens depends on whether a publisher offers an HTML
    // twin. Where one does, the fetch offer stands and the button stays shut,
    // because stubbing an arXiv PDF would file the lesser body under the
    // paper's own slug — the overwrite ADR 0023's arbitration exists to
    // prevent, and the reason this is not simply "PDFs are clippable now".
    // Where none does, the stub is the best there is, and refusing it was only
    // ever a statement about the extension's reach.
    if (payload.pdfViewer) {
      if (source !== null) {
        block(m.fetchSources[source.kind].offer, false);
        return;
      }
      // `ready` with no preview: the sentence comes from `pdfStub`, which says
      // plainly that the body arrives later and without figures.
      phase = "ready";
      problem = null;
      render();
      return;
    }
    // The whole point of the identity rule is that this article is the paper.
    // Committing the abstract page while its full text is one click away would
    // replace that full text — so the button waits for both sources (the view
    // computes the gate from the same facts).
    phase = "ready";
    problem = null;
    render();
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.id === undefined ||
    tab.url === undefined ||
    !/^https?:/.test(tab.url)
  ) {
    block(m.cannotClip);
    return;
  }
  const tabId = tab.id;
  const tabUrl = tab.url;

  /**
   * Registered below `tabId` so it can check one, and that is the whole reason
   * it sits here: a clipper injected by an earlier popup session in another tab
   * can still be extracting, and its result would otherwise drive this
   * preview — and the URL this commits under.
   */
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.tab?.id !== tabId || !isClipResult(message)) return;
    tabResolved = true;
    offer(message.payload, false, tabSourceUrl(message.payload.url));
  });

  let extracted = false;
  async function extract(): Promise<void> {
    // Idempotent: the arXiv fallbacks reach here after prepare() may already
    // have run it, and a second injection would deliver a second clip result.
    if (extracted) return;
    extracted = true;
    if (configured && result === null) {
      phase = "reading";
      render();
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["clipper.js"],
      });
    } catch (error) {
      // The tab has answered, even though the answer is "you cannot read me".
      // Without this the gate would wait on a source that will never report —
      // most likely on a PDF tab, where injection is least dependable.
      tabResolved = true;
      if (result !== null) {
        render();
        return;
      }
      block(m.cannotRead(String(error)));
      return;
    }

    // executeScript resolves when injection starts, not when the clipper
    // messages back; if the clipper dies mid-run the popup would otherwise sit
    // on "Reading…" forever.
    setTimeout(() => {
      // Only if the clipper never answered. This used to fire unconditionally,
      // so on a page that answered in 200 ms it still re-rendered ten seconds
      // later — re-enabling Clip on top of an upload already in flight, and
      // turning a finished "Clipped." back into "Ready to clip.".
      if (tabResolved) return;
      tabResolved = true;
      if (result === null) {
        block(m.noClipResult);
        return;
      }
      render();
    }, 10_000);
  }

  /**
   * Read the document from its publisher rather than from the tab.
   *
   * `askFirst` is false only when the permission is already held: a popup that
   * opens without a click has no user gesture, and `permissions.request`
   * refuses without one even when it would grant immediately.
   */
  async function fetchDocument(
    known: FetchableSource,
    askFirst: boolean,
  ): Promise<void> {
    // A new attempt invalidates everything the last one said, and paints
    // before anything can await — so the button is gone the instant it is
    // pressed, and the prompt window shows "Fetching…" rather than whatever the
    // failed attempt left on screen. Synchronous to here on purpose: an await
    // before `permissions.request` spends the user gesture it needs.
    attempt = freshAttempt();
    fetching = true;
    phase = "reading";
    render();

    const text = m.fetchSources[known.kind];
    if (askFirst) {
      let granted: boolean;
      try {
        granted = await chrome.permissions.request({ origins: [known.origin] });
      } catch (error) {
        // The offer was spent above. Without this the rejection is unhandled
        // and the button is left on screen with nothing behind it.
        await settleFetch(known, text.failed(String(error)));
        return;
      }
      if (!granted) {
        // Declining is an answer. The tab's own content is now the best body
        // available, so Clip stops waiting for one that is not coming.
        await settleFetch(known, text.denied);
        return;
      }
    }

    let clip: Awaited<ReturnType<FetchableSource["clip"]>>;
    try {
      clip = await known.clip();
    } catch (error) {
      await settleFetch(known, text.failed(String(error)));
      return;
    }
    // Only the fetch is guarded. Wrapping what follows reported a throw out of
    // rendering as "could not fetch the file" — over a preview of the file that
    // had arrived perfectly well — and ran a second settle for one attempt.
    fetching = false;
    attempt.resolved = true;
    attempt.partial = !isSourceBody(clip.payload);
    offer(clip.payload, true, clip.sourceUrl);
    // What came back is not the document — an arXiv abstract page, where the
    // paper had no HTML rendering. The tab may hold one this fetch could not
    // produce (ar5iv converts papers arxiv.org only stubs) and, on any host,
    // the tab is *proof* the content was retrievable where a transient failure
    // just said otherwise. So ask it, and let prefersCandidate judge. Asking
    // always is the point: an earlier version skipped arxiv.org tabs on the
    // grounds that the fetch had just targeted the identical URL, which is true
    // of the content and false of whether it arrived.
    if (attempt.partial) await extract();
  }

  /**
   * The fetch is over, one way or another.
   *
   * Where the publisher degrades, this falls back to whatever the tab holds and
   * stops gating Clip on a body that is not coming. Where it does not, the
   * refusal `render` derives takes over instead — and the offer comes back,
   * because a denial can be reconsidered and a failure retried, and refusing to
   * clip is only fair beside a way to undo it. Not re-offered for a publisher
   * that degrades: there the gate has just opened, and the button would flicker
   * on its way out.
   */
  async function settleFetch(
    known: FetchableSource,
    note: string,
  ): Promise<void> {
    attempt.resolved = true;
    attempt.note = note;
    fetching = false;
    if (!known.degradesToTab) attempt.offered = true;
    // A PDF tab has no preview, and a note reaches the DOM only inside the
    // preview card — so on that one shape the outcome goes in the message line
    // or is never seen at all. Before this it was replaced by the offer to
    // fetch, which is the thing that had just failed.
    if (result?.pdfViewer === true) {
      block(note);
      return;
    }
    if (result === null) {
      // No body yet: `extract` owns the phase from here, and when its latch is
      // already spent the phase it left — blocked on "cannot read", or the
      // refusal `render` derives — is the right one to keep.
      await extract();
    } else {
      // The attempt is over and a body is on screen, so the popup has stopped
      // reading. `fetchDocument` set that phase when the attempt began and
      // nothing else will take it back: the tab has already reported, so no
      // later body is coming to settle it. Leaving it is what disabled Clip
      // for good after a declined arXiv fetch.
      phase = "ready";
    }
    // Always, and never through `showPayload`: `extract` paints nothing once
    // its latch is spent, so a second failed fetch on a tab that cannot be
    // injected left the popup on "Fetching…" with no button and no timer left
    // to rescue it.
    render();
  }

  /**
   * One listener for the life of the popup, guarded by the offer itself.
   *
   * `fetchDocument` spends `attempt.offered` synchronously, so a second press
   * during the prompt or the fetch does nothing and at most one
   * `permissions.request` is ever in flight. Re-arming a `{ once: true }`
   * listener instead made "exactly one settle per click" load-bearing: two
   * settles without an intervening click left two listeners, and one press then
   * fired both.
   */
  el.sourceFetch.addEventListener("click", () => {
    if (!attempt.offered || source === null) return;
    void fetchDocument(source, true);
  });

  // Best-effort state from the local clip record. Slug derivation and the
  // lookup are both local, but they still wait for an accepted disclosure so
  // the popup does nothing at all before consent. Awaiting the lookup before
  // extraction means the clip-result listener always sees it settled. The
  // clip flow's own GitHub lookup stays the authority on overwrite-vs-create.
  /** The reader chose "Clip this page anyway" on a Tiro page. */
  let clipRequested = false;

  /** The tab as a Tiro page, or null for an ordinary one — including any page
   * the marker cannot be read from, which then clips exactly as before. */
  async function detectTiroPage(): Promise<TiroPage | null> {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readTiroMarker,
      });
      return parseTiroPage(injection?.result);
    } catch {
      return null;
    }
  }

  function enterCollections(page: TiroPage): void {
    tiroPage = page;
    el.label.textContent = m.labelTiroPage;
    el.label.dataset.tone = "neutral";
    // A Tiro site — whoever runs it — has nothing worth clipping, so the clip
    // controls go rather than sit disabled beside the toggles. "Clip this page
    // anyway" is there for the case where that is wrong.
    el.clip.hidden = true;
    el.sourceFetch.hidden = true;
    el.loading.hidden = true;
    el.message.hidden = true;
    paintCollections();
  }

  el.clipAnyway.addEventListener("click", () => {
    clipRequested = true;
    tiroPage = null;
    el.collections.hidden = true;
    el.clip.hidden = false;
    render();
    paintCollections();
    void prepare();
  });

  async function prepare(): Promise<void> {
    // Before anything is read for a preview. On a Tiro page the popup edits
    // collections instead of clipping, and recognizing one takes two DOM reads
    // in the tab — the same page read the disclosure already covers.
    if (configured && !clipRequested) {
      const page = await detectTiroPage();
      if (page !== null) {
        enterCollections(page);
        return;
      }
    }
    try {
      const slug = await slugForUrl(tabUrl);
      clippedAt = await lastClippedAt(config, slug);
      if (clippedAt !== null && homepage !== undefined) {
        previousLinks = {
          site: articleUrl(homepage, slug),
          vault: vaultFileUrl(config, `articles/${slug}/index.md`),
        };
      }
    } catch {
      clippedAt = null;
    }
    source = fetchableSource(tabUrl, m);
    if (source === null) {
      await extract();
      return;
    }
    const known = source;
    // Already granted: reading the publisher is then no different from reading
    // the tab, so it happens up front and the preview shows what will be
    // stored.
    if (await chrome.permissions.contains({ origins: [known.origin] })) {
      await fetchDocument(known, false);
      return;
    }
    // Not granted: nothing is fetched. The tab is previewed as usual and the
    // offer sits beside it, so the permission is asked for by an explicit act.
    attempt.offered = true;
    await extract();
  }

  el.clip.addEventListener("click", () => {
    if (result === null) return;
    // Both captured at the click, for one reason: `sourceUrl` describes the
    // body being committed, and reading it from the closure later would let a
    // body that arrived mid-upload retag the one already on its way.
    void (async (payload, from) => {
      committing = true;
      phase = "clipping";
      render();
      try {
        const nowIso = new Date().toISOString();
        // The lookup comes first now: the flat layout makes the slug — and so
        // the path — derivable without building the file, and a re-clip has to
        // read the old article's `unlisted` flag before it rebuilds `index.md`
        // over it (ADR 0017).
        const slug = await slugForUrl(payload.url);
        // A PDF tab commits a stub. Readability's reading of an <embed> is not
        // a body worth keeping, and the flags that describe one would be
        // claims about text nothing here has seen: `readability_failed` warns
        // about a raw body whose URLs were never absolutized, and `has_math`
        // promises an escaping pass that never ran (the reasoning ADR 0023
        // clause 10 sets out). The excerpt and author go for the same reason.
        const stub = payload.pdfViewer;
        const clip = {
          url: payload.url,
          sourceUrl: from,
          title: payload.title,
          markdown: stub ? "" : payload.markdown,
          excerpt: stub ? undefined : payload.excerpt,
          author: stub ? undefined : payload.author,
          readabilityFailed: stub ? undefined : payload.readabilityFailed,
          hasMath: stub ? undefined : payload.hasMath,
          ...(stub ? { sourceMedia: "pdf" as const } : {}),
          clippedAt: nowIso,
          clipperVersion: chrome.runtime.getManifest().version,
          clipperCommit: __CLIPPER_COMMIT__,
        };
        /**
         * A stub must not replace a body that is already there.
         *
         * A PDF clip carries no body and bets that the next processing run
         * builds one. Written over a converted article that bet costs the
         * article: if the fetch then fails, or the source has 404'd since, the
         * Markdown is gone from the vault's current state and this stage
         * cannot regenerate it — unlike an HTML re-clip, which replaces
         * content with content. So the old body rides along until a
         * conversion actually succeeds, and a failed reconversion costs
         * freshness instead (ADR 0026).
         *
         * Read from the same lookup `unlisted` uses, and carried on the same
         * principle: a re-clip rebuilds index.md from scratch, so anything it
         * cannot regenerate has to be carried or it is dropped.
         */
        const carryBody = (found: typeof existing) =>
          stub && found !== null ? { markdown: found.body } : {};
        const existing = await findExistingIndex(config, slug);
        const file = await buildClipFile({
          ...clip,
          ...carryBody(existing),
          unlisted: existing?.unlisted,
        });
        const path = file.path;
        await putFile(config, {
          path,
          contentBase64: encodeBase64Utf8(file.content),
          message: `clip: ${file.title}`,
          ...(existing !== null ? { sha: existing.sha } : {}),
          // A stale sha means something committed to this article between the
          // lookup above and this PUT. Retrying the bytes already built would
          // overwrite whatever it did — including, if it was a hand-edit
          // hiding the article, the `unlisted` flag this clip read as absent.
          // So the retry redoes the lookup and rebuilds against the answer.
          resolveConflict: async () => {
            const again = await findExistingIndex(config, slug);
            const rebuilt = await buildClipFile({
              ...clip,
              ...carryBody(again),
              unlisted: again?.unlisted,
            });
            return {
              ...(again !== null ? { sha: again.sha } : {}),
              contentBase64: encodeBase64Utf8(rebuilt.content),
            };
          },
        });
        saved = {
          updated: existing !== null,
          links: {
            site: articleUrl(
              homepage ?? "https://tiro.ainaive.com/",
              file.slug,
            ),
            vault: vaultFileUrl(config, path),
          },
        };
        phase = "saved";
        render();
        try {
          await recordClip(config, file.slug, nowIso);
        } catch {
          // The commit already succeeded; losing the hint record must not
          // relabel the clip as failed.
        }
      } catch (error) {
        console.error("clip failed:", error);
        committing = false;
        phase = "failed";
        problem = { text: describeClipError(error, m), error: true };
        render();
      }
    })(result, sourceUrl);
  });

  // The page is read to build the preview, which happens before the Clip
  // click — so the disclosure has to gate the extraction itself, not the
  // upload. A store listing or privacy page does not satisfy this; the consent
  // has to be in the product UI and has to be an explicit action.
  if (needsDisclosure(await loadDisclosure())) {
    el.disclosure.hidden = false;
    // Hide the (disabled) clip button meanwhile, so the panel's Continue is the
    // only button on screen and cannot be mistaken for it.
    el.clip.hidden = true;
    el.accept.addEventListener(
      "click",
      () => {
        void (async () => {
          await acceptDisclosure(new Date().toISOString());
          el.disclosure.hidden = true;
          el.clip.hidden = false;
          await prepare();
        })();
      },
      { once: true },
    );
    return;
  }

  await prepare();
}

void main();
