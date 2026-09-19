import { rm } from "node:fs/promises";
import { splitBlocks, stringifyArticle } from "@tiro/shared";
import {
  modelFor,
  parseTiroConfig,
  type TiroConfig,
} from "@tiro/shared/config";
import {
  createDeadline,
  type Deadline,
  DeadlineExceededError,
} from "./deadline.ts";
import { type DiscoveredArticle, discoverArticles } from "./discover.ts";
import { processImages, reconcileAssets } from "./images.ts";
import { detectLang } from "./language.ts";
import {
  discardTranslationCache,
  loadTranslationCache,
  PDF_CACHE_FILE,
  TRANSLATION_CACHE_FILE,
  type TranslationCache,
} from "./llm/cache.ts";
import type { ChatFn, FetchLike } from "./llm/client.ts";
import {
  type SummaryResult,
  summarize,
  summaryIsFinished,
} from "./llm/summarize.ts";
import { translateBlocks } from "./llm/translate.ts";
import { convertPdf } from "./pdf.ts";

export const PROCESSOR_VERSION = "0.1.0";

export interface PipelineDeps {
  chat: ChatFn;
  fetchImpl?: FetchLike;
  /** Injectable alongside fetchImpl so tests stay off the network entirely —
   * host validation resolves names, which is a second way out. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  /** Run budget. Injectable so tests drive it directly instead of sleeping;
   * production builds one from `config.processing.run_budget_ms`. */
  deadline?: Deadline;
  log?: (message: string) => void;
}

