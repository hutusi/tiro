import { FAVORITES_ID } from "@tiro/shared";
import {
  effectiveMembership,
  pendingOps,
  pruneSent,
  type QueuedOp,
} from "../collection-queue.ts";
import type { FlushReport } from "../collections-worker.ts";
import { describeFlushError } from "../errors.ts";
import type { Messages } from "../i18n.ts";
import type { FlushStatus } from "../storage.ts";
import type { TiroPage } from "../tiro-page.ts";
import {
  type RemovalState,
  type RemovalView,
  removalView,
} from "./removal-view.ts";
import type { Tone } from "./view.ts";

/**
 * The popup on a Tiro page (ADR 0029), as a pure function — the same split
 * `view.ts` makes for clipping, and kept apart from it so the clip state
 * machine is untouched by a mode it never enters.
 */
export interface CollectionsState {
  page: TiroPage;
  /** This vault's queue, as last read or as the popup has just changed it. */
  queue: readonly QueuedOp[];
  /** The last flush's recorded outcome, from any earlier session. */
  status: FlushStatus | null;
  /** A "Save now" is in flight from this popup. */
  syncing: boolean;
  /** What "Save now" reported, in this session. */
  report: FlushReport | null;
  /**
   * Toggles the worker could not record, even after a retry. They exist only
   * in this popup — it cannot write the queue itself — so they outrank every
   * other line: closing the popup now would lose them.
   */
  unrecorded: number;
  /** The last "Save now" could not reach the worker at all. */
  saveUnreachable: boolean;
  /** Remove from Tiro (ADR 0036), for the article this page shows. */
  removal?: RemovalState | null;
}

export interface CollectionRow {
  id: string;
  title: string;
  checked: boolean;
  /** Changed here and not yet in the vault. */
  pending: boolean;
  favorite: boolean;
}

export interface CollectionsFooter {
  text: string;
  tone: Tone;
  sync: { visible: boolean; enabled: boolean };
}

export interface CollectionsView {
  /** The header label: "Tiro site", unless a removal has something to say. */
  label: { text: string; tone: Tone };
  /** Null once the article has been removed: there is nothing to introduce. */
  intro: string | null;
  /** Null on a Tiro page that is not an article, or one just removed: nothing
   * to toggle. */
  rows: CollectionRow[] | null;
  /** The rows stay on screen but take no clicks — while a removal is being
   * confirmed or made, a toggle for the same article would race it. */
  locked: boolean;
  /** "Clip this page anyway" is on offer. */
  clipAnyway: boolean;
  footer: CollectionsFooter | null;
  remove: RemovalView;
}

/**
 * The queue as the popup should draw it: expired and caught-up overlay
 * dropped, the same rule the worker applies when it writes.
 *
 * Applied on every read, because the worker only prunes when it has a reason
 * to write — a toggle or a save — and a popup that merely opened would
 * otherwise go on showing a saved tick from weeks ago. In memory only: the
 * popup never writes the queue (the worker is its one writer), and the next
 * write catches storage up.
 */
export function visibleQueue(
  queue: readonly QueuedOp[],
  page: TiroPage | null,
  now: number,
): QueuedOp[] {
  return pruneSent(
    queue,
    page?.kind === "article" ? { slug: page.slug, member: page.member } : null,
    now,
  );
}

/**
 * The status line about the queue. Shared with the clip popup, which shows it
 * on any page while something is pending — a queue that could only be seen
 * from a Tiro page would be a queue the reader can lose track of.
 */
export function collectionsFooter(
  s: Pick<
    CollectionsState,
    "queue" | "status" | "syncing" | "report" | "unrecorded" | "saveUnreachable"
  >,
  m: Messages,
): CollectionsFooter | null {
  const busy = { visible: true, enabled: false };
  if (s.syncing)
    return { text: m.collectionsSaving, tone: "neutral", sync: busy };
  const retry = { visible: true, enabled: true };
  if (s.unrecorded > 0) {
    return { text: m.collectionsNotRecorded, tone: "error", sync: retry };
  }
  if (s.saveUnreachable) {
    return { text: m.collectionsSaveUnreachable, tone: "error", sync: retry };
  }
  const pending = pendingOps(s.queue).length;
  if (pending === 0) {
    if (s.report === null || !s.report.ok) return null;
    return s.report.refused > 0
      ? {
          text: m.collectionsRefused(s.report.refused),
          tone: "error",
          sync: { visible: false, enabled: false },
        }
      : {
          text: m.collectionsSaved,
          tone: "ok",
          sync: { visible: false, enabled: false },
        };
  }
  const ready = { visible: true, enabled: true };
  // Only while there is still something to retry: a failure the next flush
  // already recovered from is not news.
  if (s.status !== null && !s.status.ok) {
    return {
      text: m.collectionsFailed(describeFlushError(s.status, m)),
      tone: "error",
      sync: ready,
    };
  }
  return { text: m.collectionsPending(pending), tone: "neutral", sync: ready };
}

export function collectionsView(
  s: CollectionsState,
  m: Messages,
): CollectionsView {
  const footer = collectionsFooter(s, m);
  const siteLabel = { text: m.labelTiroPage, tone: "neutral" as const };
  if (s.page.kind === "site") {
    return {
      label: siteLabel,
      intro: m.tiroSiteIntro,
      rows: null,
      locked: false,
      clipAnyway: true,
      footer,
      remove: removalView(null, m),
    };
  }
  const remove = removalView(s.removal, m);
  const label = remove.label ?? siteLabel;
  if (remove.settled) {
    // The article is gone from the vault, whatever this page still shows until
    // the next deploy: no collection can take it, and clipping the site's own
    // rendering of it is not a way back.
    return {
      label,
      intro: null,
      rows: null,
      locked: true,
      clipAnyway: false,
      footer,
      remove,
    };
  }
  const { slug, member, catalog } = s.page;
  const checked = effectiveMembership(member, s.queue, slug);
  const pending = new Set(
    pendingOps(s.queue)
      .filter((op) => op.slug === slug)
      .map((op) => op.collection),
  );

  // Favorites first and always, even before the vault has a `favorites.md` —
  // it is the one collection every reader has, and the first toggle creates
  // it. Then the site's catalog in its own order, then any collection this
  // machine created that the site has not published yet.
  const titles = new Map<string, string>();
  titles.set(FAVORITES_ID, m.favorites);
  for (const entry of catalog) titles.set(entry.id, entry.title);
  for (const op of s.queue) {
    if (!titles.has(op.collection)) {
      titles.set(op.collection, op.title ?? op.collection);
    }
  }
  const rows = [...titles].map(
    ([id, title]): CollectionRow => ({
      id,
      title,
      checked: checked.has(id),
      pending: pending.has(id),
      favorite: id === FAVORITES_ID,
    }),
  );
  return {
    label,
    intro: m.tiroArticleIntro,
    rows,
    locked: remove.active,
    clipAnyway: !remove.active,
    footer,
    remove,
  };
}
