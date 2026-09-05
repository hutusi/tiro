/**
 * Reading preferences, kept in the browser's localStorage (ADR 0014).
 *
 * One definition of the keys and ranges: the pre-paint script in Base.astro
 * receives `PREF_SCRIPT_VARS` through `define:vars`, and the controls that
 * change a preference (settings page, reader toolbar, library view toggle) go
 * through the `tiroPrefs` object that script exposes — so nothing else in the
 * site spells a key or a bound.
 */
export const PAPERS = ["cream", "white", "dark"] as const;
export type Paper = (typeof PAPERS)[number];

export const READER_MODES = ["both", "translation", "original"] as const;
export type ReaderMode = (typeof READER_MODES)[number];

export const LIBRARY_VIEWS = ["list", "cards"] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/** Reader body size in px; the translation pane renders one px smaller. */
export const FONT_SIZE = { min: 15, max: 26, default: 19, step: 1 } as const;

export const PREF_KEYS = {
  paper: "tiro-paper",
  fontSize: "tiro-font-size",
  libraryView: "tiro-library-view",
  readerMode: "tiro-reader-mode",
  /** The pre-redesign dark toggle. Read once, migrated to `paper`, removed. */
  legacyTheme: "theme",
} as const;

export function isPaper(value: unknown): value is Paper {
  return (
    typeof value === "string" && (PAPERS as readonly string[]).includes(value)
  );
}

/** A stored size is untrusted text: anything unparsable is the default,
 * anything out of range is pulled back to the nearest bound. */
export function clampFontSize(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return FONT_SIZE.default;
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(n)));
}

/** JSON-safe bundle for the inline pre-paint script (`define:vars`). */
export const PREF_SCRIPT_VARS = {
  PAPERS,
  READER_MODES,
  LIBRARY_VIEWS,
  FONT_SIZE,
  PREF_KEYS,
} as const;