export interface PipelineOptions {
  vaultDir: string;
  slug?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface PipelineReport {
  processed: string[];
  translated: string[];
  summaryFailed: string[];
  translationFailed: string[];
  errored: {
    slug: string;
    error: string;
    /** Whether the article is left pending, so a later run retries it. A
     * forced redo whose checkpoint could not be cleared is deliberately left
     * processed instead: making it pending would hand it to an ordinary run
     * that reuses the checkpoint nobody could remove. */
    staysPending: boolean;
  }[];
  /** Left for a later run because this one ran out of budget — not a failure:
   * their translation checkpoints are on disk and the next run resumes them. */
  skipped: string[];
  invalid: { path: string; error: string }[];
  imagesDownloaded: number;
  imagesFailed: number;
  /** Assets deleted because no article body references them any more. */
  imagesPruned: number;
}

export async function loadVaultConfig(vaultDir: string): Promise<TiroConfig> {
  return parseTiroConfig(await Bun.file(`${vaultDir}/config/tiro.yml`).text());
}

/** Process every pending article in the vault. Each stage is idempotent, so
 * a crashed or retried run just continues where the marker scan says. */
/**
 * A failed summarization must not overwrite a better summary the article
 * already had.
 *
 * Neither fallback route can see what it is replacing — `summarize` is handed a
 * body, not a history — so both write their best effort over whatever was
 * there. Measured, not feared: the backfill of 2026-09-19 took one article from
 * a 9-character summary to a 5-character one, because "keep the longest cut
 * reply" means the longest of *this* run's attempts. The re-clip path is the
 * one that matters more, and it is the same bug: a complete summary replaced by
 * a fragment for no reason but the model stopping that time, on an article
 * whose body barely changed.
 *
 * Only ever consulted when this run failed, which is what keeps it from holding
 * a stale summary in front of a good fresh one — the reason the derived fields
 * are otherwise rebuilt from this run alone.
 *
 * Two clauses, each doing something different. A finished summary always beats
 * a cut one, which covers the case worth the most. Between two cut summaries
 * the longer wins, which is the measured regression — except that an excerpt
 * never wins on length, because `summarize` has already ruled that a cut
 * summary beats one: it is the model's reading of the article rather than the
 * article's own first paragraph. A trailing ellipsis is `excerptFallback`'s
 * signature and nothing else in the vault ends that way.
 *
 * The pair moves together (ADR 0016): `summary_orig` is the other half of the
 * same reply, so keeping one and dropping the other would publish two halves of
 * different answers. That does mean discarding a good fresh `summary_orig`
 * beside a cut `summary` — accepted, because the alternative breaks the one
 * thing that ADR promises about them.
 *
 * `summary_failed` stays set either way. The article still needs a human look,
 * and the log line below is what tells this route from the other two.
 */
function keepBetterSummary(
  produced: SummaryResult,
  frontmatter: { summary?: string; summary_orig?: string },
  log: (line: string) => void,
): SummaryResult {
  const existing = frontmatter.summary?.trim() ?? "";
  if (existing === "") return produced;
  if (!isBetterSummary(existing, produced.summary.trim())) return produced;
  log(
    `summary would have regressed; keeping the existing one (${existing.length} chars, was offered ${produced.summary.trim().length})`,
  );
  return {
    ...produced,
    summary: existing,
    summaryOrig: frontmatter.summary_orig,
  };
}

/** True when `candidate` is the one a reader is better served by. */
function isBetterSummary(candidate: string, incumbent: string): boolean {
  const candidateFinished = summaryIsFinished(candidate);
  if (candidateFinished !== summaryIsFinished(incumbent)) {
    return candidateFinished;
  }
  // Both cut. An excerpt is long by construction, so length alone would let it
  // win against the model's own reading; it never does.
  if (ENDS_IN_ELLIPSIS.test(candidate)) return false;
  return candidate.length > incumbent.length;
}

/** `excerptFallback`'s signature; nothing model-written in the vault ends so. */
const ENDS_IN_ELLIPSIS = /(?:\.{2,}|…+)["'」』”’）)】\]]?$/u;

export async function runPipeline(
  options: PipelineOptions,
  config: TiroConfig,
  deps: PipelineDeps,
): Promise<PipelineReport> {
  const log = deps.log ?? ((message) => console.log(message));
  const report: PipelineReport = {
    processed: [],
    translated: [],
    summaryFailed: [],
    translationFailed: [],
    errored: [],
    skipped: [],
    invalid: [],
    imagesDownloaded: 0,
    imagesFailed: 0,
    imagesPruned: 0,
  };

  const deadline =
    deps.deadline ?? createDeadline(config.processing.run_budget_ms);

  const { pending, invalid } = await discoverArticles(options.vaultDir, {
    ...(options.slug !== undefined ? { slug: options.slug } : {}),
    force: options.force === true,
  });
  report.invalid = invalid;
  for (const bad of invalid)
    log(`invalid article skipped: ${bad.path}: ${bad.error}`);
  log(`${pending.length} article(s) to process`);

  for (let i = 0; i < pending.length; i += 1) {
    const article = pending[i];
    if (article === undefined) continue;
    if (options.dryRun === true) {
      const lang =
        article.parsed.frontmatter.lang ??
        detectLang(article.parsed.body, config.translation.cjk_threshold);
      log(`[dry-run] would process ${article.slug} (lang=${lang})`);
      continue;
    }
    // Don't start what cannot finish: an article abandoned partway costs its
    // image downloads and summary call and gets rolled back anyway. One LLM
    // round trip is the floor for making any progress at all.
    if (deadline.expired(config.llm.timeout_ms)) {
      // Count what was actually deferred, not what was attempted: an article
      // whose marker could not be cleared will not resume, and has already been
      // booked as a failure. Counting it here would put the overstatement back
      // in the summary after taking it out of the per-article line.
      let deferredCount = 0;
      for (const candidate of pending.slice(i)) {
        if (await deferArticle(candidate, options, report, log))
          deferredCount += 1;
      }
      log(
        `run budget exhausted; ${deferredCount} article(s) left pending for the next run`,
      );
      break;
    }
    try {
      await processOne(article, config, deps, report, log, deadline);
    } catch (error) {
      // Budget exhaustion is an orderly stop, not a fault: the article's
      // translation checkpoint is on disk, so the next run resumes it rather
      // than starting over. Everything else is a genuine failure.
      const outOfBudget = error instanceof DeadlineExceededError;
      if (outOfBudget) {
        // Only claim the reassuring outcome if the deferral actually held;
        // deferArticle books it as a failure otherwise. Naming the error
        // matters too: DeadlineExceededError carries the fault observed as the
        // budget ran out, so a deferral actually caused by a 403 or a stuck
        // provider says so here instead of reading as routine.
        if (await deferArticle(article, options, report, log)) {
          log(
            `run budget exhausted mid-article; ${article.slug} left pending with its checkpoint saved: ${String(error)}`,
          );
        }
      } else {
        // A hard failure (LLM outage, provider 403, disk error) must not kill
        // the run: other articles still process and the workflow's commit step
        // still runs for them. Invariant 7 also says the article is left
        // pending so a later run retries it — which used to be automatic,
        // because an article was only ever discovered when it had no marker.
        //
        // `--force` broke that assumption: a forced article entered with
        // `processed_at`, nothing above clears it, and reporting "left
        // pending" for one was simply false — an ordinary run skips it, so a
        // provider outage during a forced redo quietly retired the article.
        // `markPending` is a no-op on an unforced run, so this is the one call
        // for both cases.
        let staysPending = true;
        try {
          await markPending(article, options, log);
        } catch (markError) {
          staysPending = false;
          log(
            `${article.slug}: failed, and its marker could not be cleared, so an ordinary run will skip it: ${String(markError)}`,
          );
        }
        report.errored.push({
          slug: article.slug,
          error: String(error),
          staysPending,
        });
        log(
          staysPending
            ? `processing failed for ${article.slug}, left pending: ${String(error)}`
            : `processing failed for ${article.slug}, and it will NOT be retried by an ordinary run: ${String(error)}`,
        );
      }
      // Images are downloaded before the LLM stages, so a failure here leaves
      // files nothing references — and the workflow commits them regardless.
      // Reaching this catch proves index.md was never rewritten (the only step
      // after it cannot throw), so the parsed body is exactly what is on disk:
      // still hotlinked, so this drops just this run's downloads and keeps
      // every asset the committed article points at.
      report.imagesPruned += await reconcileQuietly(
        `${article.dirAbs}/assets`,
        article.parsed.body,
        log,
      );
      if (outOfBudget) {
        let deferredCount = 0;
        for (const candidate of pending.slice(i + 1)) {
          if (await deferArticle(candidate, options, report, log))
            deferredCount += 1;
        }
        if (deferredCount > 0) {
          log(
            `${deferredCount} further article(s) left pending for the next run`,
          );
        }
        break;
      }
    }
  }

  return report;
}

async function processOne(
  article: DiscoveredArticle,
  config: TiroConfig,
  deps: PipelineDeps,
  report: PipelineReport,
  log: (message: string) => void,
  deadline: Deadline,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const { frontmatter } = article.parsed;
  log(`processing ${article.slug}`);

  const cacheAbs = `${article.dirAbs}/${TRANSLATION_CACHE_FILE}`;

  // A PDF stub carries no body of its own: the extension cannot read a PDF, so
  // it records the URL and the document is fetched and converted here (ADR
  // 0026). First, because everything below reads the body — language detection
  // included, and a stub would detect as whatever an empty string is.
  //
  // A refusal throws, and that is the intended outcome rather than a tolerated
  // one: the catch around processOne leaves tiro.processed_at absent, so the
  // article stays pending and a later run — or a later version of this code —
  // tries again without anything being re-clipped.
  const sourceBody =
    frontmatter.tiro.source_media === "pdf"
      ? (
          await convertPdf({
            url: frontmatter.tiro.source_url ?? frontmatter.url,
            maxBytes: config.pdf.max_bytes,
            timeoutMs: config.pdf.timeout_ms,
            // Both clocks, handed over whole rather than pre-combined: the
            // stage bounds this document, the run's budget bounds the job, and
            // the stage has to be able to tell which one stopped it — one
            // leaves the article pending as a failure, the other defers it with
            // the run's work committed (invariant 8).
            stageTimeoutMs: config.pdf.stage_timeout_ms,
            deadline,
            maxPages: config.pdf.max_pages,
            minCharsPerPage: config.pdf.min_chars_per_page,
            chat: deps.chat,
            model: modelFor(config, "summary"),
            // Its own checkpoint beside the translation one, so a long PDF
            // resumes where the last run stopped instead of starting again at
            // page one (ADR 0026, and ADR 0008's reasoning applied a second
            // time). Gated on the same model, so changing it reconverts.
            cache: await loadTranslationCache(
              `${article.dirAbs}/${PDF_CACHE_FILE}`,
              { target: "pdf", model: modelFor(config, "summary") },
              log,
            ),
            ...(deps.fetchImpl !== undefined
              ? { fetchImpl: deps.fetchImpl }
              : {}),
            ...(deps.resolveHost !== undefined
              ? { resolveHost: deps.resolveHost }
              : {}),
            log,
          })
        ).markdown
      : article.parsed.body;

  const lang =
    frontmatter.lang ??
    detectLang(sourceBody, config.translation.cjk_threshold);

  const imageResult = await processImages({
    body: sourceBody,
    articleUrl: frontmatter.url,
    assetsDirAbs: `${article.dirAbs}/assets`,
    maxBytes: config.images.max_bytes,
    timeoutMs: config.images.timeout_ms,
    maxCount: config.images.max_count,
    totalMaxBytes: config.images.total_max_bytes,
    // The stage has its own cap, but it must also fit inside what is left of
    // the run: unclamped, an image-heavy article could spend five minutes past
    // a budget the run had already exhausted.
    stageTimeoutMs: Math.min(
      config.images.stage_timeout_ms,
      Math.max(0, deadline.remainingMs()),
    ),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolveHost !== undefined
      ? { resolveHost: deps.resolveHost }
      : {}),
    log,
  });
  report.imagesDownloaded += imageResult.downloaded;
  report.imagesFailed += imageResult.failed;
  const body = imageResult.body;
  const blocks = splitBlocks(body);

  const summary = await summarize({
    chat: deps.chat,
    model: modelFor(config, "summary"),
    categories: config.categories,
    title: frontmatter.title,
    body,
    targetLang: config.translation.target,
    // The same condition the translation branch below runs on: an article
    // already in the target language has no title to translate and no second
    // language to summarize itself in.
    bilingual: lang !== config.translation.target,
    cjkThreshold: config.translation.cjk_threshold,
    log,
  });
  const chosen = summary.failed
    ? keepBetterSummary(summary, frontmatter, log)
    : summary;
  if (chosen.failed) {
    report.summaryFailed.push(article.slug);
    // Deliberately says only *that* the summary needs a look, not why:
    // `summarize` has already logged the reason, and it is not always the
    // excerpt fallback — a summary cut on every attempt is kept and marked.
    log(`summary marked for review: ${article.slug}`);
  }

  let translationFailed = false;
  // Every path that does not write a fresh zh.md must remove any older one.
  // The body above has just been rewritten, so a leftover translation would be
  // rendered block-against-block with content it was never translated from —
  // and the site joins the two by filename alone, with no lang or
  // translation_failed check to save it (ADR 0003).
  const zhAbs = `${article.dirAbs}/zh.md`;
  // Hoisted so the cleanup below can tell a finished translation from a
  // misaligned one: only the first may keep its work.
  let translationCache: TranslationCache | null = null;
  let translationSucceeded = false;
  if (lang !== config.translation.target) {
    // Resume whatever an earlier run got through: the checkpoint is keyed by
    // block source text, so a reuse is only ever the same input translated by
    // the same model.
    const cache = await loadTranslationCache(
      cacheAbs,
      {
        target: config.translation.target,
        model: modelFor(config, "translation"),
      },
      log,
    );
    translationCache = cache;
    const zhBody = await translateBlocks({
      chat: deps.chat,
      model: modelFor(config, "translation"),
      targetLang: config.translation.target,
      blocks,
      batchChars: config.translation.batch_chars,
      maxBlockChars: config.translation.max_block_chars,
      cache,
      deadline,
      callBudgetMs: config.llm.timeout_ms,
      // Match how the site will render this article, or masking would hide
      // "5 to " out of "costs $5 to $10" and leave the price untranslated.
      singleDollarMath: frontmatter.has_math === true,
      log,
    });
    if (zhBody !== null) {
      await Bun.write(zhAbs, zhBody);
      translationSucceeded = true;
      report.translated.push(article.slug);
    } else {
      // Deliberate: the article is still marked processed so a pathological
      // failure cannot re-run (and re-bill) on every future push; the marker
      // makes it greppable and `--force --slug` is the retry path.
      translationFailed = true;
      report.translationFailed.push(article.slug);
      await rm(zhAbs, { force: true });
      log(`translation failed for ${article.slug}; marked translation_failed`);
    }
  } else {
    // Already in the target language, so by contract this article has no
    // translation. A re-clip can move an article into this branch.
    await rm(zhAbs, { force: true });
  }

  // Rebuild the derived fields from this run only — a --force reprocess must
  // clear a stale summary_failed/translation_failed from a prior run.
  //
  // title_zh and summary_orig are stripped here rather than overwritten because
  // they are the two that can legitimately go missing, and a leftover is worse
  // than an absence: a re-clip may have moved the article into the branch below
  // that has no translation at all, or changed the title the old one translated,
  // or the summary may have fallen back to an excerpt this time. In each case
  // the previous title would sit under a title it no longer belongs to. Stripped
  // and re-added rather than reassigned so both land after `tags`, which is also
  // where `backfill-titles` puts title_zh — otherwise a later --force run
  // produces a pure-reordering diff across every article it touches.
  const {
    title_zh: _staleTitleZh,
    summary_orig: _staleSummaryOrig,
    ...previous
  } = frontmatter;
  const {
    summary_failed: _staleSummaryFailed,
    translation_failed: _staleTranslationFailed,
    ...previousTiro
  } = frontmatter.tiro;
  const updated = {
    ...previous,
    lang,
    summary: chosen.summary,
    category: chosen.category,
    tags: chosen.tags,
    ...(chosen.titleZh !== undefined ? { title_zh: chosen.titleZh } : {}),
    ...(chosen.summaryOrig !== undefined
      ? { summary_orig: chosen.summaryOrig }
      : {}),
    tiro: {
      ...previousTiro,
      processed_at: now().toISOString(),
      processor_version: PROCESSOR_VERSION,
      ...(chosen.failed ? { summary_failed: true } : {}),
      ...(translationFailed ? { translation_failed: true } : {}),
    },
  };
  await Bun.write(article.indexAbs, stringifyArticle(updated, body));
  // The article is done the moment this lands. Recording it before cleaning up
  // matters: reconciliation used to run first, so a failure there reported the
  // article as "left pending" while it was already marked processed on disk —
  // finished silently, failed loudly, and skipped by every later run.
  report.processed.push(article.slug);

  // Only now, and never fatally: everything above can throw, and the workflow
  // commits whatever is on disk, so deleting against a body that was never
  // written would drop files the committed article still points at.
  //
  // The checkpoint is settled here for the same reason, and only now is it
  // safe to: touching it while zh.md and index.md are still unwritten would
  // open a window where a kill loses every translated block and leaves the
  // article pending anyway.
  //
  // A finished translation KEEPS its work, pruned to the blocks this article
  // still contains (ADR 0008). That is what makes a later re-clip cheap: every
  // block whose source text is unchanged is reused instead of re-sent, which
  // is the property the ADR always claimed and the code did not deliver — the
  // file was deleted by the very run that made the article "already processed",
  // so it was always gone before any re-clip could benefit.
  //
  // The other two branches still discard. A misaligned translation must not be
  // resumed or the misalignment repeats forever, and an article that needed no
  // translation has nothing worth keeping.
  if (translationSucceeded && translationCache !== null) {
    translationCache.retain(blocks.map((block) => block.text));
    await flushCheckpointQuietly(translationCache, log);
  } else {
    await discardCheckpointQuietly(cacheAbs, log);
  }
  report.imagesPruned += await reconcileQuietly(
    `${article.dirAbs}/assets`,
    body,
    log,
  );
}

/**
 * Book an article as deferred to the next run.
 *
 * Deferral is a promise that the work will be picked up again, and for a forced
 * article that promise rests entirely on clearing its marker. If that write
 * fails the article will not resume, so it is booked as the failure it is
 * rather than counted among the orderly skips — the same rule the checkpoint
 * follows.
 *
 * Guarding the write matters for a second reason: every caller is already
 * inside the per-article catch, where an unguarded throw escaped `runPipeline`
 * altogether and abandoned every remaining article. One article's failure must
 * never cost the others.
 */
async function deferArticle(
  article: DiscoveredArticle,
  options: PipelineOptions,
  report: PipelineReport,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await markPending(article, options, log);
    report.skipped.push(article.slug);
    return true;
  } catch (error) {
    report.errored.push({
      slug: article.slug,
      error: `deferred, but could not be returned to pending: ${String(error)}`,
      // The marker is still there, so an ordinary run will skip it rather than
      // pick it up — which is precisely what the log line below warns about.
      staysPending: false,
    });
    log(
      `${article.slug}: deferred, but its marker could not be cleared, so it will not resume: ${String(error)}`,
    );
    return false;
  }
}

