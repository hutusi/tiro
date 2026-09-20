/**
 * Identity for a document that came off somebody's disk (ADR 0027).
 *
 * Every article is filed under a URL and the URL is the identity (ADR 0007).
 * A local file has none, so one is built from the filename — the name the
 * owner already uses — under a `local:` scheme that says plainly there is
 * nothing to open.
 *
 * No slug rule changes to make this work: `local:report.pdf` has an empty
 * hostname and a pathname of the filename, so `slugForUrl` yields
 * `report-pdf-<8hex>` by the rules that were already there, and
 * `canonicalizeUrl` declines anything that is not http(s) so it passes through
 * untouched.
 */

/** The scheme, and the whole of how a local document is recognised. */
const LOCAL_SCHEME = "local:";

/**
 * What `domain` carries when there is no host.
 *
 * The field is required and non-empty and there is no hostname to put in it.
 * A sentinel rather than something hostname-shaped, because the site prints
 * this as the source label and a reader has to be able to tell that the
 * document did not come from anywhere.
 */
export const LOCAL_DOCUMENT_DOMAIN = "local";

/**
 * The identity URL for a file of this name.
 *
 * Only the basename is kept. A path would put the owner's directory layout
 * into a public slug, and it says nothing about the document — two copies of
 * the same file in different folders are the same document, and the same name
 * in one folder is the same document next week.
 */
export function localDocumentUrl(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  // Every reserved character, which means encodeURIComponent and not
  // encodeURI. The difference is not cosmetic: encodeURI leaves `#` and `?`
  // alone because in a URL they *are* syntax, so `C# Notes.pdf` became
  // `local:C#%20Notes.pdf` — a fragment — and `normalizeUrl` stripped it to
  // `local:C`. Every filename containing a `#` collapsed onto that one
  // identity, and the second import silently overwrote the first.
  //
  // The reason originally given for encodeURI — that the alternative escapes
  // the dots and hyphens a filename is made of — was simply untrue:
  // encodeURIComponent leaves `. - _ ~ ! * ' ( )` alone.
  return `${LOCAL_SCHEME}${encodeURIComponent(base.trim())}`;
}

/**
 * Is this article's identity a local document rather than a web address?
 *
 * The one place that question is answered, because three components ask it
 * for three different reasons: the processor decides whether the bytes can be
 * re-fetched, the site decides whether to render a link, and the extension
 * decides whether it is re-importing.
 */
export function isLocalDocument(url: string): boolean {
  return url.startsWith(LOCAL_SCHEME);
}

/**
 * The filename behind a local identity, for display.
 *
 * Returns null for anything else, so a caller cannot accidentally print a web
 * article's URL as though it were a file.
 */
export function localDocumentName(url: string): string | null {
  if (!isLocalDocument(url)) return null;
  const raw = url.slice(LOCAL_SCHEME.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is not worth failing a render over; the raw form is
    // still the name, just uglier.
    return raw;
  }
}
