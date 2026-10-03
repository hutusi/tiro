import type { CollectionOp } from "@tiro/shared";

/**
 * The clipper's record of collection toggles (ADR 0029), as pure functions.
 *
 * A toggle is two facts at different times. It is *pending* until a flush
 * commits it, and then *sent*: in the vault, but not yet on the site, because
 * the site only changes when a deploy finishes a minute or two later. The page
 * the popup reads its ticks from is that site. So a sent op has to be kept and
 * laid over the page until the page agrees with it — without it, the popup
 * reopened right after a flush would show the reader's own favorite as not a
 * favorite, and a second click would undo it.
 *
 * One entry per (collection, article) pair, always: a later toggle replaces an
 * earlier one rather than queuing behind it, so the pending count is the number
 * of things the reader actually changed.
 */
export interface QueuedOp extends CollectionOp {
  /** Identity, so a flush marks exactly the ops it sent and not ones queued
   * while it ran. */
  id: string;
  state: "pending" | "sent";
  /** When the flush that sent it landed; ages the overlay out. */
  sentAt?: string;
  /**
   * On a pending op only: the sent op it displaced. Toggling back has to put
   * that op back rather than leave nothing, because a sent op says what the
   * *vault* holds while the site still shows the old state. Judged against the
   * page alone, a cancelled edit dropped it — and when the page the popup drew
   * from was the vault itself (ADR 0037), the vault agreed with the final tick,
   * so nothing was left to tell a stale Tiro page that the article is in.
   */
  replaced?: QueuedOp;
}

/** How long a sent op may overlay a page that still disagrees with it. A
 * deploy takes minutes; a week means the site is not going to catch up, and
 * the page is the better guess again. */
export const SENT_OVERLAY_MS = 7 * 24 * 60 * 60 * 1000;

function samePair(a: CollectionOp, b: CollectionOp): boolean {
  return a.collection === b.collection && a.slug === b.slug;
}

/**
 * Record a toggle.
 *
 * `published` is whether the page says the article is in that collection —
 * the deployed state. What the vault holds is that, unless a sent op for the
 * pair says otherwise — the one in the queue, or the one a pending op
 * displaced. A toggle back to what the vault already holds is not a change:
 * the pending op it cancels is dropped, and nothing is queued. The sent op
 * stays, or comes back, in that case, since it is what makes the popup show
 * the vault's state until the site catches up.
 */
export function enqueue(
  queue: readonly QueuedOp[],
  op: CollectionOp & { id: string },
  published: boolean,
): QueuedOp[] {
  const prior = queue.find((queued) => samePair(queued, op));
  const rest = queue.filter((queued) => !samePair(queued, op));
  const saved = prior?.state === "sent" ? prior : prior?.replaced;
  const held = saved !== undefined ? saved.action === "add" : published;
  const wants = op.action === "add";
  if (wants === held) {
    return saved !== undefined ? [...rest, saved] : rest;
  }
  return [
    ...rest,
    {
      ...op,
      state: "pending",
      ...(saved !== undefined ? { replaced: saved } : {}),
    },
  ];
}

/** The collections the popup should show the article in: the page's, with
 * every op for it laid over. One op per pair, so order does not matter. */
export function effectiveMembership(
  published: readonly string[],
  queue: readonly QueuedOp[],
  slug: string,
): Set<string> {
  const members = new Set(published);
  for (const op of queue) {
    if (op.slug !== slug) continue;
    if (op.action === "add") members.add(op.collection);
    else members.delete(op.collection);
  }
  return members;
}

export function pendingOps(queue: readonly QueuedOp[]): QueuedOp[] {
  return queue.filter((op) => op.state === "pending");
}

/** After a flush: the ops it sent become the overlay, and the ones it refused
 * are dropped. Ops queued while it ran are left pending — they were not in the
 * snapshot it sent, whatever their pair. */
export function settleFlush(
  queue: readonly QueuedOp[],
  sent: ReadonlySet<string>,
  refused: ReadonlySet<string>,
  at: string,
): QueuedOp[] {
  return queue
    .filter((op) => !refused.has(op.id))
    .map((op) => {
      if (!sent.has(op.id) || op.state !== "pending") return op;
      // Sent, it is the overlay itself: the one it displaced is history.
      const { replaced: _displaced, ...landed } = op;
      return { ...landed, state: "sent" as const, sentAt: at };
    });
}

/**
 * Drop overlay that is no longer needed: sent ops the page now agrees with,
 * and any sent op older than `SENT_OVERLAY_MS`. Pending ops are never pruned
 * — they are the reader's unsaved intent.
 *
 * The sent op a pending one displaced (`replaced`) is overlay too, and retires
 * by the same two rules while the pending op stays. Kept past them, it would
 * go on deciding what the vault holds: a week-old saved add would turn a fresh
 * click on a page that has since moved on into "no change", restore an op the
 * next save then expires, and lose the click (owner's re-review, PR #68).
 */
export function pruneSent(
  queue: readonly QueuedOp[],
  page: { slug: string; member: readonly string[] } | null,
  now: number,
): QueuedOp[] {
  const retired = (op: QueuedOp): boolean => {
    if (
      op.sentAt !== undefined &&
      now - Date.parse(op.sentAt) > SENT_OVERLAY_MS
    ) {
      return true;
    }
    if (page === null || op.slug !== page.slug) return false;
    const listed = page.member.includes(op.collection);
    return listed === (op.action === "add");
  };
  return queue.flatMap((op) => {
    if (op.state === "sent") return retired(op) ? [] : [op];
    if (op.replaced !== undefined && retired(op.replaced)) {
      const { replaced: _retired, ...pending } = op;
      return [pending];
    }
    return [op];
  });
}