/**
 * Return a budget-deferred article to the pending pool.
 *
 * Only `--force` runs need this. Forced discovery includes articles that are
 * already processed, so deferring one left its `tiro.processed_at` in place and
 * the next ordinary run skipped it — while the log promised it would resume.
 * Worse, a repeated `--force` without `--slug` re-selected the same cheapest
 * articles, so a whole-vault redo could never reach the expensive ones.
 *
 * Clearing the marker makes `--force` mean "these need reprocessing" and hands
 * the rest to the ordinary pending flow, which is what invariant 3 already
 * describes. Everything else stays: summary, tags, lang, and zh.md are intact,
 * so the article keeps rendering exactly as before until a later run redoes it.
 *
 * Writes `parsed.body`, not any body this run derived: reaching here means
 * index.md was never rewritten and this run's image downloads are being rolled
 * back, so the on-disk body must stay the one already committed.
 */
async function markPending(
  article: DiscoveredArticle,
  options: PipelineOptions,
  log: (message: string) => void,
): Promise<void> {
  if (options.force !== true) return; // unforced articles have no marker
  const { frontmatter, body } = article.parsed;
  if (frontmatter.tiro.processed_at === undefined) return;
  const {
    processed_at: _processedAt,
    processor_version: _processorVersion,
    ...tiro
  } = frontmatter.tiro;
  await Bun.write(
    article.indexAbs,
    stringifyArticle({ ...frontmatter, tiro }, body),
  );
  log(`${article.slug}: forced reprocess deferred, returned to pending`);
}

