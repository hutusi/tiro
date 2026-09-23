import type { CollectionMessage } from "../messages.ts";
import { serializer } from "../serializer.ts";

export type ToggleOp = Extract<
  CollectionMessage,
  { type: "tiro-collection-toggle" }
>["op"];

export interface ToggleEntry {
  op: ToggleOp;
  /** Whether the page said the article is in the collection. */
  published: boolean;
  member: string[];
}

export interface ToggleChannel {
  /** Record a click with the worker. Resolves false when it could not be
   * recorded, even after a retry, and is still the reader's latest word. */
  toggle(entry: ToggleEntry): Promise<boolean>;
  /** Re-send what could not be recorded, after everything clicked before this
   * call has had its turn. Resolves true when nothing is left unrecorded. */
  retry(): Promise<boolean>;
  /** Toggles the worker has not recorded and that no later click superseded. */
  unrecorded(): readonly ToggleEntry[];
}

function pairKey(op: ToggleOp): string {
  return `${op.collection}\u0000${op.slug}`;
}

/**
 * Everything between a click and the worker, for collection toggles.
 *
 * Three rules, each from a race that shipped and was then found:
 *
 * - **One line, in click order.** Every send, its retry included, finishes
 *   before the next starts. The worker runs toggles in *arrival* order, so a
 *   retried add sent independently could land after the reader's later remove
 *   and become the final state.
 * - **Newest is decided at click time.** Each click marks itself the latest
 *   for its article and collection the moment it happens. A toggle whose turn
 *   comes after a newer click for the same pair is not sent — the worker's
 *   `enqueue` settles a pair on its last op alone, so skipping it changes
 *   nothing — and a failure is kept only while it is still the latest.
 *   Deciding "newest" when a send *finished* is what let Save now re-send a
 *   stale add behind the remove that superseded it.
 * - **Save now waits its turn.** `retry` looks at the unrecorded list only
 *   after every toggle clicked before it has landed or failed, so it retries
 *   what is current rather than a snapshot taken mid-flight.
 *
 * The bookkeeping happens inside the ordered job, not in whichever promise
 * continuation runs first, so none of this rests on microtask order.
 *
 * `send` answers null for any failure and never throws.
 */
export function createToggleChannel(
  send: (message: CollectionMessage) => Promise<unknown | null>,
): ToggleChannel {
  const inOrder = serializer();
  const latest = new Map<string, string>();
  let held: ToggleEntry[] = [];

  const isLatest = (entry: ToggleEntry) =>
    latest.get(pairKey(entry.op)) === entry.op.id;
  const release = (op: ToggleOp) => {
    held = held.filter((kept) => pairKey(kept.op) !== pairKey(op));
  };

  function attempt(entry: ToggleEntry): Promise<boolean> {
    return inOrder(async () => {
      // Superseded while it waited: the newer click is the one to send.
      if (!isLatest(entry)) return true;
      const message: CollectionMessage = {
        type: "tiro-collection-toggle",
        ...entry,
      };
      let recorded = (await send(message)) !== null;
      // Once more on failure — a worker still waking is the usual cause —
      // unless a newer click for this pair arrived meanwhile and decides it.
      if (!recorded && isLatest(entry)) {
        recorded = (await send(message)) !== null;
      }
      if (!recorded && isLatest(entry)) {
        release(entry.op);
        held.push(entry);
      }
      return recorded || !isLatest(entry);
    });
  }

  return {
    toggle(entry) {
      latest.set(pairKey(entry.op), entry.op.id);
      // Whatever was held for this pair is superseded now, not when this
      // click's own send comes back.
      release(entry.op);
      return attempt(entry);
    },
    async retry() {
      await inOrder(async () => {});
      // Everything held is some pair's latest click: a click releases what
      // was held for its pair, and a failure is held only while still latest.
      const retrying = held;
      held = [];
      await Promise.all(retrying.map(attempt));
      return held.length === 0;
    },
    unrecorded: () => held,
  };
}
