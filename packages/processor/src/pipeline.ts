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
    await processOne(article, config, deps, report, log);
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
  log(`processing ${article.year}/${article.slug}`);

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
  });
  if (summary.failed) {
    report.summaryFailed.push(article.slug);
    log(`summary fell back to excerpt for ${article.slug}`);
  }

  if (lang !== config.translation.target) {
    const zhBody = await translateBlocks({
      chat: deps.chat,
      model: modelFor(config, "translation"),
      targetLang: config.translation.target,
      blocks: splitBlocks(body),
      log,
    });
    if (zhBody !== null) {
      await Bun.write(`${article.dirAbs}/zh.md`, zhBody);
      report.translated.push(article.slug);
    }
  }

  const updated = {
    ...frontmatter,
    lang,
    summary: summary.summary,
    category: summary.category,
    tags: summary.tags,
    tiro: {
      ...frontmatter.tiro,
      processed_at: now().toISOString(),
      processor_version: PROCESSOR_VERSION,
      ...(summary.failed ? { summary_failed: true } : {}),
    },
  };
  await Bun.write(article.indexAbs, stringifyArticle(updated, body));
  report.processed.push(article.slug);
}
