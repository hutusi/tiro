/**
 * Counts one kind of failure in a row, and says when to stop repeating it.
 *
 * A dead provider fails every article the same way, and each article pays its
 * full retries and timeouts to find that out again — at a run budget of fifty
 * minutes, that is a run spent learning one fact. The caller decides what
 * counts: `run` counts only provider outages (ADR 0032), because a bad article
 * says nothing about the next one; `backfill-titles` counts every failure,
 * since each of its calls is the same small request.
 */
export interface Breaker {
  /** Something went through, so the failures were not a streak. */
  succeeded(): void;
  /** Another failure of the kind being counted. */
  failed(): void;
  /** Failures counted since the last success. */
  readonly count: number;
  /** True once `limit` failures have come in a row. */
  readonly tripped: boolean;
}

export function createBreaker(limit: number): Breaker {
  let count = 0;
  return {
    succeeded() {
      count = 0;
    },
    failed() {
      count += 1;
    },
    get count() {
      return count;
    },
    get tripped() {
      return count >= limit;
    },
  };
}
