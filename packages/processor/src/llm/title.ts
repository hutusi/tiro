/**
 * The rules a translated title follows, and the guard that decides a candidate
 * is one.
 *
 * Two callers prompt from here: the summary call, which gets the title for free
 * alongside the summary it has to share vocabulary with, and `backfill-titles`,
 * which has only the title and an already-written summary to go on. Two
 * spellings of these rules would give one vault two house styles for its titles
 * — one for everything clipped after this landed, another for everything that
 * came before it.
 */

/**
 * The title rules, in the register of `batchSystemPrompt` in `translate.ts`.
 *
 * The JSON key is `title_zh` rather than something built from `targetLang`
 * because the frontmatter field is: `translation.target` is a literal `"zh"` in
 * the config schema, deliberately un-widenable, and the artifact beside it is
 * named `zh.md` for the same reason.
 *
 * Deliberately no "drop the publisher's suffix" rule. Two live titles carry one
 * (`… critical | Bill Gates`, `autistici.org - Welcome to …`), but telling a
 * model to translate faithfully and then to delete part of what it was given
 * licenses it to edit the rest too — and the original renders directly beside
 * the translation everywhere the translation appears, so nothing is hidden. A
 * suffix worth removing is worth removing by hand.
 */
export function titlePromptLines(targetLang: string): string[] {
  return [
    `- "title_zh": the article's title translated into the language "${targetLang}". Translate it — do not summarize, expand or improve it, and add nothing the title does not say. Keep product names, company names, model names, acronyms, version numbers and code identifiers in their original form (Claude, arXiv, KAN, DNS, 1.1.1.1) and translate the words around them. A subtitle after a colon stays a subtitle, joined with a full-width colon. Match the original's length, at most 40 characters, with no quotation marks around the whole title and no trailing period.`,
  ];
}

/** The prompt line for the summary's other half. */
export function sourceSummaryPromptLine(): string {
  return '- "summary_orig": the same summary again, written in the language the article itself is written in — the same content, not a longer or looser one.';
}

// The per-character test `language.ts` makes a ratio of. Presence, not ratio,
// is the question here: a title may be almost entirely product name and still
// be a translation.
const HAN_RE = /\p{Script=Han}/u;

/**
 * A candidate translated title, or undefined when it is not one.
 *
 * A model handed a short English string sometimes returns it unchanged — asked
 * for Chinese, `The Twelve-Factor App` comes back as `The Twelve-Factor App` —
 * and an echo is worse than nothing: the site would print a second English line
 * under the first in every library row, where no title at all falls back to the
 * layout that has been shipping all along.
 *
 * One Han character is the whole bar, not a ratio: a legitimate translation can
 * be mostly product name (`为 Claude Fable 5.1 编写提示词`).
 */
export function acceptableTitleZh(
  candidate: string | undefined,
): string | undefined {
  const trimmed = candidate?.trim();
  if (trimmed === undefined || trimmed === "" || !HAN_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * A candidate source-language summary, or undefined when it is not one.
 *
 * The only failure worth guarding is the degenerate one — the model repeating
 * the summary it just wrote, which would put Chinese in the column the reader
 * labels 原文. No script test here, unlike the title above: this is generated
 * prose rather than a short string handed back verbatim, and an English summary
 * that quotes a Chinese term is still an English summary.
 */
export function acceptableSourceSummary(
  candidate: string | undefined,
  summary: string,
): string | undefined {
  const trimmed = candidate?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === summary.trim()) {
    return undefined;
  }
  return trimmed;
}
