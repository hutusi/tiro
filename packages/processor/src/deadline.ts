/**
 * A wall-clock budget for one processor run.
 *
 * The workflow already caps the job with `timeout-minutes`, but that cap is a
 * kill: the commit step is skipped, so everything the run achieved — finished
 * articles included — is thrown away and redone from scratch next push. An
 * article too big to finish in one run can never converge that way.
 *
 * A deadline the processor checks itself turns that kill into a clean stop:
 * it abandons the current article, leaves it pending, and returns normally so
 * the checkpoint and the finished articles get committed.
 */

export class DeadlineExceededError extends Error {
  constructor(
    what: string,
    readonly remainingMs: number,
  ) {
    super(`run budget exhausted before ${what} (${remainingMs}ms remaining)`);
    this.name = "DeadlineExceededError";
  }
}

export interface Deadline {
  /** Milliseconds left; negative once the budget is blown. */
  remainingMs(): number;
  /** True when less than `needMs` remains — i.e. not worth starting. */
  expired(needMs?: number): boolean;
  /** `expired`, but throws so callers deep in a stage can bail out. */
  check(needMs: number, what: string): void;
}

/** `now` is injectable so tests drive the clock instead of sleeping. */
export function createDeadline(
  budgetMs: number,
  now: () => number = () => Date.now(),
): Deadline {
  const startedAt = now();
  const remainingMs = () => budgetMs - (now() - startedAt);
  const expired = (needMs = 0) => remainingMs() < needMs;
  return {
    remainingMs,
    expired,
    check(needMs, what) {
      if (expired(needMs)) throw new DeadlineExceededError(what, remainingMs());
    },
  };
}

/** A deadline that never fires — for `--dry-run` and for callers that opt out. */
export function unboundedDeadline(): Deadline {
  return {
    remainingMs: () => Number.POSITIVE_INFINITY,
    expired: () => false,
    check: () => {},
  };
}
