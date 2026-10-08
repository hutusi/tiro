import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "../ui/tokens.css";
import "./popup.css";
import {
  collectionId,
  readingMinutes,
  slugForUrl,
  sourceUrlOf,
} from "@tiro/shared";
import {
  type ClipCandidate,
  clipReady,
  clipRefused,
  type FetchPolicy,
  hasNothingToClip,
  isSourceBody,
  NO_FETCH,
  prefersCandidate,
  refusesAsEmpty,
} from "../clip-candidate.ts";
import { commitClip, type Snapshot } from "../clip-commit.ts";
import { enqueue, type QueuedOp } from "../collection-queue.ts";
import { readClipCollections } from "../collections-read.ts";
import type { FlushReport } from "../collections-worker.ts";
import { describeClipError, describeRemoveError } from "../errors.ts";
import { type FetchableSource, fetchableSource } from "../fetch-source.ts";
import {
  type BodyOrigin,
  type CaptureEffects,
  captureFigures,
  cropAndEncode,
  FRAME_OPTIONS,
  figuresShown,
  isSameBody,
} from "../figure-capture.ts";
import {
  beginCapture,
  endCapture,
  type FrameResult,
  frameFigure,
  setSnapshotRequest,
} from "../figure-scout.ts";
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
import { lookupArticle, removeArticle } from "../remove-article.ts";
import {
  acceptDisclosure,
  type FlushStatus,
  forgetClip,
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
  type AfterClip,
  type ArticlePage,
  afterClipView,
  type CollectionsFooter,
  type CollectionsView,
  collectionsFooter,
  collectionsView,
  visibleQueue,
} from "./collections-view.ts";
import { createToggleChannel, type ToggleOp } from "./recorder.ts";
import type { RemovalState, RemovalView } from "./removal-view.ts";
import {
  articleUrl,
  type CaptureState,
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
  captureRow: document.getElementById("capture-row") as HTMLDivElement,
  captureHint: document.getElementById("capture-hint") as HTMLParagraphElement,
  capture: document.getElementById("capture") as HTMLButtonElement,
  captureStop: document.getElementById("capture-stop") as HTMLButtonElement,
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
  collectionSync: document.getElementById("collection-sync") as HTMLDivElement,
  collectionSyncText: document.getElementById(
    "collection-sync-text",
  ) as HTMLParagraphElement,
  syncNow: document.getElementById("sync-now") as HTMLButtonElement,
  remove: document.getElementById("remove") as HTMLElement,
  removeOffer: document.getElementById("remove-offer") as HTMLButtonElement,
  removeOfferLabel: document.getElementById(
    "remove-offer-label",
  ) as HTMLSpanElement,
  removeConfirm: document.getElementById("remove-confirm") as HTMLDivElement,
  removeHeading: document.getElementById(
    "remove-heading",
  ) as HTMLHeadingElement,
  removeTitle: document.getElementById("remove-title") as HTMLParagraphElement,
  removeNote: document.getElementById("remove-note") as HTMLParagraphElement,
  removeCancel: document.getElementById("remove-cancel") as HTMLButtonElement,
  removeConfirmButton: document.getElementById(
    "remove-confirm-button",
  ) as HTMLButtonElement,
  removeStatus: document.getElementById(
    "remove-status",
  ) as HTMLParagraphElement,
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
    el.notice.hidden = view.preview.notice === null;
    el.notice.textContent = view.preview.notice ?? "";
  }
  el.sourceFetch.hidden = !view.sourceFetch.visible;
  el.sourceFetch.textContent = view.sourceFetch.label;
  el.captureRow.hidden = !view.capture.visible && !view.captureStop.visible;
  el.capture.hidden = !view.capture.visible;
  el.capture.textContent = view.capture.label;
  el.captureHint.hidden = view.capture.hint === null;
  el.captureHint.textContent = view.capture.hint ?? "";
  el.captureStop.hidden = !view.captureStop.visible;
  el.captureStop.textContent = view.captureStop.label;
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
  applyRemoval(view.remove);
}

