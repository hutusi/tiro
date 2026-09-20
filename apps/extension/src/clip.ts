import {
  ArticleFrontmatterSchema,
  canonicalizeUrl,
  indexPath,
  isLocalDocument,
  LOCAL_DOCUMENT_DOMAIN,
  normalizeUrl,
  slugForUrl,
  stringifyArticle,
  TIRO_SCHEMA_VERSION,
} from "@tiro/shared";

export interface ClipInput {
  url: string;
  /**
   * The URL the markdown was actually read from, when that is not `url`.
   *
   * Only a canonicalizing publisher produces one: an arXiv paper is filed under
   * its abstract page but read from its HTML full text. Recorded so the article
   * says which form produced it, and so the arXiv version — deliberately not
   * part of the identity — is not lost.
   */
  sourceUrl?: string;
  title: string;
  markdown: string;
  excerpt?: string;
  author?: string;
  readabilityFailed?: boolean;
  /** The page carried real math, so the site may read `$…$` as a delimiter. */
  hasMath?: boolean;
  /** ISO timestamp; injected so tests are deterministic. */
  clippedAt: string;
  /**
   * The extension's own version, recorded so an article says what produced it.
   * Injected rather than read from the manifest here for the same reason
   * `clippedAt` is: this function stays pure and testable.
   */
  clipperVersion: string;
  /**
   * The build that produced the clip — `git describe` output, injected at
   * build time. Injected here rather than read, for the same reason
   * `clipperVersion` is: there is no runtime source for it at all, so keeping
   * it an input is what lets this function be tested without a build.
   */
  clipperCommit?: string;
  /**
   * The document is a PDF, so this clip is a stub: identity and title, no body.
   *
   * The extension cannot read a PDF — Chrome renders it in a plugin the DOM
   * does not see — so the body is built by the processor, which fetches the
   * document and reads its text layer (ADR 0026). Recorded rather than left
   * implicit because nothing downstream could infer it: an empty body is also
   * what a failed clip looks like, and a `.pdf` URL proves nothing either way.
   */
  sourceMedia?: "pdf";
  /** Carried over from the article this clip overwrites, when it was unlisted
   * (ADR 0017). Nothing here originates it — a re-clip rebuilds the file, and
   * without this the flag would be dropped and a deliberately hidden article
   * would rejoin the library. */
  unlisted?: boolean;
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
  // A document imported off disk has no hostname to take this from, so it
  // carries the sentinel instead (ADR 0027). Not left to `new URL().hostname`,
  // which answers "" for a `local:` URL and would fail the contract's
  // non-empty rule with an error naming the wrong thing.
  const domain = isLocalDocument(url)
    ? LOCAL_DOCUMENT_DOMAIN
    : new URL(url).hostname;
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
    ...(input.unlisted === true ? { unlisted: true } : {}),
    tiro: {
      schema: TIRO_SCHEMA_VERSION,
      ...(input.clipperVersion !== ""
        ? { clipper_version: input.clipperVersion }
        : {}),
      // Absent when the build had no git to ask — a source zip, or a checkout
      // without history. Omitted rather than recorded empty, so "no commit
      // known" and "commit is the empty string" cannot be confused.
      ...(input.clipperCommit !== undefined && input.clipperCommit !== ""
        ? { clipper_commit: input.clipperCommit }
        : {}),
      // Omitted when it agrees with `url`, so an ordinary clip is unchanged and
      // the field's presence always means "read from somewhere else".
      ...(input.sourceUrl !== undefined && input.sourceUrl !== url
        ? { source_url: input.sourceUrl }
        : {}),
      ...(input.sourceMedia !== undefined
        ? { source_media: input.sourceMedia }
        : {}),
    },
  });

  const slug = await slugForUrl(input.url);
  return {
    slug,
    path: indexPath(slug),
    content: stringifyArticle(frontmatter, input.markdown),
    title,
  };
}

/**
 * Where a tab's body was read from, when a publisher rule files the article
 * somewhere else — the `sourceUrl` above. Undefined for an ordinary page,
 * whose body and article share a URL.
 *
 * Here rather than in the popup so it can be tested: the popup imports CSS and
 * reaches for `document` at module scope, so nothing can import it.
 */
export function tabSourceUrl(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  // A reading position is not a source: `?context=cs` and `#S3` describe where
  // in the document the reader was, not where the document came from.
  url.search = "";
  url.hash = "";
  const stripped = url.toString();
  // Asked of canonicalization rather than of a named publisher. The question is
  // "did a rule file this body somewhere other than where it was read", and
  // every rule creates it: keyed on arXiv alone, a raw.githubusercontent.com
  // tab was filed under the blob page while claiming that page as its source.
  return canonicalizeUrl(stripped) === stripped ? undefined : stripped;
}
