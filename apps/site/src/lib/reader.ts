import { checkAlignment, splitBlocks } from "@tiro/shared";
import { type RenderOptions, renderBlockHtml } from "./render.ts";

export interface ReaderRow {
  original: string;
  translation: string;
}

export type ReaderView =
  | { kind: "single"; blocks: string[] }
  | { kind: "paired"; rows: ReaderRow[] }
  | { kind: "stacked"; original: string[]; translation: string[] };

/**
 * Prepare the reader's HTML at build time. Aligned translations render as
 * paired rows (side by side on wide screens); a translation that fails the
 * alignment check renders stacked rather than in misaligned rows; no
 * translation renders single-column.
 *
 * Both panes render with the same options: a formula the author wrote as
 * `$x$` is still a formula in the translation, and the two panes disagreeing
 * about that would be worse than either choice on its own.
 */
export function buildReaderView(
  body: string,
  zhBody: string | null,
  slug: string,
  options: RenderOptions = {},
): ReaderView {
  const render = (text: string): string => renderBlockHtml(text, slug, options);
  const originalBlocks = splitBlocks(body);
  if (zhBody === null) {
    return {
      kind: "single",
      blocks: originalBlocks.map((b) => render(b.text)),
    };
  }
  const zhBlocks = splitBlocks(zhBody);
  if (!checkAlignment(originalBlocks, zhBlocks).ok) {
    return {
      kind: "stacked",
      original: originalBlocks.map((b) => render(b.text)),
      translation: zhBlocks.map((b) => render(b.text)),
    };
  }
  return {
    kind: "paired",
    rows: originalBlocks.map((block, i) => ({
      original: render(block.text),
      translation: render(zhBlocks[i]?.text ?? ""),
    })),
  };
}
