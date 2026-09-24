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
 * pair says otherwise. A toggle back to what the vault already holds is not a
 * change: the pending op it cancels is dropped, and nothing is queued. A sent
 * op is kept in that case, since it is what makes the popup show the vault's
 * state until the site catches up.
 */
export function enqueue(
  queue: readonly QueuedOp[],
  op: CollectionOp & { id: string },
  published: boolean,
): QueuedOp[] {
  const prior = queue.find((queued) => samePair(queued, op));
  const rest = queue.filter((queued) => !samePair(queued, op));
  const held = prior?.state === "sent" ? prior.action === "add" : published;
  const wants = op.action === "add";
  if (wants === held) {
    return prior?.state === "sent" ? [...rest, prior] : rest;
  }
  return [...rest, { ...op, state: "pending" }];
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
    .map((op) =>
      sent.has(op.id) && op.state === "pending"
        ? { ...op, state: "sent" as const, sentAt: at }
        : op,
    );
}

/**
 * Drop overlay that is no longer needed: sent ops the page now agrees with,
 * and any sent op older than `SENT_OVERLAY_MS`. Pending ops are never pruned
 * — they are the reader's unsaved intent.
 */
export function pruneSent(
  queue: readonly QueuedOp[],
  page: { slug: string; member: readonly string[] } | null,
  now: number,
): QueuedOp[] {
  return queue.filter((op) => {
    if (op.state !== "sent") return true;
    if (
      op.sentAt !== undefined &&
      now - Date.parse(op.sentAt) > SENT_OVERLAY_MS
    ) {
      return false;
    }
    if (page === null || op.slug !== page.slug) return true;
    const listed = page.member.includes(op.collection);
    return listed !== (op.action === "add");
  });
}
