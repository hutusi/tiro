import {
  ArticleFrontmatterSchema,
  indexPath,
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
  const domain = new URL(input.url).hostname;
  const title = input.title.trim() || domain;
  const frontmatter = ArticleFrontmatterSchema.parse({
    url: input.url,
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