/** Housekeeping, like reconciliation below, and never fatal for the same
 * reason: by the time it runs the article is written and recorded, so a throw
 * here would be caught by the caller and rewrite a success into a failure. That
 * is not merely a wrong report — the handler reconciles assets against the
 * pre-download body, which references none of the downloaded files, so every
 * image would be deleted while the committed index.md still points at them. */
/** Never fatal, for the same reason the discard is not: the article is already
 * written and recorded, and a checkpoint that cannot be saved only costs the
 * next re-clip its shortcut. */
async function flushCheckpointQuietly(
  cache: TranslationCache,
  log: (message: string) => void,
): Promise<void> {
  try {
    await cache.flush();
  } catch (error) {
    log(`could not keep translation checkpoint: ${String(error)}`);
  }
}

async function discardCheckpointQuietly(
  cacheAbs: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    await discardTranslationCache(cacheAbs);
  } catch (error) {
    log(`could not remove checkpoint ${cacheAbs}: ${String(error)}`);
  }
}

/** Reconciliation is housekeeping and must never change an article's outcome,
 * the same rule the per-image fallback follows. A stale file left behind is a
 * wasted byte; a thrown error here would rewrite history the caller has
 * already committed to. */
async function reconcileQuietly(
  assetsDirAbs: string,
  body: string,
  log: (message: string) => void,
): Promise<number> {
  try {
    return await reconcileAssets(assetsDirAbs, body, log);
  } catch (error) {
    log(`could not reconcile ${assetsDirAbs}: ${String(error)}`);
    return 0;
  }
}
