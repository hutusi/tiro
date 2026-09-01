import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const TIRO_SCHEMA_VERSION = 1;

/**
 * YAML 1.1 parsers (e.g. js-yaml) turn unquoted ISO timestamps into Date
 * objects; the `yaml` package keeps them strings. Accept both and normalize
 * to an ISO string so hand-edited vault files can't break the schema.
 */
const isoDatetime = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.iso.datetime({ offset: true }),
);

/**
 * Which clipper wrote the article, mirroring `processor_version` below.
 *
 * Declared on both schemas deliberately. Zod strips keys an object does not
 * name, and the processor round-trips frontmatter through
 * `ArticleFrontmatterSchema` on every run — so a field the write side records
 * and the read side omits is not merely unvalidated, it is deleted the first
 * time the article is processed.
 *
 * Optional, so articles clipped before this existed simply lack it, and the
 * document format is unchanged for anything that reads it (no `tiro.schema`
 * bump). What it buys is answering "which clipper produced this?" per article
 * rather than by comparing `clipped_at` against the git history of the
 * extension — which is how the arXiv equation regression had to be traced.
 */
const clipperVersion = z.string().optional();

/** Fields written by the extension at clip time. */
export const ClipFrontmatterSchema = z.object({
  url: z.url(),
  title: z.string().min(1),
  domain: z.string().min(1),
  clipped_at: isoDatetime,
  excerpt: z.string().optional(),
  author: z.string().optional(),
  published_at: z
    .preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string())
    .optional(),
  readability_failed: z.boolean().optional(),
  /**
   * The clipper found real math in the page DOM. The site uses it to decide
   * whether `$…$` is a math delimiter: on for these articles, off everywhere
   * else so that "it costs $5 to $10" is prose, not a formula. Optional, so
   * articles clipped before math support simply lack it (ADR 0009) — they
   * still get `$$…$$`, which is unambiguous.
   */
  has_math: z.boolean().optional(),
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
    clipper_version: clipperVersion,
  }),
});
export type ClipFrontmatter = z.infer<typeof ClipFrontmatterSchema>;

/** Full frontmatter after the processor has (possibly) run. */
export const ArticleFrontmatterSchema = ClipFrontmatterSchema.extend({
  lang: z.string().min(2).optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
    clipper_version: clipperVersion,
    processed_at: isoDatetime.optional(),
    processor_version: z.string().optional(),
    summary_failed: z.boolean().optional(),
    translation_failed: z.boolean().optional(),
  }),
});
export type ArticleFrontmatter = z.infer<typeof ArticleFrontmatterSchema>;

/** An article needs processing iff the processed marker is absent. */
export function needsProcessing(frontmatter: ArticleFrontmatter): boolean {
  return frontmatter.tiro.processed_at === undefined;
}

export interface ParsedArticle {
  frontmatter: ArticleFrontmatter;
  /** Markdown body with the frontmatter fence stripped. */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Length of the leading frontmatter block, delimiters included, or null when
 * there is none.
 *
 * Exported so a tool that rewrites the body in place can find where it starts
 * without re-serializing the YAML — which would reformat frontmatter nobody
 * asked it to touch. Sharing the pattern with `parseArticle` is the point: a
 * second copy drifted on `\r\n`, and the repair then treated an article's YAML
 * as prose and refused the article as misaligned.
 */
export function frontmatterLength(fileText: string): number | null {
  return fileText.match(FRONTMATTER_RE)?.[0].length ?? null;
}

/** Parse and validate a full `index.md` file. Throws on schema violations. */
export function parseArticle(fileText: string): ParsedArticle {
  const match = fileText.match(FRONTMATTER_RE);
  if (match?.[1] === undefined) {
    throw new Error("article has no frontmatter block");
  }
  const frontmatter = ArticleFrontmatterSchema.parse(parseYaml(match[1]));
  const body = fileText.slice(match[0].length).replace(/^\n+/, "");
  return { frontmatter, body };
}

/**
 * Serialize an article back to `index.md` text. The `yaml` serializer handles
 * quoting/escaping — titles containing `: " #` etc. must never be templated
 * by hand. (`yaml` rather than gray-matter because this must bundle cleanly
 * for the extension: gray-matter requires `fs` at module load.)
 */
export function stringifyArticle(
  frontmatter: ArticleFrontmatter,
  body: string,
): string {
  const yamlText = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yamlText}\n---\n\n${body.trimEnd()}\n`;
}
