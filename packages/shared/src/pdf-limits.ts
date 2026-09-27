/**
 * What counts as a readable PDF, in numbers.
 *
 * These are the vault's defaults, and the vault may override them — but the
 * extension has to make the same judgement *before* anything is committed, and
 * it deliberately never reads vault config. Kept here rather than inlined in
 * the schema so the two sides cannot drift into disagreeing about what a scan
 * is, which is the failure where an import succeeds and then sits pending
 * forever because the processor refuses what the picker accepted.
 *
 * A vault that has tightened its own limits will still refuse an import the
 * extension allowed. That is the right way round: the refusal is recorded in
 * the run log, and the article stays pending rather than being filed wrong.
 *
 * Its own module, with no dependencies, because `config.ts` must not pull in
 * pdf.js and the extension must not pull in the config schema.
 */

/** Past this a document is refused rather than truncated: half a document
 * filed as the whole one is the silent kind of wrong. */
export const PDF_MAX_PAGES = 200;

/** The scan gate, averaged across the document. Real papers measure 2600-2800
 * chars/page, so this sits an order of magnitude below anything with prose on
 * it and still clears a document that is mostly figures. */
export const PDF_MIN_CHARS_PER_PAGE = 100;

/** The other half of that gate. An average is a sum, so one dense page among
 * nine scanned ones clears the line above on its own. */
export const PDF_MIN_PAGE_COVERAGE = 0.5;

/**
 * A PDF refused for what it is — a scan, too many pages, not readable as a
 * PDF at all — rather than for how it arrived. Nothing about retrying changes
 * the answer, so the processor records it and stops asking (ADR 0034, which
 * narrows ADR 0026's "stays pending").
 *
 * No `name` of its own on purpose: it prints as a plain `Error`, so the
 * extension's import message reads exactly as it did before the class existed.
 */
export class PdfRefusal extends Error {}
