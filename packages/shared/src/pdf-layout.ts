import { getDocumentProxy } from "unpdf";

/**
 * Reading a PDF's layout — what size a run of text is set in, what font, and
 * where it sits on the page (ADR 0028).
 *
 * pdf.js has carried this all along. `extractText` flattens it to strings,
 * which is why ADR 0026 concluded a model had to infer structure from wording;
 * that was a limitation of one convenience function mistaken for a limitation
 * of the format.
 */

/** One run of text, as pdf.js hands it over. */
export interface PdfTextItem {
  text: string;
  /** Resolved font name with its subset prefix removed. */
  font: string;
  /** Rendered size in points — pdf.js reports this as the item's height. */
  size: number;
  x: number;
  y: number;
  /** 1-based, so it reads like a page number. */
  page: number;
  /** Rendered width of this run, used to measure the font's advance. */
  width: number;
  /** pdf.js says a line ended after this run. */
  endsLine: boolean;
  /** Set in a fixed-width face — see `monospaceFonts`. */
  mono: boolean;
}

export interface PdfLayout {
  items: PdfTextItem[];
  totalPages: number;
  /** The size most of the document's *text* is set in. */
  bodySize: number;
  /** Distinct sizes above the body, largest first — heading levels in order. */
  headingSizes: number[];
  /** Families measured as fixed-width, or recognised by name where there was
   * too little of them to measure. */
  monospaceFonts: ReadonlySet<string>;
  /**
   * Is there enough here to build Markdown from?
   *
   * False for a document set entirely in one size and one font, where every
   * rule below would find nothing and the model pass of ADR 0026 is the better
   * answer.
   */
  legible: boolean;
}

/**
 * An embedded font arrives as `ABCDEF+RealName` — six uppercase letters and a
 * plus, identifying the subset rather than the face. Every name test below
 * would fail against the tag.
 */
