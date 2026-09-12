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

/**
 * Which clipper *build* wrote the article — `git describe` output, e.g.
 * `ext-v0.11.0-8-gbe3dcc8`, or a bare commit when no release tag is reachable.
 *
 * `clipper_version` above names a release, and the extension is normally run by
 * loading `dist/` unpacked, which is built from whatever is checked out. So the
 * version says which release a build is *near*, not which build it is: every
 * clip taken across the seven commits of one branch reports the same number,
 * and a minor that batches several fixes cannot say which of them a given
 * article predates. This can, via `git merge-base --is-ancestor`.
 *
 * A `-dirty` suffix means the build came from a modified working tree, so the
 * commit names the nearest thing to it rather than the thing itself. That is
 * the common case for an unpacked build and the reason the suffix is kept
 * rather than trimmed.
 *
 * Optional and additive for the same reason `clipper_version` is — no
 * `tiro.schema` bump — and, like it, named on both schemas below.
 */
const clipperCommit = z.string().optional();

/**
 * The URL the body was actually read from, when that is not the URL the article
 * is filed under.
 *
 * `url` is the article's identity, and for a publisher whose pages are
 * canonicalized (arXiv today) that is a URL nobody necessarily visited: clip
 * `/pdf/2404.19756v1`, get an article filed at `/abs/2404.19756` whose body came
 * from `/html/2404.19756v1`. Without this, nothing records which of the three
 * produced the text, and the version — deliberately not part of the identity —
 * would be lost entirely.
 *
 * Written only when it differs from `url`, so an ordinary clip is unchanged.
 * Generic rather than an arXiv-shaped `{id, version}` block, because what a
 * later audit needs is the URL to re-fetch, and the next publisher rule would
 * otherwise need its own field.
 *
 * Optional and additive like `clipper_version` above — no `tiro.schema` bump —
 * and named on both schemas for the same reason: a field the read side omits is
 * deleted the first time the article is processed.
 */
const sourceUrl = z.string().optional();

/**
 * The article's title, translated into the vault's target language.
 *
 * `zh.md` is a bare body that must stay strictly 1:1 block-aligned with
 * `index.md` (ADR 0003), so a translated title has nowhere to live in it, and
 * the site can only *derive* one from a body that opens with its own title —
 * which a scraped page does not do. Frontmatter is the one place left, and this
 * is it (ADR 0016).
 *
 * Named on the article schema **only**, unlike the three fields above. Those are
 * written by the extension, so omitting them here would delete them on the first
 * processor round-trip. This one is written by the processor, and a re-clip
 * *should* drop it: the page's title may have changed, and the same clip clears
 * `tiro.processed_at`, so the next run regenerates it against the new title.
 *
 * Trimmed and non-empty, because whitespace is not a translation — a blank
 * string is truthy on the site, so it would suppress the derived fallback and
 * render an empty line where the title belongs. `.trim()` rather than a refusal
 * so a hand-edit with stray whitespace is normalized on the next write instead
 * of being preserved and rendered.
 *
 * Optional and additive, so no `tiro.schema` bump.
 */
const titleZh = z.string().trim().min(1).optional();

/**
 * The summary, written a second time in the article's own language.
 *
 * `summary` is always in the target language — the LLM writes it there rather
 * than translating it — so an article has no summary in its own language at all,
 * and the reader's title block shows 摘要 with nothing opposite it while every
 * other row on the page is a pair. This is the other half.
 *
 * `summary_orig`, not a rename of `summary` to `summary_zh`: every article in
 * every vault already carries `summary` meaning the target-language one, and
 * renaming it is exactly the breaking change `tiro.schema` exists to version.
 * "orig" is the reader's own word for that column (原文).
 *
 * Written only for an article that is not already in the target language, and
 * named on the article schema only — and trimmed non-empty — for the same
 * reasons as `title_zh`.
 */
const summaryOrig = z.string().trim().min(1).optional();

/**
 * Keep this article out of every list, the search index and the sitemap. It is
 * still built, still processed, and still reachable at its own URL.
 *
 * **Unlisted is not private.** The site is public and slugs are deterministic
 * from the URL (ADR 0007), so anyone who knows the source URL can compute the
 * address; the slug spells out the domain and path besides. This hides an
 * article from anyone browsing the site, not from anyone who goes looking for
 * it. Access control would have to sit in front of the site (ADR 0017).
 *
 * Set by hand in the vault — nothing *originates* it. Named here on the clip
 * schema all the same, because the clipper writes it: a re-clip rebuilds
 * `index.md` from scratch, so it reads the flag off the article it is about to
 * overwrite and carries it forward. Without that, an ordinary re-clip would
 * silently republish an article someone deliberately hid — unlike `title_zh`
 * and `summary_orig`, which a re-clip drops on purpose because they describe
 * content that just changed, this is a decision about the article that did not.
 *
 * Optional and additive, so no `tiro.schema` bump: an article without the key
 * means exactly what it meant before the key existed.
 */
const unlisted = z.boolean().optional();

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
  unlisted,
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
    clipper_version: clipperVersion,
    clipper_commit: clipperCommit,
    source_url: sourceUrl,
  }),
});
export type ClipFrontmatter = z.infer<typeof ClipFrontmatterSchema>;

/** Full frontmatter after the processor has (possibly) run. */
export const ArticleFrontmatterSchema = ClipFrontmatterSchema.extend({
  lang: z.string().min(2).optional(),
  title_zh: titleZh,
  summary: z.string().optional(),
  summary_orig: summaryOrig,
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
    clipper_version: clipperVersion,
    clipper_commit: clipperCommit,
    source_url: sourceUrl,
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

/**
 * The frontmatter block as plain YAML, with no contract validation at all —
 * null when there is no block, or when it is not a mapping.
 *
 * For reading one field off a file whose *other* fields are none of the
 * reader's business. `parseArticle` is the right tool almost everywhere, but it
 * is all-or-nothing: an article carrying a key from a newer schema, or a
 * hand-edit that broke an unrelated field, throws — and a caller that only
 * wanted to know whether the article is unlisted would take "invalid" for "no"
 * and act on it (ADR 0017). Shares `FRONTMATTER_RE`, for the reason its comment
 * above gives.
 *
 * Never use this to write. Anything that rewrites an article must go through
 * the schema, or it will persist whatever nonsense it read.
 */
export function parseFrontmatterLoose(
  fileText: string,
): Record<string, unknown> | null {
  const match = fileText.match(FRONTMATTER_RE);
  if (match?.[1] === undefined) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
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
