import {
  enqueue,
  pendingOps,
  pruneSent,
  settleFlush,
} from "./collection-queue.ts";
import { flushCollections } from "./collections-flush.ts";
import { type FetchLike, GitHubHttpError } from "./github.ts";
import type { CollectionMessage } from "./messages.ts";
import {
  isConfigComplete,
  loadCollectionQueue,
  loadConfig,
  saveCollectionQueue,
  saveFlushStatus,
} from "./storage.ts";

/**
 * Every write to the collection queue, in one realm and one line (ADR 0029).
 *
 * The popup and the worker are two JavaScript realms, and `chrome.storage` has
 * no transactions: a toggle recorded by the popup while the worker settled a
 * flush would be a read-modify-write race on one key, and one of the two would
 * be lost. So the popup never writes — it messages the worker, and the worker
 * runs toggles and flushes strictly one after another. A toggle made during a
 * slow flush waits its turn; the popup has already drawn it.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => {});
  return next;
}

export function recordToggle(
  message: Extract<CollectionMessage, { type: "tiro-collection-toggle" }>,
): Promise<void> {
  return serial(async () => {
    const config = await loadConfig();
    if (!isConfigComplete(config)) return;
    const page = { slug: message.op.slug, member: message.member };
    const queue = enqueue(
      pruneSent(await loadCollectionQueue(config), page, Date.now()),
      message.op,
      message.published,
    );
    await saveCollectionQueue(config, queue);
  });
}

export interface FlushReport {
  /** Pending ops before the flush. */
  pending: number;
  ok: boolean;
  committed: string | null;
  refused: number;
}

/**
 * Flush whatever is pending, now.
 *
 * A failure keeps the queue exactly as it was and records why, so the next
 * popup can say so and the next flush retries. Nothing is lost by failing:
 * every op is idempotent, so retrying one that in fact landed is a no-op.
 */
export function flushNow(fetchImpl: FetchLike = fetch): Promise<FlushReport> {
  return serial(async () => {
    const config = await loadConfig();
    if (!isConfigComplete(config)) {
      return { pending: 0, ok: true, committed: null, refused: 0 };
    }
    // Expired overlay goes on every save, not only on the next toggle, so
    // storage does not keep a saved tick the site caught up with long ago.
    const queue = pruneSent(
      await loadCollectionQueue(config),
      null,
      Date.now(),
    );
    const pending = pendingOps(queue);
    if (pending.length === 0) {
      return { pending: 0, ok: true, committed: null, refused: 0 };
    }
    const at = new Date().toISOString();
    try {
      const outcome = await flushCollections(config, pending, fetchImpl);
      await saveCollectionQueue(
        config,
        settleFlush(
          queue,
          outcome.sent,
          new Set(outcome.refused.map((op) => op.id)),
          at,
        ),
      );
      await saveFlushStatus(config, {
        at,
        ok: true,
        ...(outcome.refused.length > 0
          ? { refused: outcome.refused.length }
          : {}),
      });
      return {
        pending: pending.length,
        ok: true,
        committed: outcome.committed,
        refused: outcome.refused.length,
      };
    } catch (error) {
      await saveFlushStatus(config, {
        at,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof GitHubHttpError
          ? { httpStatus: error.status }
          : {}),
      });
      return {
        pending: pending.length,
        ok: false,
        committed: null,
        refused: 0,
      };
    }
  });
}
