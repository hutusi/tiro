import {
  ArticleFrontmatterSchema,
  indexPath,
  normalizeUrl,
  slugForUrl,
  stringifyArticle,
  TIRO_SCHEMA_VERSION,
} from "@tiro/shared";

export interface ClipInput {
  url: string;
  title: string;
  markdown: string;
  excerpt?: string;
  author?: string;
  readabilityFailed?: boolean;
  /** The page carried real math, so the site may read `$…$` as a delimiter. */
  hasMath?: boolean;
  /** ISO timestamp; injected so tests are deterministic. */
  clippedAt: string;
}

export interface ClipFile {
  slug: string;
  /** Vault-relative path — deterministic from the slug alone, so a re-clip
   * always targets the same file. */
  path: string;
  content: string;
  title: string;
}

/** Assemble the complete index.md the extension commits — the write half of
 * the content contract, validated through the shared schema. */
export async function buildClipFile(input: ClipInput): Promise<ClipFile> {
  // Store the normalized URL, not location.href: the public site links
  // straight to it, so tracking params would be republished noise — and
  // keeping it identical to the slug's input means re-clips from any URL
  // variant produce byte-identical frontmatter.
  const url = normalizeUrl(input.url);
  const domain = new URL(url).hostname;
  const title = input.title.trim() || domain;
  const frontmatter = ArticleFrontmatterSchema.parse({
    url,
    title,
    domain,
    clipped_at: input.clippedAt,
    ...(input.excerpt !== undefined && input.excerpt !== ""
      ? { excerpt: input.excerpt }
      : {}),
    ...(input.author !== undefined && input.author !== ""
      ? { author: input.author }
      : {}),
    ...(input.readabilityFailed === true ? { readability_failed: true } : {}),
    ...(input.hasMath === true ? { has_math: true } : {}),
    tiro: { schema: TIRO_SCHEMA_VERSION },
  });

  const slug = await slugForUrl(input.url);
  return {
    slug,
    path: indexPath(slug),
    content: stringifyArticle(frontmatter, input.markdown),
    title,
  };
}