export function fontFamily(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

/**
 * Does this font's *name* suggest a monospace face?
 *
 * The fallback, not the test. Names are whack-a-mole: `NimbusMonL` is Nimbus
 * Mono L and contains no "mono", which this missed until the advance-width
 * measurement below caught it. Used only where a font has too few runs to
 * measure.
 *
 * The `TT` clause is TeX's typewriter convention — `CMTT10`, `SFTT1000` — whose
 * names say nothing else about being fixed-width.
 */
export function isMonospaceFontName(name: string): boolean {
  const family = fontFamily(name);
  return (
    /mono|monl|courier|consol|menlo|inconsolata|typewriter/i.test(family) ||
    /(^|[^A-Za-z])[A-Z]*TT\d/.test(family)
  );
}

/** Runs shorter than this say little about a font's advance — a two-character
 * run of an `i` and an `l` looks fixed-width in any face. */
const ADVANCE_MIN_CHARS = 4;

/**
 * Below this, fall back to the name.
 *
 * Measured against the false positives it exists to exclude: a serif italic at
 * 7 runs, a bold Arial at 5 and a TeX math face at 4 all cleared the variation
 * test, while the genuine fixed-width faces with enough text to judge had 10
 * and 19. A handful of runs is not evidence about a font.
 */
const ADVANCE_MIN_RUNS = 8;

/**
 * And they have to differ.
 *
 * `Arial-BoldMT` measured a coefficient of variation of exactly zero across
 * five runs — because they were five copies of the same string, and identical
 * text advances identically in any face whatsoever. Uniformity is only evidence
 * when the things being compared are different.
 */
const ADVANCE_MIN_DISTINCT = 4;

/**
 * How uniform an advance has to be to count as fixed-width.
 *
 * Measured rather than picked: across four documents, `Courier` came out at a
 * coefficient of variation of 0.000 and `NimbusMonL` at 0.003, while every
 * proportional face sat between 0.046 and 0.182. There is an order of magnitude
 * of daylight, so the threshold is not delicate.
 */
const ADVANCE_MAX_VARIATION = 0.02;

/**
 * Which families are fixed-width, measured from the text itself.
 *
 * pdf.js does not set `isMonospace` for embedded fonts — the resolved objects
 * carry `vertical`, and `bold`/`italic` only for the standard fourteen — so ADR
 * 0028 originally settled for matching names. Measuring is better and is what
 * the data supports: a monospace face advances the same distance for every
 * character, whatever it happens to be called.
 */
export function monospaceFonts(
  items: readonly PdfTextItem[],
): ReadonlySet<string> {
  const advances = new Map<string, number[]>();
  const distinct = new Map<string, Set<string>>();
  for (const item of items) {
    const text = item.text.trim();
    if (text.length < ADVANCE_MIN_CHARS || item.width <= 0 || item.size <= 0) {
      continue;
    }
    const list = advances.get(item.font) ?? [];
    // Normalised by size, so one family set at two sizes is still one family.
    list.push(item.width / text.length / item.size);
    advances.set(item.font, list);
    const texts = distinct.get(item.font) ?? new Set<string>();
    texts.add(text);
    distinct.set(item.font, texts);
  }

  const fixed = new Set<string>();
  const fonts = new Set(items.map((item) => item.font));
  for (const font of fonts) {
    const list = advances.get(font) ?? [];
    if (
      list.length < ADVANCE_MIN_RUNS ||
      (distinct.get(font)?.size ?? 0) < ADVANCE_MIN_DISTINCT
    ) {
      // Too little to measure; fall back to what it is called.
      if (isMonospaceFontName(font)) fixed.add(font);
      continue;
    }
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    if (mean <= 0) continue;
    const variance =
      list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
    if (Math.sqrt(variance) / mean <= ADVANCE_MAX_VARIATION) fixed.add(font);
  }
  return fixed;
}

/** Bold by name, including LaTeX's `-Medi`, which is the bold face of the
 * Nimbus families every one of the measured papers uses. */
export function isBoldFont(name: string): boolean {
  return /bold|-medi|black|heavy|semib/i.test(fontFamily(name));
}

/** Sizes within this many points are one size. LaTeX bodies measure 9.7, 10 and
 * 10.9 across three papers, and neighbours inside one document differ by
 * tenths, so comparing exactly shatters a single logical size into several. */
const SIZE_TOLERANCE = 0.5;

/**
 * The size most of the document's text is set in.
 *
 * Weighted by characters, not by items. Measured, and the difference is not
 * subtle: a median over items returned 8pt for a document whose body is 11pt,
 * because short 8pt code fragments outnumber long prose lines — and then every
 * body line classified as a heading.
 */
export function bodySize(items: readonly PdfTextItem[]): number {
  const weight = new Map<number, number>();
  for (const item of items) {
    const text = item.text.trim();
    if (text === "") continue;
    const key = Math.round(item.size * 10) / 10;
    weight.set(key, (weight.get(key) ?? 0) + text.length);
  }
  if (weight.size === 0) return 0;

  // Merge neighbours into the heavier bucket before choosing, so a size split
  // across 9.7 and 9.8 is not beaten by one that happens to be uniform.
  const merged = new Map<number, number>();
  for (const [size, chars] of [...weight.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const near = [...merged.keys()].find(
      (k) => Math.abs(k - size) <= SIZE_TOLERANCE,
    );
    if (near === undefined) merged.set(size, chars);
    else merged.set(near, (merged.get(near) ?? 0) + chars);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

/**
 * Distinct sizes above the body, largest first.
 *
 * Deliberately unweighted. In the measured papers the headings are a rounding
 * error beside the body — 241 characters at 12pt in a 16,000-character paper,
 * 62 at 14.3pt in another — so a volume threshold would discard exactly what is
 * being looked for.
 */
export function headingSizes(
  items: readonly PdfTextItem[],
  body: number,
): number[] {
  const sizes: number[] = [];
  for (const item of items) {
    if (item.text.trim() === "") continue;
    const size = Math.round(item.size * 10) / 10;
    if (size <= body + SIZE_TOLERANCE) continue;
    if (sizes.some((s) => Math.abs(s - size) <= SIZE_TOLERANCE)) continue;
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

export interface PdfLayoutOptions {
  /** Refuse past this rather than truncate — the cap of ADR 0026. */
  maxPages: number;
}

/**
 * Read every text run in the document, with its font and position.
 *
 * `getOperatorList()` is called per page and its result thrown away: it is what
 * populates `commonObjs`, and without it every font lookup throws "isn't
 * resolved yet". Nothing in the text-content API says so, and it is the most
 * likely reason this data looked unavailable (ADR 0028 clause 2).
 *
 * **Consumes `bytes`** — pdf.js detaches the buffer, as `extractPdfText` also
 * notes.
 */
export async function readPdfLayout(
  bytes: Uint8Array,
  options: PdfLayoutOptions,
): Promise<PdfLayout> {
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(bytes);
  } catch (error) {
    throw new Error(`cannot read the PDF: ${String(error)}`);
  }
  if (doc.numPages > options.maxPages) {
    throw new Error(
      `too many pages: ${doc.numPages} (cap ${options.maxPages})`,
    );
  }

  const items: PdfTextItem[] = [];
  // Resolved names are cached across pages: the same font reappears on every
  // page and the lookup is not free.
  const names = new Map<string, string>();
  for (let page = 1; page <= doc.numPages; page += 1) {
    const proxy = await doc.getPage(page);
    await proxy.getOperatorList();
    const content = await proxy.getTextContent();
    for (const raw of content.items) {
      const item = raw as {
        str?: string;
        fontName?: string;
        height?: number;
        width?: number;
        transform?: number[];
        hasEOL?: boolean;
      };
      if (item.str === undefined || item.str === "") continue;
      const key = item.fontName ?? "";
      let font = names.get(key);
      if (font === undefined) {
        let resolved = key;
        try {
          const object = proxy.commonObjs.get(key) as { name?: string } | null;
          resolved = object?.name ?? key;
        } catch {
          // A font that will not resolve is not worth failing a document over;
          // the name tests below simply find nothing in it.
        }
        font = fontFamily(resolved);
        names.set(key, font);
      }
      items.push({
        text: item.str,
        font,
        size: item.height ?? 0,
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0,
        page,
        width: item.width ?? 0,
        endsLine: item.hasEOL === true,
        // Filled in below, once every run has been seen: whether a font is
        // fixed-width is a property of all of its runs, not of any one.
        mono: false,
      });
    }
  }

  const body = bodySize(items);
  const headings = headingSizes(items, body);
  const fixed = monospaceFonts(items);
  for (const item of items) item.mono = fixed.has(item.font);

  return {
    items,
    totalPages: doc.numPages,
    bodySize: body,
    headingSizes: headings,
    monospaceFonts: fixed,
    // Either signal is enough to build something better than flat text: a size
    // hierarchy gives headings, monospace gives fences.
    legible: headings.length > 0 || items.some((item) => item.mono),
  };
}
