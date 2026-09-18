import { plainText, splitBlocks } from "@tiro/shared";
import { z } from "zod";
import type { ChatFn, ChatMessage } from "./client.ts";
import {
  acceptableSourceSummary,
  acceptableTitleZh,
  sourceSummaryPromptLine,
  titlePromptLines,
} from "./title.ts";

export interface SummarizeOptions {
  chat: ChatFn;
  model: string;
  categories: readonly string[];
  title: string;
  body: string;
  /** Language the summary should be written in (config.translation.target). */
  targetLang: string;
  /**
   * Ask for the pair as well: the title translated into `targetLang`, and the
   * summary written a second time in the article's own language.
   *
   * False for an article already in the target language. It has no pair — its
   * title needs no translation and `summary` is already in its own language —
   * and a model asked anyway invents one.
   */
  bilingual?: boolean;
  /**
   * `translation.cjk_threshold`, used to tell a source-language summary from
   * the target language written twice. Required rather than defaulted, so the
   * vault's own threshold is the only one in play and this file does not become
   * a second place that number lives.
   */
  cjkThreshold: number;
  maxBodyChars?: number;
  log?: (message: string) => void;
}

export interface SummaryResult {
  summary: string;
  category: string;
  tags: string[];
  /** The title translated into `targetLang`. Absent unless asked for, and
   * absent when what came back was not a translation — see `acceptableTitleZh`. */
  titleZh?: string;
  /** The summary in the article's own language, the other half of the pair. */
  summaryOrig?: string;
  /**
   * True when the summary needs a human look, by either route: three replies
   * the schema could not accept, so the excerpt fallback was used — or three
   * that stopped mid-sentence, in which case the longest is kept and this is
   * the only record of it. The pipeline writes `tiro.summary_failed` from it;
   * the log line says which happened.
   */
  failed: boolean;
}

/**
 * `title_zh` and `summary_orig` stay optional **even when the prompt asked for
 * them**, and tightening that would be a mistake worth the comment: a schema
 * failure here is fed back as a correction and, after MAX_ATTEMPTS, drops the
 * article to an excerpt with `summary_failed` — an operator signal meaning
 * "reprocess this one by hand". Requiring them would spend three round trips on
 * a 30 K-char body and cost the article its summary, category and tags because
 * a model omitted a title. A missing half is worth exactly nothing, not that.
 */
const ResponseSchema = z.object({
  summary: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).max(8),
  title_zh: z.string().min(1).optional(),
  summary_orig: z.string().min(1).optional(),
});

const MAX_ATTEMPTS = 3;

/**
 * Does this summary read as a finished thought rather than a cut one?
 *
 * The model returns a JSON object that parses, validates, and carries a real
 * category, real tags and a complete `summary_orig` — beside a `summary` that
 * stops mid-clause, sometimes after only a few dozen characters, on the word
 * before the phrase it was building towards. 13 of the vault's 135 summaries
 * were written that way and nothing caught it: `z.string().min(1)` is happy,
 * and the summary is the one field no later stage reads, so it reaches the page
 * and the `<meta name="description">` exactly as the model left it.
 *
 * Measured before guessing, because the obvious cause is a token budget and it
 * is not one. The affected articles have *shorter* total model output than the
 * unaffected ones (1253 against 1583 characters on average), and an intact
 * reply carries a longer `summary_orig` than any cut article's. The cut is also
 * one-sided: `summary_orig` is never cut, in 57 bilingual articles. The model
 * simply stops sometimes, so the answer is to notice and ask again rather than
 * to raise a cap that was never the constraint.
 *
 * A trailing ellipsis is a cut, not an ending — it is what a sentence trailing
 * off looks like, and accepting it let the very shape this guards against pass
 * on the first attempt. Nothing legitimate is lost: no model-written summary in
 * the vault ends in one. The three that do are `excerptFallback`'s own
 * `…`, which never reaches this predicate.
 */
