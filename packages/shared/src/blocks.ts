import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface Block {
  /** mdast node type of the top-level block (paragraph, heading, code, …). */
  type: string;
  /** The block's exact source text, sliced from the original document. */
  text: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/**
 * Block types a translation must reproduce byte-for-byte. Code is obvious;
 * `$$…$$` math is the same kind of content — a notation the model has no
 * business rewriting, where a single altered character changes the meaning
 * or stops parsing altogether. Exported so the processor can guarantee it
 * never sends to the LLM anything `checkAlignment` will demand back unchanged.
 */
export const VERBATIM_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "code",
  "math",
]);

/**
 * Split a markdown body (frontmatter already stripped — see parseArticle)
 * into its top-level blocks. Block text is sliced from the source by mdast
 * offsets, never re-stringified, so untouched blocks stay byte-identical —
 * the translation alignment contract (ADR 0003) depends on this. mdast
 * guarantees that blank lines inside fenced code do not split a block.
 *
 * remark-math is part of the parser so `$$…$$` is one `math` block for the
 * same reason: without it, display math containing a blank line splits into
 * two half-delimited paragraphs, which the site (rendering block by block)
 * can never typeset and the translator sees as two broken fragments.
 */
export function splitBlocks(body: string): Block[] {
  const tree = parser.parse(body) as Root;
  return tree.children.map((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error(
        `mdast node of type "${node.type}" has no source position`,
      );
    }
    return { type: node.type, text: body.slice(start, end) };
  });
}

/** Reassemble blocks into a canonical markdown body (blank-line separated). */
export function joinBlocks(blocks: readonly Block[]): string {
  return `${blocks
    .map((b) => b.text)
    .join("\n\n")
    .trimEnd()}\n`;
}

export interface AlignmentResult {
  ok: boolean;
  errors: string[];
}

/**
 * Verify the 1:1 alignment contract between an original body's blocks and a
 * translation's blocks: equal count, equal type per index, and byte-identical
 * code and math blocks (translators must copy them verbatim).
 */
export function checkAlignment(
  original: readonly Block[],
  translated: readonly Block[],
): AlignmentResult {
  const errors: string[] = [];
  if (original.length !== translated.length) {
    errors.push(
      `block count mismatch: original ${original.length}, translated ${translated.length}`,
    );
    return { ok: false, errors };
  }
  original.forEach((block, i) => {
    const other = translated[i];
    if (other === undefined) return;
    if (block.type !== other.type) {
      errors.push(
        `block ${i}: type mismatch (original "${block.type}", translated "${other.type}")`,
      );
    } else if (
      VERBATIM_BLOCK_TYPES.has(block.type) &&
      block.text !== other.text
    ) {
      errors.push(`block ${i}: ${block.type} block was altered by translation`);
    }
  });
  return { ok: errors.length === 0, errors };
}
