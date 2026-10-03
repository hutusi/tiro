import {
  enqueue,
  pendingOps,
  pruneSent,
  settleFlush,
} from "./collection-queue.ts";
import { flushCollections } from "./collections-flush.ts";
import { type FetchLike, GitHubHttpError } from "./github.ts";
import type { CollectionMessage } from "./messages.ts";
import { serializer } from "./serializer.ts";
import {
  isConfigComplete,
  lastClippedAt,
  loadCollectionQueue,
  loadConfig,
  saveCollectionQueue,
  saveFlushStatus,
  type TiroExtensionConfig,
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
const serial = serializer();

export function recordToggle(
  message: Extract<CollectionMessage, { type: "tiro-collection-toggle" }>,
): Promise<void> {
  return serial(async () => {
    const config = await loadConfig();
    // Thrown, not returned: returning answered the popup `{ ok: true }` for a
    // toggle that was never recorded, which is the one reply it must not get.
    if (!isConfigComplete(config)) {
      throw new Error("the vault settings are incomplete");
    }
    // Only a site's membership says an overlay is no longer needed; with none
    // (a toggle made under a clip) only age prunes it.
    const page =
      message.member === null
        ? null
        : { slug: message.op.slug, member: message.member };
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
  /** Adds kept pending because the article they name was clipped moments
   * ago and the vault does not show it yet (ADR 0037). */
  deferred: number;
}

/**
 * How long after a clip an add for it is deferred, not refused, when the
 * vault does not show the article. GitHub's read side trails a write by
 * seconds; minutes past the clip, "not there" is an answer again — the clip
 * was removed elsewhere, or the vault was switched — and the add is dropped
 * as any other would be.
 */
export const JUST_CLIPPED_MS = 10 * 60 * 1000;

/** The slugs among these adds that this machine clipped within the window. */
async function justClipped(
  config: TiroExtensionConfig,
  slugs: readonly string[],
  now: number,
): Promise<Set<string>> {
  const recent = new Set<string>();
  for (const slug of new Set(slugs)) {
    const at = await lastClippedAt(config, slug);
    if (at !== null && now - Date.parse(at) <= JUST_CLIPPED_MS) {
      recent.add(slug);
    }
  }
  return recent;
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
      return { pending: 0, ok: true, committed: null, refused: 0, deferred: 0 };
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
      return { pending: 0, ok: true, committed: null, refused: 0, deferred: 0 };
    }
    const at = new Date().toISOString();
    try {
      const recent = await justClipped(
        config,
        pending.filter((op) => op.action === "add").map((op) => op.slug),
        Date.parse(at),
      );
      const outcome = await flushCollections(config, pending, fetchImpl, {
        justClipped: recent,
      });
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
        deferred: outcome.deferred.length,
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
        deferred: 0,
      };
    }
  });
}