/** Paint Remove from Tiro (ADR 0036), the same in both modes: the link in the
 * footer, and the card or status line above it. The title goes in as text:
 * it came from the vault, and before that the slug came from a page. */
function applyRemoval(view: RemovalView): void {
  el.removeOffer.hidden = !view.offer.visible;
  el.removeOfferLabel.textContent = view.offer.label;
  el.removeOffer.title = view.offer.hint;
  el.remove.hidden = view.confirm === null && view.status === null;
  el.removeConfirm.hidden = view.confirm === null;
  if (view.confirm !== null) {
    el.removeHeading.textContent = view.confirm.heading;
    el.removeTitle.hidden = view.confirm.title === null;
    el.removeTitle.textContent = view.confirm.title ?? "";
    el.removeNote.textContent = view.confirm.note;
    el.removeConfirmButton.textContent = view.confirm.confirmLabel;
    el.removeCancel.textContent = view.confirm.cancelLabel;
  }
  el.removeStatus.hidden = view.status === null;
  el.removeStatus.textContent = view.status?.text ?? "";
  el.removeStatus.dataset.tone = view.status?.tone ?? "neutral";
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
  if (view.label !== null) {
    el.label.textContent = view.label.text;
    el.label.dataset.tone = view.label.tone;
  }
  el.collectionsIntro.hidden = view.intro === null;
  el.collectionsIntro.textContent = view.intro ?? "";
  el.collectionList.hidden = view.rows === null;
  el.collectionNew.hidden = view.rows === null;
  el.collectionNewTitle.disabled = view.locked;
  el.collectionNewAdd.disabled = view.locked;
  el.collectionList.replaceChildren(
    ...(view.rows ?? []).map((row) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = row.checked;
      input.disabled = view.locked;
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
  if (view.remove !== null) applyRemoval(view.remove);
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
      const afterClipName = params.get("after-clip");
      if (afterClipName !== null) {
        const { afterClipFixtures } = await import("./fixtures.ts");
        const panel = afterClipFixtures()[afterClipName];
        if (panel !== undefined) {
          applyCollections(afterClipView(panel.afterClip, panel.state, m));
        } else el.label.textContent = `no fixture "${afterClipName}"`;
      }
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
  /** Set once a clip has saved: the collections offered under it, as far as
   * reading them from the vault has got (ADR 0037). */
  let afterClip: AfterClip | null = null;

  /** The article the collection rows toggle — the Tiro page's, or the one this
   * popup has just clipped once its collections are read — or null while
   * there is none. */
  function collectionPage(): ArticlePage | null {
    if (tiroPage?.kind === "article") return tiroPage;
    return afterClip?.state === "ready" ? afterClip.page : null;
  }
  /** Toggles sent and not yet answered. Re-reading the queue while one is in
   * flight would paint the worker's state from *before* it, and a checkbox the
   * reader just ticked would flick back. */
  let inFlight = 0;

  /** The last Save now could not reach the worker at all. */
  let saveUnreachable = false;

  /* ------------------------------------------- remove from Tiro (ADR 0036) */

  /** The article Remove would act on — this tab's, if this machine clipped
   * it, or the Tiro page's — and where that removal has got to. Null while
   * there is none to offer. */
  let removeSlug: string | null = null;
  let removal: RemovalState | null = null;
  /** The article's title as the vault has it, for the commit message. */
  let removeTitle: string | null = null;
  /** The slug this popup just clipped. GitHub's read side can trail its write
   * by a moment, so "not there" right after a clip is not yet an answer. */
  let clippedSlug: string | null = null;

  function offerRemoval(slug: string): void {
    removeSlug = slug;
    removeTitle = null;
    removal = {
      step: "offered",
      vault: `${config.owner}/${config.repo}`,
      title: null,
      problem: null,
    };
  }

  /** Move the removal on. A no-op once there is none — the popup never
   * invents one mid-flight. */
  function updateRemoval(patch: Partial<RemovalState>): void {
    if (removal !== null) removal = { ...removal, ...patch };
  }

  /** Checking, confirming, removing, or done: nothing else may act on the
   * article meanwhile — a toggle would race the commit, a clip would re-add
   * what is being removed. */
  function removalHolds(): boolean {
    return (
      removal !== null &&
      removal.step !== "offered" &&
      removal.step !== "failed"
    );
  }

  async function refreshQueue(): Promise<void> {
    const [loaded, status] = await Promise.all([
      loadCollectionQueue(config),
      loadFlushStatus(config),
    ]);
    // In memory and for drawing only: after a clip the vault read is fresher
    // than any overlay. Storage is pruned against the site alone (the worker's
    // `recordToggle`), which is why a toggle's `member` below is the site's.
    let next = visibleQueue(loaded, collectionPage(), Date.now());
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
      applyCollections(collectionsView({ page: tiroPage, ...s, removal }, m));
    } else if (afterClip !== null) {
      applyCollections(afterClipView(afterClip, { ...s, removal }, m));
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
    const page = collectionPage();
    if (page === null || removalHolds()) return;
    const entry = {
      op,
      published: page.member.includes(op.collection),
      // The site's membership, or none: a vault read after a clip already
      // agrees with every saved op, and handed to the worker as if it were the
      // site it would prune overlay a stale Tiro page still needs.
      member: tiroPage?.kind === "article" ? page.member : null,
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
    const page = collectionPage();
    if (!(input instanceof HTMLInputElement) || page === null) return;
    const collection = input.dataset.id ?? "";
    // A title travels only with an op that may have to create the file — one
    // for a collection the catalog does not hold. A catalog entry already has
    // its file, and its title there is the owner's.
    const listed = page.catalog.some((entry) => entry.id === collection);
    void toggle({
      id: crypto.randomUUID(),
      collection,
      slug: page.slug,
      action: input.checked ? "add" : "remove",
      at: new Date().toISOString(),
      ...(listed ? {} : { title: input.dataset.title ?? collection }),
    });
  });

  el.collectionNew.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = el.collectionNewTitle.value.trim();
    const page = collectionPage();
    if (title === "" || page === null) return;
    // Named after the typed title, the way the site will route it. A name that
    // folds onto an existing collection simply adds to that one.
    const collection = collectionId(title);
    // Unless that collection's file does not parse: the panel left it out for
    // that reason, and a tick on it would fail the whole flush (ADR 0037). The
    // name stays in the field; the intro already says files were left out.
    if (
      tiroPage === null &&
      afterClip?.state === "ready" &&
      afterClip.unreadable.includes(collection)
    ) {
      return;
    }
    el.collectionNewTitle.value = "";
    const listed = page.catalog.some((entry) => entry.id === collection);
    void toggle({
      id: crypto.randomUUID(),
      collection,
      slug: page.slug,
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
  /** The build that produced the body on screen — clipper.js's for a page
   * body, this popup's for one it fetched. Becomes `tiro.clipper_commit`, and
   * is set by `offer` for the same reason `sourceUrl` is. */
  let bodyCommit = "";
  /** The document the tab body on screen was read from, which a capture's clip
   * has to match (ADR 0039). Set by `offer`, with the body; undefined for a
   * body the popup fetched. */
  let bodyDocument: string | undefined;
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

  /* ------------------------------------- capturing figures (ADR 0039) */

  /** Set once a capture starts: how far it has got. Before that the offer is
   * derived from the body on screen, in `captureOffer`. */
  let capture: CaptureState | null = null;
  /** The pictures taken, by id — the name the payload gives them. */
  const snapshotBytes = new Map<string, Uint8Array>();
  /** The reader pressed Stop. */
  let stopCapture = false;
  /** The clip a capture is waiting for, by the request it sent. */
  let pendingCapture: {
    requestId: string;
    resolve: (message: ClipResultMessage | null) => void;
  } | null = null;
  /** Snapshot uploads, while a commit carrying them runs. */
  let uploading: { done: number; total: number } | null = null;

  /** The capture on offer for the body on screen, if any. Only a tab body
   * from an ordinary page: a publisher's copy is not what the tab shows, and
   * a PDF has no figures to frame. */
  function captureOffer(): CaptureState | null {
    if (capture !== null) return capture;
    if (result === null || result.pdfViewer || source !== null) return null;
    if (best?.fromFetch === true) return null;
    // Without the document's id, no capture's clip could be shown to come
    // from this page, so none would ever be taken.
    if (bodyDocument === undefined) return null;
    const offered = result.scriptFigures?.length ?? 0;
    return offered === 0
      ? null
      : { offered, step: "offered", at: 0, captured: 0, lost: false };
  }

  function fetchPolicy(): FetchPolicy {
    return source === null
      ? NO_FETCH
      : { available: true, degradesToTab: source.degradesToTab };
  }

  /** Everything known, as the view model wants it. */
  function render(): void {
    const policy = fetchPolicy();
    // Never a button over an empty body, whichever source produced it.
    // `clipReady` judges where a body came from, not what is in it.
    const gated =
      result !== null &&
      (hasNothingToClip(result) ||
        !clipReady(best, policy, attempt.resolved, tabResolved));
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
    //
    // Two refusals, the publisher's first: where a fetch failed and the tab
    // holds only a rendering, its sentence says where the document is. The
    // other is a body with nothing in it — derived here, of the body that won,
    // rather than in `showPayload` of each arrival, so a fetched source body
    // that turns out empty is refused like an empty tab is.
    const refusal = committing
      ? null
      : source !== null &&
          !source.degradesToTab &&
          clipRefused(best, policy, attempt.resolved)
        ? source.instead
        : refusesAsEmpty(result, policy, attempt.resolved)
          ? m.nothingToClip
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
      // No card for an empty body either: it would preview zero words under a
      // warning that the raw page is about to be clipped.
      preview:
        result === null || result.pdfViewer || hasNothingToClip(result)
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
      removal,
      capture: captureOffer(),
      uploading,
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
    commit: string,
    documentId?: string,
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
    bodyCommit = commit;
    bodyDocument = documentId;
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
   * What `prepare` has made of the tab. Until it says "ordinary", no clip
   * result is taken: a clipper an earlier popup session injected into this
   * same tab can still answer, and taken while the Tiro-page check is in
   * flight it enabled Clip on a page that is never clipped — and, once that
   * check landed, left the collection panel and a clip naming two different
   * articles. This session injects its own clipper only after the check, so
   * its own answer is never the one turned away.
   */
  let pageKind: "pending" | "ordinary" | "tiro" = "pending";

  /**
   * Registered below `tabId` so it can check one, and that is the whole reason
   * it sits here: a clipper injected by an earlier popup session in another tab
   * can still be extracting, and its result would otherwise drive this
   * preview — and the URL this commits under.
   */
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.tab?.id !== tabId || !isClipResult(message)) return;
    if (pageKind !== "ordinary") return;
    // A capture's clip goes to the capture that asked for it, and nowhere
    // else: it is the body on screen with pictures in, not a rival to it.
    if (message.requestId !== undefined) {
      if (pendingCapture?.requestId === message.requestId) {
        pendingCapture.resolve(message);
      }
      return;
    }
    tabResolved = true;
    offer(
      message.payload,
      false,
      sourceUrlOf(message.payload.url),
      message.clipperCommit ?? "",
      message.documentId,
    );
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
    // Fetched and converted here, so this popup's build is the one to name.
    offer(clip.payload, true, clip.sourceUrl, __CLIPPER_COMMIT__);
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
    if (page.kind === "article") offerRemoval(page.slug);
    el.label.textContent = m.labelTiroPage;
    el.label.dataset.tone = "neutral";
    // A Tiro page is never clipped, whoever runs the site: it is a rendering of
    // an article that came from somewhere, and that page is the one to clip.
    // So the clip controls go rather than sit disabled beside the toggles.
    el.clip.hidden = true;
    el.sourceFetch.hidden = true;
    el.loading.hidden = true;
    el.message.hidden = true;
    paintCollections();
  }

  async function prepare(): Promise<void> {
    // Before anything is read for a preview. On a Tiro page the popup edits
    // collections instead of clipping, and recognizing one takes two DOM reads
    // in the tab — the same page read the disclosure already covers.
    if (configured) {
      const page = await detectTiroPage();
      if (page !== null) {
        pageKind = "tiro";
        enterCollections(page);
        return;
      }
    }
    pageKind = "ordinary";
    try {
      const slug = await slugForUrl(tabUrl);
      clippedAt = await lastClippedAt(config, slug);
      if (clippedAt !== null) offerRemoval(slug);
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
    // The empty check again, at the one place a commit starts: the view keeps
    // the button shut over an empty body, and this is what holds if it ever
    // does not.
    if (result === null || removalHolds() || hasNothingToClip(result)) return;
    // Clip waits for the body a capture is about to hand it.
    if (capture?.step === "capturing" || capture?.step === "placing") return;
    // All three captured at the click, for one reason: `sourceUrl` and
    // `bodyCommit` describe the body being committed, and reading them from
    // the closure later would let a body that arrived mid-upload retag the one
    // already on its way.
    void (async (payload, from, commit) => {
      committing = true;
      phase = "clipping";
      render();
      try {
        const nowIso = new Date().toISOString();
        // A PDF tab commits a stub. The viewer's shell holds no body worth
        // keeping, and the flags that describe one would be
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
          clipperCommit: commit,
        };
        // Every picture the body names, or no commit: a body naming a file
        // that was never written would publish a broken image.
        const snapshots: Snapshot[] = (payload.snapshots ?? []).map((id) => {
          const bytes = snapshotBytes.get(id);
          if (bytes === undefined) {
            throw new Error(`the picture ${id} the article shows was lost`);
          }
          return { id, bytes };
        });
        const { file, updated } = await commitClip(config, clip, {
          snapshots,
          onUpload: (done, total) => {
            uploading = { done, total };
            render();
          },
        });
        uploading = null;
        saved = {
          updated,
          links: {
            site: articleUrl(
              homepage ?? "https://tiro.ainaive.com/",
              file.slug,
            ),
            vault: vaultFileUrl(config, file.path),
          },
        };
        phase = "saved";
        clippedSlug = file.slug;
        offerRemoval(file.slug);
        render();
        try {
          await recordClip(config, file.slug, nowIso);
        } catch {
          // The commit already succeeded; losing the hint record must not
          // relabel the clip as failed.
        }
        // After the record, not beside it: a tick on this article is deferred
        // rather than refused while GitHub catches up, and the worker knows the
        // article is fresh only from that record.
        void offerClipCollections(file.slug);
      } catch (error) {
        console.error("clip failed:", error);
        uploading = null;
        committing = false;
        phase = "failed";
        problem = { text: describeClipError(error, m), error: true };
        render();
      }
    })(result, sourceUrl, bodyCommit);
  });

  /** The tab, as the capture loop needs it. Each call into the page is its
   * own injection; one that fails — the tab navigated, closed — answers as a
   * figure that is gone, and the loop moves on. */
  function captureEffects(): CaptureEffects {
    const inject = async <Args extends unknown[], Result>(
      func: (...args: Args) => Result,
      args: Args,
    ): Promise<Awaited<Result> | undefined> => {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func,
          args,
        });
        return injection?.result as Awaited<Result> | undefined;
      } catch {
        return undefined;
      }
    };
    const gone: FrameResult = { ok: false, reason: "gone" };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    return {
      begin: async () =>
        (await inject(beginCapture, [FRAME_OPTIONS.watchdogMs])) != null,
      frame: async (index) =>
        (await inject(frameFigure, [index, { ...FRAME_OPTIONS }])) ?? gone,
      measure: async (index) =>
        (await inject(frameFigure, [
          index,
          { ...FRAME_OPTIONS, scroll: false, waitMs: 0, settleMs: 0 },
        ])) ?? gone,
      end: async () => {
        await inject(endCapture, []);
      },
      captureTab: async () => {
        // The visible tab of the window, whichever it is now — so a picture
        // is taken only while it is still the one the popup opened on.
        let current: chrome.tabs.Tab;
        try {
          current = await chrome.tabs.get(tabId);
        } catch {
          return null;
        }
        if (!current.active || current.url !== tabUrl) return null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await chrome.tabs.captureVisibleTab(current.windowId, {
              format: "png",
            });
          } catch {
            // Most likely the per-second quota; one wait covers it.
            if (attempt === 0) await sleep(1000);
          }
        }
        return null;
      },
      encode: cropAndEncode,
      sleep,
      now: () => Date.now(),
    };
  }

  /** Clip the tab again, with the pictures in place of the links. Null when
   * the clip never comes back, or comes back from another page than the body
   * on screen — the original body then stands, with its links. */
  async function reclipWithSnapshots(
    onScreen: BodyOrigin,
    figures: [number, string][],
  ): Promise<ClipResultMessage["payload"] | null> {
    // Asked before injecting anything: a tab that has moved would only give
    // back a clip of wherever it is now.
    try {
      const current = await chrome.tabs.get(tabId);
      if (current.url !== tabUrl) return null;
    } catch {
      return null;
    }
    const requestId = crypto.randomUUID();
    const arrived = new Promise<ClipResultMessage | null>((resolve) => {
      pendingCapture = { requestId, resolve };
      setTimeout(() => resolve(null), 10_000);
    });
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: setSnapshotRequest,
        args: [{ requestId, figures }],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["clipper.js"],
      });
    } catch {
      pendingCapture = null;
      return null;
    }
    const message = await arrived;
    pendingCapture = null;
    if (message === null) return null;
    const from = {
      url: message.payload.url,
      documentId: message.documentId,
    };
    return isSameBody(onScreen, from) ? message.payload : null;
  }

  el.capture.addEventListener("click", () => {
    const offer = captureOffer();
    const figures = result?.scriptFigures ?? [];
    if (
      offer?.step !== "offered" ||
      figures.length === 0 ||
      committing ||
      removalHolds()
    ) {
      return;
    }
    // Taken at the click, with the figures: the body the capture is for.
    const onScreen: BodyOrigin = {
      url: result?.url ?? "",
      documentId: bodyDocument,
    };
    void (async () => {
      stopCapture = false;
      capture = { ...offer, step: "capturing", at: 1 };
      render();
      try {
        await runCapture(offer, figures, onScreen);
      } catch (error) {
        // Never left saying "Capturing…": the body on screen still clips,
        // with links where the pictures would have gone.
        console.error("capture failed:", error);
        capture = { ...offer, step: "done", lost: true };
        render();
      }
    })();
  });

  async function runCapture(
    offer: CaptureState,
    figures: number[],
    onScreen: BodyOrigin,
  ): Promise<void> {
    const outcome = await captureFigures(figures, captureEffects(), {
      onProgress: (at) => {
        if (capture !== null) capture = { ...capture, at };
        render();
      },
      stopped: () => stopCapture,
    });
    if (outcome.snapshots.size === 0) {
      capture = { ...offer, step: "done", captured: 0 };
      render();
      return;
    }
    capture = { ...offer, step: "placing" };
    render();
    for (const { id, bytes } of outcome.snapshots.values()) {
      snapshotBytes.set(id, bytes);
    }
    const payload = await reclipWithSnapshots(
      onScreen,
      [...outcome.snapshots].map(([index, { id }]) => [index, id]),
    );
    if (payload === null || committing) {
      capture = { ...offer, step: "done", lost: payload === null };
      render();
      return;
    }
    // In place of the body on screen, not offered against it: the same tab
    // and the same clipper, with the pictures the reader asked for.
    result = payload;
    capture = {
      ...offer,
      step: "done",
      captured: figuresShown(outcome.snapshots.values(), payload.snapshots),
    };
    render();
  }

  el.captureStop.addEventListener("click", () => {
    stopCapture = true;
  });

  /**
   * Offer collections under the clip just saved (ADR 0037).
   *
   * Read from the vault now, and not before: the disclosure promises nothing
   * reaches it until the Clip click, and a read is a request all the same.
   * Nothing here can relabel the clip — whatever the read does, the article is
   * saved — so every failure ends in a line under it, never in the clip's own
   * state.
   */
  async function offerClipCollections(slug: string): Promise<void> {
    afterClip = { state: "loading" };
    paintCollections();
    try {
      const read = await readClipCollections(config, slug);
      afterClip = {
        state: "ready",
        page: {
          kind: "article",
          slug,
          member: read.member,
          catalog: read.catalog,
        },
        unreadable: read.unreadable,
      };
    } catch (error) {
      console.error("reading collections failed:", error);
      afterClip = { state: "failed" };
    }
    try {
      // Again, now that there is an article to prune the overlay against.
      await refreshQueue();
    } catch {
      // The last drawn state stands; the next action re-reads.
    }
    paintCollections();
  }

  /** Paint whichever mode the popup is in. After a clip that is both: the
   * clip's view, and the collections offered under it. */
  function repaint(): void {
    if (tiroPage !== null) {
      paintCollections();
      return;
    }
    render();
    if (afterClip !== null) paintCollections();
  }

  /** Where a removal ends with the article not in the vault — removed now, or
   * already gone. This machine stops calling it clipped either way. */
  async function forgetRemoved(slug: string): Promise<void> {
    clippedAt = null;
    previousLinks = null;
    try {
      await forgetClip(config, slug);
    } catch {
      // The vault is what matters and it is settled; a stale hint costs a
      // "not in your vault" the next time Remove is pressed here.
    }
  }

  el.removeOffer.addEventListener("click", () => {
    const slug = removeSlug;
    if (slug === null || removal === null || removalHolds()) return;
    void (async () => {
      updateRemoval({ step: "checking", problem: null });
      repaint();
      try {
        // Asked of the vault, not of the page: the slug is untrusted, and the
        // confirmation must name what would really be deleted.
        const found = await lookupArticle(config, slug);
        if (found === null && clippedSlug === slug) {
          updateRemoval({ step: "failed", problem: m.removeNotYetVisible });
        } else if (found === null) {
          updateRemoval({ step: "gone" });
          await forgetRemoved(slug);
        } else {
          removeTitle = found.title;
          updateRemoval({
            step: "confirming",
            title:
              locale === "zh" ? (found.titleZh ?? found.title) : found.title,
          });
        }
      } catch (error) {
        console.error("remove lookup failed:", error);
        updateRemoval({
          step: "failed",
          problem: describeRemoveError(error, m),
        });
      }
      repaint();
      // The safe answer is the one under the keyboard.
      if (removal?.step === "confirming") el.removeCancel.focus();
    })();
  });

  function cancelRemoval(): void {
    if (removal?.step !== "confirming") return;
    updateRemoval({ step: "offered", title: null });
    repaint();
    el.removeOffer.focus();
  }
  el.removeCancel.addEventListener("click", cancelRemoval);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && removal?.step === "confirming") {
      event.preventDefault();
      cancelRemoval();
    }
  });

  el.removeConfirmButton.addEventListener("click", () => {
    const slug = removeSlug;
    if (slug === null || removal?.step !== "confirming") return;
    void (async () => {
      updateRemoval({ step: "removing" });
      repaint();
      try {
        const outcome = await removeArticle(
          config,
          slug,
          removeTitle === null ? {} : { title: removeTitle },
        );
        updateRemoval({
          step: outcome.kind === "removed" ? "removed" : "gone",
        });
        await forgetRemoved(slug);
      } catch (error) {
        console.error("remove failed:", error);
        updateRemoval({
          step: "failed",
          problem: describeRemoveError(error, m),
        });
      }
      repaint();
    })();
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
