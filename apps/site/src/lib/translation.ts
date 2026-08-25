import type { ArticleFrontmatter } from "@tiro/shared";

/** The one language a translation can be in — `translationPath()` names the
 * artifact `zh.md` and the config schema accepts no other target. */
const TRANSLATION_TARGET = "zh";

/**
 * The translation to render for an article, or null.
 *
 * A `zh.md` on disk is not enough to render it. The extension rewrites
 * `index.md` on every re-clip and never touches `zh.md`, so a changed article
 * sits beside the *previous* body's translation until a processor run
 * succeeds — and `buildReaderView` only notices when the block counts happen
 * to differ, so a coincidentally-aligned stale translation renders as
 * confident paired rows. Render one only when the frontmatter vouches for it:
 *
 * - `processed_at` present — the run that produced this body also produced,
 *   or deliberately removed, the translation. Absent means the clip on disk is
 *   newer than any run that has seen it.
 * - `lang` is not the target — a Chinese original has no translation by
 *   contract (ADR 0003).
 * - `translation_failed` unset — the run produced output and rejected it.
 *
 * Returning null is not a degraded mode: `buildReaderView` renders a single
 * pane, which is the honest view of "no translation vouched for".
 */
export function usableTranslation(
  frontmatter: ArticleFrontmatter,
  zhBody: string | null,
): string | null {
  if (zhBody === null) return null;
  if (frontmatter.tiro.processed_at === undefined) return null;
  if (frontmatter.lang === TRANSLATION_TARGET) return null;
  if (frontmatter.tiro.translation_failed === true) return null;
  return zhBody;
}
