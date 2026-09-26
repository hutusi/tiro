import { PdfRefusal } from "@tiro/shared";

/**
 * A failure that retrying will not change (ADR 0034).
 *
 * Most failures the processor meets are worth another try — a 503, a timeout,
 * a provider outage — and leaving the article pending is how it gets one
 * (invariant 3). A page that answered 404, a response that is not a document,
 * a host that resolves to a private address are not: pending, they are fetched
 * again on every run, and with a daily run that is one red run a day, forever,
 * for an article nobody can fix by waiting. Those throw this instead, and the
 * pipeline records them as `tiro.fetch_failed` and stops asking. `--force`
 * with the slug asks again.
 *
 * No `name` of its own, so it prints as a plain `Error` wherever it is logged.
 */
export class SettledRefusal extends Error {}

/** Whether an error is one of the processor's own settled refusals, or a PDF
 * refused for what it is (a scan, too many pages). */
export function isSettled(error: unknown): boolean {
  return error instanceof SettledRefusal || error instanceof PdfRefusal;
}

/**
 * The error for a response that was not a success. A 4xx is the server's
 * answer about this URL and settles it — except the three that mean "not now":
 * 408 (it timed out), 425 (too early) and 429 (slow down). A 5xx is the
 * server's trouble, and worth another try.
 */
export function httpFailure(status: number): Error {
  const settled =
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429;
  return settled
    ? new SettledRefusal(`HTTP ${status}`)
    : new Error(`HTTP ${status}`);
}
