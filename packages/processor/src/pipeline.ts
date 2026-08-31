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
import { loadTranslationCache, TRANSLATION_CACHE_FILE } from "./llm/cache.ts";
import type { ChatFn, FetchLike } from "./llm/client.ts";
import { summarize } from "./llm/summarize.ts";
import { translateBlocks } from "./llm/translate.ts";

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
  errored: { slug: string; error: string }[];
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
      const remaining = pending.slice(i).map((a) => a.slug);
      report.skipped.push(...remaining);
      log(
        `run budget exhausted; ${remaining.length} article(s) left pending for the next run`,
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
        report.skipped.push(article.slug);
        log(
          `run budget exhausted mid-article; ${article.slug} left pending with its checkpoint saved`,
        );
      } else {
        // A hard failure (LLM outage, provider 403, disk error) must not kill
        // the run: other articles still process, the workflow's commit step
        // still runs for them, and this article stays unmarked so the next
        // push retries it.
        report.errored.push({ slug: article.slug, error: String(error) });
        log(
          `processing failed for ${article.slug}, left pending: ${String(error)}`,
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
        const remaining = pending.slice(i + 1).map((a) => a.slug);
        report.skipped.push(...remaining);
        if (remaining.length > 0) {
          log(
            `${remaining.length} further article(s) left pending for the next run`,
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

  const lang =
    frontmatter.lang ??
    detectLang(article.parsed.body, config.translation.cjk_threshold);

  const imageResult = await processImages({
    body: article.parsed.body,
    articleUrl: frontmatter.url,
    assetsDirAbs: `${article.dirAbs}/assets`,
    maxBytes: config.images.max_bytes,
    timeoutMs: config.images.timeout_ms,
    maxCount: config.images.max_count,
    totalMaxBytes: config.images.total_max_bytes,
    stageTimeoutMs: config.images.stage_timeout_ms,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolveHost !== undefined
      ? { resolveHost: deps.resolveHost }
      : {}),
    log,
  });
  report.imagesDownloaded += imageResult.downloaded;
  report.imagesFailed += imageResult.failed;
  const body = imageResult.body;

  const summary = await summarize({
    chat: deps.chat,
    model: modelFor(config, "summary"),
    categories: config.categories,
    title: frontmatter.title,
    body,
    targetLang: config.translation.target,
    log,
  });
  if (summary.failed) {
    report.summaryFailed.push(article.slug);
    log(`summary fell back to excerpt for ${article.slug}`);
  }

  let translationFailed = false;
  // Every path that does not write a fresh zh.md must remove any older one.
  // The body above has just been rewritten, so a leftover translation would be
  // rendered block-against-block with content it was never translated from —
  // and the site joins the two by filename alone, with no lang or
  // translation_failed check to save it (ADR 0003).
  const zhAbs = `${article.dirAbs}/zh.md`;
  const cacheAbs = `${article.dirAbs}/${TRANSLATION_CACHE_FILE}`;
  if (lang !== config.translation.target) {
    // Resume whatever an earlier run got through. `--force` deliberately does
    // NOT clear this: the checkpoint is keyed by block source text, so a reuse
    // is only ever the same input translated by the same model, and clearing
    // it would make the one case that needs resuming — an article too long to
    // finish in a single run — impossible to retry. Changing the model in
    // tiro.yml invalidates it automatically; delete the file for a clean redo.
    const cache = await loadTranslationCache(cacheAbs, {
      target: config.translation.target,
      model: modelFor(config, "translation"),
    });
    const zhBody = await translateBlocks({
      chat: deps.chat,
      model: modelFor(config, "translation"),
      targetLang: config.translation.target,
      blocks: splitBlocks(body),
      batchChars: config.translation.batch_chars,
      cache,
      deadline,
      callBudgetMs: config.llm.timeout_ms,
      log,
    });
    if (zhBody !== null) {
      await Bun.write(zhAbs, zhBody);
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
    // translation. A re-clip can move an article into this branch, so clear a
    // checkpoint left from when it was still being translated.
    await rm(zhAbs, { force: true });
    await rm(cacheAbs, { force: true });
  }

  // Rebuild the failure markers from this run only — a --force reprocess
  // must clear a stale summary_failed/translation_failed from a prior run.
  const {
    summary_failed: _staleSummaryFailed,
    translation_failed: _staleTranslationFailed,
    ...previousTiro
  } = frontmatter.tiro;
  const updated = {
    ...frontmatter,
    lang,
    summary: summary.summary,
    category: summary.category,
    tags: summary.tags,
    tiro: {
      ...previousTiro,
      processed_at: now().toISOString(),
      processor_version: PROCESSOR_VERSION,
      ...(summary.failed ? { summary_failed: true } : {}),
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
  report.imagesPruned += await reconcileQuietly(
    `${article.dirAbs}/assets`,
    body,
    log,
  );
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
