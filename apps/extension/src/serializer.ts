/**
 * Run async work strictly one after another, in the order it was asked for.
 *
 * Each call waits for the previous one to settle — resolve or reject — so a
 * failure never blocks the line and never reorders it. Used where arrival
 * order must be request order: the worker's writes to the collection queue,
 * and the popup's messages to the worker (ADR 0029).
 */
export function serializer(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}