const ELLIPSIS = /(?:\.{2,}|…+)["'」』”’）)】\]]?$/u;
/** Terminal punctuation in either language, optionally behind a closing pair. */
const FINISHED = /[。．.！!？?]["'」』”’）)】\]]?$/u;

export function summaryIsFinished(summary: string): boolean {
  const trimmed = summary.trim();
  return !ELLIPSIS.test(trimmed) && FINISHED.test(trimmed);
}

/**
 * One JSON-mode call producing summary + category + tags. Invalid JSON, an
 * off-taxonomy category, or a summary that stops mid-sentence is retried with
 * the reason appended; after MAX_ATTEMPTS the article is still processed and
 * still marked `failed: true`, so it stays greppable for a manual `--force`
 * retry. What it is left holding differs: a first-paragraph excerpt when no
 * reply was usable, or the longest cut summary when the replies were fine
 * apart from stopping early.
 *
 * Only *model* failures are handled that way. Transport and HTTP errors from
 * `chat` propagate to the caller, which leaves the article pending (invariant
 * 7) — a 403 or a provider outage is not something a corrective prompt can
 * fix, and burning the retry budget on it would mark every article processed
 * with an excerpt. `translateBlocks` already behaves this way.
 */
export async function summarize(
  options: SummarizeOptions,
): Promise<SummaryResult> {
  const {
    chat,
    model,
    categories,
    title,
    body,
    targetLang,
    bilingual = false,
    cjkThreshold,
    maxBodyChars = 30_000,
    log = () => {},
  } = options;
  const truncated =
    body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n…` : body;

  // DashScope's JSON mode rejects requests whose messages don't contain the
  // literal word "JSON", so the word must appear in the prompt.
  const system = [
    "You are a precise reading assistant for a personal knowledge base.",
    "Respond with a single JSON object with exactly these keys:",
    `- "summary": a structured summary written in the language "${targetLang}" — one short paragraph of the article's core argument, then 2-4 key takeaways as sentences.`,
    `- "category": exactly one of: ${categories.join(", ")}.`,
    '- "tags": 3 to 6 short free-form topic tags, lowercase.',
    ...(bilingual
      ? [...titlePromptLines(targetLang), sourceSummaryPromptLine()]
      : []),
    "Output JSON only, no markdown fences.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Title: ${title}\n\nArticle (markdown):\n\n${truncated}`,
    },
  ];

  // The best cut summary seen so far, kept in case every attempt is cut.
  let unfinished: z.infer<typeof ResponseSchema> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Outside the try on purpose — see the note above about propagating.
    const raw = await chat({
      model,
      messages,
      response_format: { type: "json_object" },
    });

    let feedback: string;
    try {
      const parsed = ResponseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        feedback = `Your previous JSON did not match the schema: ${parsed.error.message}`;
      } else if (!categories.includes(parsed.data.category)) {
        feedback = `Your previous "category" (${parsed.data.category}) is not in the allowed list: ${categories.join(", ")}.`;
      } else if (!summaryIsFinished(parsed.data.summary)) {
        // Retryable, but never a *failure*: the reply is otherwise complete and
        // useful, and the `failed` path below replaces the summary with a
        // first-paragraph excerpt. Trading a cut summary for an excerpt would
        // lose the model's reading of the article to fix its punctuation.
        if (
          unfinished === undefined ||
          parsed.data.summary.length > unfinished.summary.length
        ) {
          unfinished = parsed.data;
        }
        feedback = `Your previous "summary" stopped mid-sentence, ending "${parsed.data.summary.trim().slice(-40)}". Write the whole summary and finish every sentence.`;
      } else {
        return {
          ...accept(
            parsed.data,
            { bilingual, title, targetLang, cjkThreshold },
            log,
          ),
          failed: false,
        };
      }
    } catch (error) {
      feedback = `Your previous response was not valid JSON: ${String(error).slice(0, 200)}`;
    }
    // Each failed attempt is minutes of LLM time on a long article; without
    // this line the workflow log is silent until the excerpt fallback.
    log(`summary attempt ${attempt}/${MAX_ATTEMPTS} failed: ${feedback}`);
    if (attempt < MAX_ATTEMPTS) {
      // The correction says "your previous response", so that response has to
      // be in the transcript for the reference to resolve to anything.
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `${feedback}\nRespond again with a corrected JSON object.`,
      });
    }
  }

  // A cut summary beats an excerpt — it is the model's reading of the article,
  // with a real category and tags beside it — so the text is kept rather than
  // replaced. But it is still marked: the whole reason 13 of these reached the
  // vault unnoticed is that nothing wrote anything down, and a run log scrolls
  // away. `summary_failed` therefore means "this summary needs a human look",
  // by either of its two routes, which the log lines tell apart.
  if (unfinished !== undefined) {
    // "no attempt finished", not "every attempt was cut": `unfinished` holds
    // the best of the cut replies, and the others may have failed for entirely
    // different reasons — unparseable JSON, a category off the taxonomy. The
    // per-attempt lines above say what each one did; this one says only what
    // the article is left holding, which is the part the runbook indexes.
    log(
      `summary unfinished after ${MAX_ATTEMPTS} attempts; keeping the longest cut reply (${unfinished.summary.trim().length} chars)`,
    );
    return {
      ...accept(
        unfinished,
        { bilingual, title, targetLang, cjkThreshold },
        log,
      ),
      failed: true,
    };
  }

  // The other marked outcome, and it says so itself rather than leaving the
  // pipeline's slug line to imply it. Both paths set `summary_failed`, so a log
  // that does not distinguish them leaves an operator unable to tell an article
  // holding a short summary from one holding its own first paragraph.
  log(
    `summary unusable after ${MAX_ATTEMPTS} attempts; using a first-paragraph excerpt`,
  );
  return {
    summary: excerptFallback(body, title),
    category: fallbackCategory(categories),
    tags: [],
    failed: true,
  };
}

