import { rm } from "node:fs/promises";
import { splitBlocks, stringifyArticle } from "@tiro/shared";
import {
  modelFor,
  parseTiroConfig,
  type TiroConfig,
} from "@tiro/shared/config";
import { type DiscoveredArticle, discoverArticles } from "./discover.ts";
import { processImages } from "./images.ts";
import { detectLang } from "./language.ts";
import type { ChatFn, FetchLike } from "./llm/client.ts";
import { summarize } from "./llm/summarize.ts";
import { translateBlocks } from "./llm/translate.ts";

export const PROCESSOR_VERSION = "0.1.0";

export interface PipelineDeps {
  chat: ChatFn;
  fetchImpl?: FetchLike;
  now?: () => Date;
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
  invalid: { path: string; error: string }[];
  imagesDownloaded: number;
  imagesFailed: number;
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
    invalid: [],
    imagesDownloaded: 0,
    imagesFailed: 0,
  };

  const { pending, invalid } = await discoverArticles(options.vaultDir, {
    ...(options.slug !== undefined ? { slug: options.slug } : {}),
    force: options.force === true,
  });
  report.invalid = invalid;
  for (const bad of invalid)
    log(`invalid article skipped: ${bad.path}: ${bad.error}`);
  log(`${pending.length} article(s) to process`);

  for (const article of pending) {
    if (options.dryRun === true) {
      const lang =
        article.parsed.frontmatter.lang ??
        detectLang(article.parsed.body, config.translation.cjk_threshold);
      log(`[dry-run] would process ${article.slug} (lang=${lang})`);
      continue;
    }
    try {
      await processOne(article, config, deps, report, log);
    } catch (error) {
      // A hard failure (LLM outage, provider 403, disk error) must not kill
      // the run: other articles still process, the workflow's commit step
      // still runs for them, and this article stays unmarked so the next
      // push retries it.
      report.errored.push({ slug: article.slug, error: String(error) });
      log(
        `processing failed for ${article.slug}, left pending: ${String(error)}`,
      );
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
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
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
  if (lang !== config.translation.target) {
    const zhBody = await translateBlocks({
      chat: deps.chat,
      model: modelFor(config, "translation"),
      targetLang: config.translation.target,
      blocks: splitBlocks(body),
      batchChars: config.translation.batch_chars,
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
    // translation. A re-clip can move an article into this branch.
    await rm(zhAbs, { force: true });
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
  report.processed.push(article.slug);
}
