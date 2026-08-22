import matter from "gray-matter";
import { z } from "zod";

export const TIRO_SCHEMA_VERSION = 1;

/**
 * YAML parsers (js-yaml under gray-matter) turn unquoted ISO timestamps into
 * Date objects. Accept both and normalize to an ISO string.
 */
const isoDatetime = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.iso.datetime({ offset: true }),
);

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
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
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
    processed_at: isoDatetime.optional(),
    processor_version: z.string().optional(),
    summary_failed: z.boolean().optional(),
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

/** Parse and validate a full `index.md` file. Throws on schema violations. */
export function parseArticle(fileText: string): ParsedArticle {
  const { data, content } = matter(fileText);
  const frontmatter = ArticleFrontmatterSchema.parse(data);
  return { frontmatter, body: content.replace(/^\n+/, "") };
}

/**
 * Serialize an article back to `index.md` text. gray-matter (js-yaml) handles
 * YAML quoting/escaping — titles containing `: " #` etc. must never be
 * templated by hand.
 */
export function stringifyArticle(
  frontmatter: ArticleFrontmatter,
  body: string,
): string {
  return matter.stringify(`${body.trimEnd()}\n`, frontmatter);
}