/**
 * Keep the two halves that survive their guards, and say so in the log when one
 * does not. An omission is not a failure — nothing is marked, and the article
 * simply renders the way it did before the field existed — but a run whose
 * titles are quietly all missing has to be visible in the workflow log rather
 * than only in the vault diff.
 */
function accept(
  data: z.infer<typeof ResponseSchema>,
  context: {
    bilingual: boolean;
    title: string;
    targetLang: string;
    cjkThreshold: number;
  },
  log: (message: string) => void,
): Omit<SummaryResult, "failed"> {
  const { title_zh, summary_orig, ...rest } = data;
  // Gated on `bilingual` here as well as in the prompt, so a title volunteered
  // for an article that has no source language is discarded in one place and
  // the pipeline's write stays a plain spread.
  if (!context.bilingual) return rest;
  const titleZh = acceptableTitleZh(title_zh, context.title);
  const summaryOrig = acceptableSourceSummary(
    summary_orig,
    rest.summary,
    context.targetLang,
    context.cjkThreshold,
  );
  if (titleZh === undefined) {
    log("no usable title translation in the summary reply; leaving it unset");
  }
  if (summaryOrig === undefined) {
    log("no usable source-language summary in the reply; leaving it unset");
  }
  return {
    ...rest,
    ...(titleZh !== undefined ? { titleZh } : {}),
    ...(summaryOrig !== undefined ? { summaryOrig } : {}),
  };
}

/** "other" is the conventional catch-all, but nothing in the config schema
 * requires a vault to define it. Emitting it unconditionally would write the
 * off-taxonomy category the retry loop above exists to prevent, so fall back
 * to the last configured category instead. */
function fallbackCategory(categories: readonly string[]): string {
  if (categories.includes("other")) return "other";
  return categories[categories.length - 1] ?? "other";
}

/**
 * The first paragraph that actually reads as prose, as prose.
 *
 * Two things this must not do, both of which it did. It took the first
 * `paragraph` block, but a line holding nothing but a linked image is a
 * paragraph too — so an article opening with a hero image was summarized with
 * `[![](./assets/….jpg)](https://…)`, which the site prints verbatim into the
 * page and the `<meta name="description">`. And it used the block's `text`,
 * which is exact source: a real paragraph carrying `**bold**` or a link would
 * have shown its punctuation the same way.
 *
 * So: look at what each paragraph renders as, skip the ones that render as
 * nothing, and return the rendering rather than the source. Falls back to the
 * title when no paragraph qualifies — a body that is all code, or all
 * pictures — because an empty summary is one the frontmatter schema accepts
 * silently.
 */
function excerptFallback(body: string, title: string): string {
  for (const block of splitBlocks(body)) {
    if (block.type !== "paragraph") continue;
    const text = plainText(block.text);
    if (text === "") continue;
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  }
  return title;
}
