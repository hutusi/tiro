/**
 * Saved sites — a page kept as a picture and a description rather than as
 * text, at `sites/<slug>/index.md` (ADR 0055).
 *
 * For the pages that are not reading: an interactive map, a visualization, a
 * tool. The extension writes what the tab showed — a screenshot, the page's
 * title and description, and the owner's note — and the processor adds an
 * introduction, a category and tags. Nothing else from the article pipeline
 * runs: no translation, no image downloads, no `zh.md`.
 *
 * A document of its own rather than an article with a marker, so that a page
 * can be both, and so that every article stage and every older build that
 * reads `articles/` never meets one. Its slug is an article's slug for the
 * same URL (invariant 2); the directory is what tells the two apart.
 *
 * Browser-safe and worker-safe: the extension's worker reaches this through
 * `@tiro/shared/documents` (invariant 6).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  FRONTMATTER_RE,
  isoDatetime,
  TIRO_SCHEMA_VERSION,
} from "./frontmatter.ts";

/**
 * The screenshot, as the site's frontmatter names it: `./assets/<id>.webp`,
 * the id being the first 12 hex digits of the SHA-256 of its bytes — a figure
 * snapshot's name (ADR 0039), and so the processor's own shape.
 *
 * That shape is what lets a re-save clean up after itself. A new screenshot is
 * a new name; the processor prunes a file of its own shape that nothing names
 * any more, and it counts this field as naming one. Held to exactly that
 * alphabet so `validate` and the site can join it onto a real path without
 * the value climbing out of `assets/`.
 */
export const PREVIEW_RE = /^\.\/assets\/([0-9a-f]{12}\.webp)$/;

/** The file a `preview` names, inside the site's `assets/`, or null if the
 * value is not one. */
export function previewFile(preview: string | undefined): string | null {
  if (preview === undefined) return null;
  return PREVIEW_RE.exec(preview)?.[1] ?? null;
}

/** The `preview` value for a screenshot file the extension committed. */
export function previewRef(file: string): string {
  const ref = `./assets/${file}`;
  if (!PREVIEW_RE.test(ref)) throw new Error(`not a screenshot name: ${file}`);
  return ref;
}

/**
 * Below this many characters of text, a page is taken to be one that builds
 * itself with script — an app, a map, a tool — rather than an article, and the
 * popup offers to save it as a site.
 *
 * The same number the processor uses to call a fetched page a shell
 * (`fetch.min_chars`, ADR 0034), which takes its default from here, so the two
 * cannot drift apart unless a vault sets its own.
 */
export const THIN_PAGE_CHARS = 500;

/** The longest note the popup accepts. Not enforced on read: a hand edit past
 * it is still the owner's note, and refusing the whole site over it would
 * unpublish it. */
export const SITE_NOTE_MAX_CHARS = 2000;

/** Fields the extension writes when a site is saved. */
export const SiteClipFrontmatterSchema = z.object({
  /** The site's identity, normalized as an article's is. */
  url: z.url(),
  title: z.string().min(1),
  domain: z.string().min(1),
  clipped_at: isoDatetime,
  /**
   * The page's own description of itself: `og:description`, then
   * `description`, then `twitter:description`. Shown beside the introduction,
   * and the most reliable thing the model is given to write it from.
   */
  description: z.string().trim().min(1).optional(),
  /** The screenshot — see `PREVIEW_RE`. Optional so a site written by hand
   * without one is still a site; the gallery draws a placeholder. */
  preview: z
    .string()
    .regex(PREVIEW_RE, "expected ./assets/<12 hex>.webp")
    .optional(),
  /**
   * Why the owner kept it, in their words, typed in the popup. The one field a
   * person writes outside a collection. Safe here because nothing rewrites a
   * site except to add what it derives, through this schema, and a re-save
   * reads the old note and offers it again.
   */
  note: z.string().trim().min(1).optional(),
  /** As an article's (ADR 0017): kept out of every list, still reachable. */
  unlisted: z.boolean().optional(),
  tiro: z.object({
    schema: z.literal(TIRO_SCHEMA_VERSION),
    clipper_version: z.string().optional(),
    clipper_commit: z.string().optional(),
    /**
     * The exact address that was saved, when it is not `url`. `normalizeUrl`
     * drops the fragment, and a single-page app often keeps its view there;
     * the identity follows the normalized URL, but "open site" goes here.
     */
    source_url: z.string().optional(),
  }),
});
export type SiteClipFrontmatter = z.infer<typeof SiteClipFrontmatterSchema>;

/** A site after the processor has (possibly) run. */
export const SiteFrontmatterSchema = SiteClipFrontmatterSchema.extend({
  lang: z.string().min(2).optional(),
  title_zh: z.string().trim().min(1).optional(),
  /** The introduction, in the vault's target language. */
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tiro: SiteClipFrontmatterSchema.shape.tiro.extend({
    processed_at: isoDatetime.optional(),
    processor_version: z.string().optional(),
    summary_failed: z.boolean().optional(),
  }),
});
export type SiteFrontmatter = z.infer<typeof SiteFrontmatterSchema>;

export interface ParsedSite {
  frontmatter: SiteFrontmatter;
  /** The page's text as the clipper read it — context for the introduction,
   * never shown. May be empty: that is what a canvas looks like. */
  body: string;
}

/** Parse and validate a site's `index.md`. Throws on schema violations. */
export function parseSite(fileText: string): ParsedSite {
  const match = fileText.match(FRONTMATTER_RE);
  if (match?.[1] === undefined) {
    throw new Error("site has no frontmatter block");
  }
  const frontmatter = SiteFrontmatterSchema.parse(parseYaml(match[1]));
  const body = fileText.slice(match[0].length).replace(/^\n+/, "");
  return { frontmatter, body };
}

/** Serialize a site back to `index.md` text, through `yaml` for the reasons
 * `stringifyArticle` gives. An empty body leaves no trailing blank lines. */
export function stringifySite(
  frontmatter: SiteFrontmatter,
  body: string,
): string {
  const yamlText = stringifyYaml(frontmatter).trimEnd();
  // Leading newlines only: a body opening with an indented code block keeps
  // its indent.
  const text = body.replace(/^\n+/, "").trimEnd();
  return `---\n${yamlText}\n---\n${text === "" ? "" : `\n${text}\n`}`;
}
