/**
 * Which lines of a PDF are running furniture: the headers and footers it
 * repeats page after page (ADR 0026, and ADR 0028 clause 7b for the layout
 * path). One decision for both paths. They used to carry a copy of the rule
 * each, and ADR 0028 requires the two to agree.
 *
 * Deterministic, never asked of a model: "this line, modulo its numbers, tops
 * eleven of fifteen pages" is a fact the text already contains, and a model
 * licensed to delete deletes more than furniture. Narrow for the same reason.
 * A false positive costs a line of content, so the rule errs toward leaving
 * things alone.
 */

/** How much of the document a line must top or tail before it is furniture
 * rather than content. Below this a repeated line is more likely a section
 * label that happens to recur. */
const FURNITURE_SHARE = 0.6;

/** Longer than this and it is a sentence that repeated, not a running head. */
const FURNITURE_MAX_CHARS = 100;

/** Two pages sharing a line is a coincidence; the share cannot tell furniture
 * from content until there are a few pages. */
const FURNITURE_MIN_PAGES = 3;

/**
 * How many lines deep furniture may stack at a page's edge.
 *
 * JSTOR stamps every page of a scan with two footer lines ("This content
 * downloaded from …" over "All use subject to JSTOR Terms and Conditions").
 * Only the outermost was ever a candidate, so the other survived on all
 * thirteen pages of the 1973 paper that showed it. A line further in is a
 * candidate only once the line outside it was dropped, and by the same rule.
 */
const FURNITURE_DEPTH = 2;

/**
 * The fewest pages of one parity a running head must top.
 *
 * A book or journal alternates its heads, verso and recto: "384 P. R. HALMOS
 * [April" on one side, "1973] THE LEGEND OF JOHN VON NEUMANN 385" on the
 * other. Each is on about half the pages, below the share, and both survived.
 * Counting each parity on its own catches them. This floor keeps a section
 * label that happens to top pages 1 and 3 of a short document.
 */
const PARITY_MIN_PAGES = 3;

/**
 * A line's furniture key, or undefined when it can never be furniture.
 *
 * Digit runs become `#`, so "Page 3 of 15" and "Page 4 of 15" are one footer.
 * Punctuation folds to a space: an OCR layer reads one running head as
 * "P. R. HALMOS" on one page and "P, R. HALMOS" on the next. Letters are left
 * alone, so a heading fused to other text keeps a key of its own.
 */
function furnitureKey(line: string): string | undefined {
  const text = line.trim();
  if (text.length > FURNITURE_MAX_CHARS) return undefined;
  const key = text
    .normalize("NFKC")
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
  return key === "" ? undefined : key;
}

/**
 * For each page's non-empty lines, in reading order, the indexes that are
 * furniture.
 */
export function furnitureLines(
  pages: readonly (readonly string[])[],
): Set<number>[] {
  const drop = pages.map(() => new Set<number>());
  const count = pages.length;
  if (count < FURNITURE_MIN_PAGES) return drop;

  const parityPages = [Math.ceil(count / 2), Math.floor(count / 2)];
  // The next candidate from each edge. Kept apart so a one-line page is never
  // dropped twice, once from each side.
  const top = pages.map(() => 0);
  const bottom = pages.map((lines) => lines.length - 1);

  for (const fromTop of [true, false]) {
    // A page that keeps its edge line offers the same line again next round,
    // so nothing further in is ever a candidate past a line that stayed.
    for (let depth = 0; depth < FURNITURE_DEPTH; depth += 1) {
      const at = pages.map((_, page) => {
        if ((top[page] ?? 0) > (bottom[page] ?? -1)) {
          return undefined;
        }
        return fromTop ? top[page] : bottom[page];
      });
      const keys = at.map((index, page) =>
        index === undefined
          ? undefined
          : furnitureKey(pages[page]?.[index] ?? ""),
      );

      const total = new Map<string, number>();
      const byParity = [new Map<string, number>(), new Map<string, number>()];
      keys.forEach((key, page) => {
        if (key === undefined) return;
        total.set(key, (total.get(key) ?? 0) + 1);
        const side = byParity[page % 2];
        side?.set(key, (side.get(key) ?? 0) + 1);
      });

      keys.forEach((key, page) => {
        const index = at[page];
        const side = page % 2;
        const furniture =
          key !== undefined &&
          index !== undefined &&
          ((total.get(key) ?? 0) >= count * FURNITURE_SHARE ||
            (byParity[side]?.get(key) ?? 0) >=
              Math.max(
                PARITY_MIN_PAGES,
                (parityPages[side] ?? 0) * FURNITURE_SHARE,
              ));
        if (!furniture) return;
        drop[page]?.add(index);
        if (fromTop) top[page] = index + 1;
        else bottom[page] = index - 1;
      });
    }
  }
  return drop;
}
