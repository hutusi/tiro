import { type LeadOffer, mergeLead, parseArticle } from "@tiro/shared";
import {
  encodeBase64Utf8,
  type FetchLike,
  findExistingIndex,
  putFile,
} from "./github.ts";
import type { TiroExtensionConfig } from "./storage.ts";

/**
 * "Add missing lead" (ADR 0053): the dek and lead picture the clipper used to
 * leave out (ADR 0052), added to an article already in the vault from the page
 * the reader has open — in their own browser, past whatever paywall their
 * login opens — without re-clipping it.
 *
 * A re-clip replaces the whole body and hands the article back for full
 * processing: a new summary, new tags, a new translated title, all to gain a
 * paragraph and a picture. This edits `index.md` in place through
 * `mergeLead`, the rule every lead repair shares: only the missing parts go
 * in, at the top, the rest of the body keeps its bytes, and the article is
 * marked for a run that translates the new blocks and keeps everything else.
 */

/** What became of a lead offered to the vault's copy of this page. */
export type LeadRestore =
  /** Committed: the lead blocks inserted, in order. */
  | { kind: "added"; added: string[] }
  /** The vault's copy already has every part of it. */
  | { kind: "unchanged" }
  /** The vault has no article at this slug. */
  | { kind: "absent" }
  /** `mergeLead` would not: the page no longer begins where the article
   * does, the lead's dollar signs would read differently there, or the
   * article cannot be read. */
  | { kind: "refused"; reason: string };

/** Thrown from the conflict retry to end it with an answer rather than a
 * write: the article changed under the first attempt, and what it changed
 * to needs nothing, or cannot take the lead. */
class Settled extends Error {
  constructor(readonly outcome: LeadRestore) {
    super(outcome.kind);
  }
}

/**
 * Offer `lead` — the clip's `ClipPayload.lead`, with its `hasMath` — to the
 * article at `slug`, checked against `pageMarkdown`, the whole clip it came
 * from.
 *
 * One read and at most one commit. A commit landing between the two — the
 * processor finishing another run, a collection edit — makes the write's sha
 * stale; the retry reads the article again and merges against what is there
 * now, so whatever that commit did survives, as a re-clip's retry keeps an
 * `unlisted` flag (ADR 0017).
 */
export async function restoreLead(
  config: TiroExtensionConfig,
  slug: string,
  lead: LeadOffer,
  pageMarkdown: string,
  fetchImpl: FetchLike = fetch,
): Promise<LeadRestore> {
  const existing = await findExistingIndex(config, slug, fetchImpl);
  if (existing === null) return { kind: "absent" };
  const first = mergeLead(existing.text, lead, pageMarkdown);
  if (first.kind === "unchanged") return { kind: "unchanged" };
  if (first.kind === "refused") return first;

  let added = first.added;
  try {
    await putFile(
      config,
      {
        path: existing.path,
        contentBase64: encodeBase64Utf8(first.text),
        message: `lead: ${titleOf(first.text, slug)}`,
        sha: existing.sha,
        resolveConflict: async () => {
          const again = await findExistingIndex(config, slug, fetchImpl);
          if (again === null) throw new Settled({ kind: "absent" });
          const merge = mergeLead(again.text, lead, pageMarkdown);
          if (merge.kind === "unchanged") {
            throw new Settled({ kind: "unchanged" });
          }
          if (merge.kind === "refused") throw new Settled(merge);
          added = merge.added;
          return {
            sha: again.sha,
            contentBase64: encodeBase64Utf8(merge.text),
          };
        },
      },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof Settled) return error.outcome;
    throw error;
  }
  return { kind: "added", added };
}

/** The article's title for the commit message, or its slug when the merged
 * text will not say. */
function titleOf(text: string, slug: string): string {
  try {
    return parseArticle(text).frontmatter.title;
  } catch {
    return slug;
  }
}
