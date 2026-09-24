import { isValidCollectionId } from "@tiro/shared";

/**
 * Recognizing a Tiro page (ADR 0029).
 *
 * By marker, never by hostname: a self-hosted deployment on any domain, and
 * every preview URL, has to be recognized the same way. The site puts
 * `<meta name="tiro:site">` on every page and a `#tiro-page` JSON island on
 * every article page.
 *
 * The marker is **untrusted input**. Any page can carry it, so everything read
 * here is validated, titles are only ever set as text, and the one thing a
 * forged page could cost the owner — an add for an article that is not theirs
 * — is refused at flush time by checking the vault itself.
 */

/** What the injected function hands back. */
export interface TiroMarker {
  site: boolean;
  payload: string | null;
}

/**
 * Runs inside the tab, through `chrome.scripting.executeScript({ func })`.
 *
 * Chrome serializes this function's *source* and runs it in the page, so it
 * must reference nothing outside itself — no import, no constant from this
 * module, not even a helper defined beside it. Kept to two DOM reads for that
 * reason; everything that needs the rest of the codebase happens in
 * `parseTiroPage`, back in the popup.
 */
export function readTiroMarker(): TiroMarker {
  return {
    site: document.querySelector('meta[name="tiro:site"]') !== null,
    payload: document.getElementById("tiro-page")?.textContent ?? null,
  };
}

export interface CatalogEntry {
  id: string;
  title: string;
}

export type TiroPage =
  | {
      kind: "article";
      slug: string;
      /** The collections the *deployed* site says this article is in. */
      member: string[];
      catalog: CatalogEntry[];
    }
  /** A Tiro page that is not an article — the library, search, settings — or
   * an article page whose payload could not be read. Nothing to toggle, and
   * nothing worth clipping either: it is a Tiro site, whoever runs it. */
  | { kind: "site" };

/** A slug as `slugForUrl` makes them — or as a local import's is. Loose on
 * purpose: this only has to stop something that is not a path segment. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** What the popup should make of the tab, or null for an ordinary page. */
export function parseTiroPage(marker: unknown): TiroPage | null {
  if (typeof marker !== "object" || marker === null) return null;
  const { site, payload } = marker as Partial<TiroMarker>;
  if (site !== true) return null;
  if (typeof payload !== "string") return { kind: "site" };

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return { kind: "site" };
  }
  if (typeof data !== "object" || data === null) return { kind: "site" };
  const d = data as Record<string, unknown>;
  // A future payload version is not something this build can read. Showing
  // it as a plain Tiro page is honest; guessing at its fields is not.
  if (d.v !== 1 || typeof d.slug !== "string" || !SLUG_RE.test(d.slug)) {
    return { kind: "site" };
  }

  const catalog: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(d.collections) ? d.collections : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, title } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !isValidCollectionId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    catalog.push({
      id,
      title: typeof title === "string" && title.trim() !== "" ? title : id,
    });
  }
  const member = Array.isArray(d.member)
    ? d.member.filter(
        (id): id is string => typeof id === "string" && seen.has(id),
      )
    : [];
  return { kind: "article", slug: d.slug, member, catalog };
}
