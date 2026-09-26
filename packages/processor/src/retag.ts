import {
  type ArticleFrontmatter,
  normalizeTags,
  parseArticle,
  stringifyArticle,
  TAG_LIMIT,
  tagAliases,
} from "@tiro/shared";
import { modelFor, type TiroConfig } from "@tiro/shared/config";
import { createBreaker } from "./breaker.ts";
import { createDeadline, type Deadline } from "./deadline.ts";
import type { ChatFn } from "./llm/client.ts";
import { suggestTags } from "./llm/tags.ts";
import {
  buildVocabulary,
  isEnglishTag,
  MAX_NEW_TAGS,
  MIN_TAGS,
  writableTags,
} from "./tag-policy.ts";

/**
 * Give already-processed articles the tags a run would give them now
 * (ADR 0033): in English, in canonical form, through the aliases, and reusing
 * the vault's vocabulary.
 *
 * A one-shot command beside `backfill-titles`, for its reasons: it needs
 * exactly the articles `run` skips, must not touch their processing markers,
 * and a `--force` over the vault would re-translate whole bodies and
 * re-download every image to change one line each. One small call per article,
 * from its title and summary.
 */

export type RetagSkipReason = "pending" | "already-tagged";

export interface RetagReport {
  scanned: number;
  /** `after` is null under --dry-run, which makes no call. */
  retagged: { slug: string; before: string[]; after: string[] | null }[];
  /** Asked, and the answer was the tags it already had. */
  unchanged: string[];
  skipped: { slug: string; reason: RetagSkipReason }[];
  failed: { slug: string; error: string }[];
  /** Not reached: the budget ran out, `--limit` was hit, or the run stopped
   * after three failures. Re-run to continue — an article already meeting the
   * policy is skipped, so there is nothing else to resume. */
  remaining: string[];
  invalid: { path: string; error: string }[];
  /** The vocabulary every article in the run was offered, frozen at the start. */
  vocabulary: string[];
}

export interface RetagOptions {
  slug?: string;
  force?: boolean;
  dryRun?: boolean;
  limit?: number;
}

export interface RetagDeps {
  chat: ChatFn;
  deadline?: Deadline;
  log?: (message: string) => void;
}

/** Same as `backfill-titles`: every call is the same small request, so three
 * failures in a row are one failure repeated. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Whether an article's tags already meet the policy a run holds new tags to:
 * written in canonical form, in English, `MIN_TAGS` to `TAG_LIMIT` of them,
 * and at most `MAX_NEW_TAGS` outside the vocabulary. Such an article is
 * skipped unless `--force`. That is what makes the command resumable — nearly
 * every article it retags meets this, so a re-run picks up where the last
 * stopped — and what keeps it from paying to ask about tags nothing would
 * change. The exceptions are articles the model gave fewer than three tags, or
 * that needed a third new one to reach three; a re-run asks about those again.
 */
function alreadyTagged(
  tags: readonly string[],
  aliases: ReadonlyMap<string, string | null>,
  known: ReadonlySet<string>,
): boolean {
  const normal = normalizeTags(tags, aliases, Number.POSITIVE_INFINITY);
  return (
    normal.length >= MIN_TAGS &&
    normal.length <= TAG_LIMIT &&
    sameTags(normal, tags) &&
    normal.every(isEnglishTag) &&
    normal.filter((tag) => !known.has(tag)).length <= MAX_NEW_TAGS
  );
}

/**
 * The article's frontmatter with new tags, in the key order the processor
 * writes. Parsing returns the schema's order, which puts `title_zh` and
 * `summary_orig` before `tags`; the processor moves them after it (see the
 * write in `processOne`). Spreading the parsed object back out would reorder
 * those two keys on every bilingual article — 112 of the live vault's 181 —
 * burying the tag change in a diff of moved lines.
 */
function withTags(
  frontmatter: ArticleFrontmatter,
  tags: string[],
): ArticleFrontmatter {
  const { title_zh, summary_orig, ...rest } = frontmatter;
  return {
    ...rest,
    tags,
    ...(title_zh !== undefined ? { title_zh } : {}),
    ...(summary_orig !== undefined ? { summary_orig } : {}),
  };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

export async function retagVault(
  vaultDir: string,
  config: TiroConfig,
  options: RetagOptions,
  deps: RetagDeps,
): Promise<RetagReport> {
  const log = deps.log ?? (() => {});
  const deadline =
    deps.deadline ?? createDeadline(config.processing.run_budget_ms);
  const model = modelFor(config, "summary");
  const aliases = tagAliases(config.tags.aliases);

  const articlesDir = `${vaultDir}/articles`;
  const relPaths = Array.from(
    new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();

  // Every article is read first, for the vocabulary — the whole vault's, even
  // under --slug, and frozen before the first call so that the order articles
  // are retagged in cannot change what any of them is offered.
  const articles: {
    slug: string;
    relPath: string;
    parsed: ReturnType<typeof parseArticle>;
  }[] = [];
  const report: RetagReport = {
    scanned: 0,
    retagged: [],
    unchanged: [],
    skipped: [],
    failed: [],
    remaining: [],
    invalid: [],
    vocabulary: [],
  };
  for (const relPath of relPaths) {
    const [slug] = relPath.split("/");
    if (slug === undefined) continue;
    const inScope = options.slug === undefined || options.slug === slug;
    if (inScope) report.scanned += 1;
    try {
      const parsed = parseArticle(
        await Bun.file(`${articlesDir}/${relPath}`).text(),
      );
      articles.push({ slug, relPath, parsed });
    } catch (error) {
      // Isolated like `run` (invariant 7), and counted against the exit status
      // only when it is an article this invocation was about.
      if (inScope) report.invalid.push({ path: relPath, error: String(error) });
    }
  }
  report.vocabulary = buildVocabulary(
    articles.map((a) => a.parsed.frontmatter.tags ?? []),
    aliases,
  );
  const known = new Set(report.vocabulary);

  const breaker = createBreaker(CONSECUTIVE_FAILURE_LIMIT);
  let stopped = false;
  let attempted = 0;

  for (const { slug, relPath, parsed } of articles) {
    if (options.slug !== undefined && options.slug !== slug) continue;
    const { frontmatter, body } = parsed;
    const before = frontmatter.tags ?? [];

    if (frontmatter.tiro.processed_at === undefined) {
      // `run` tags it, from the body, under the same policy.
      report.skipped.push({ slug, reason: "pending" });
      continue;
    }
    if (options.force !== true && alreadyTagged(before, aliases, known)) {
      report.skipped.push({ slug, reason: "already-tagged" });
      continue;
    }
    // Scopes which articles this invocation is about, like --slug, so it
    // narrows a dry run too (see `backfill-titles`).
    if (options.limit !== undefined && attempted >= options.limit) {
      report.remaining.push(slug);
      continue;
    }
    attempted += 1;
    if (options.dryRun === true) {
      report.retagged.push({ slug, before: [...before], after: null });
      continue;
    }
    if (stopped || deadline.expired(config.llm.timeout_ms)) {
      stopped = true;
      report.remaining.push(slug);
      continue;
    }

    const summary = frontmatter.summary_orig ?? frontmatter.summary;
    if (summary === undefined || summary.trim() === "") {
      report.failed.push({
        slug,
        error: "no summary to tag from; reprocess it instead",
      });
      continue;
    }
    try {
      const offered = await suggestTags({
        chat: deps.chat,
        model,
        title: frontmatter.title,
        summary,
        currentTags: before,
        vocabulary: report.vocabulary,
        log,
      });
      const after =
        offered === null ? [] : writableTags(offered, aliases, log, known);
      if (after.length === 0) {
        // Its old tags stay: no tags at all would take it off every tag page.
        report.failed.push({ slug, error: "no usable tags in the reply" });
        breaker.failed();
      } else if (sameTags(after, before)) {
        report.unchanged.push(slug);
        breaker.succeeded();
      } else {
        await Bun.write(
          `${articlesDir}/${relPath}`,
          stringifyArticle(withTags(frontmatter, after), body),
        );
        report.retagged.push({ slug, before: [...before], after });
        breaker.succeeded();
      }
    } catch (error) {
      report.failed.push({ slug, error: String(error) });
      breaker.failed();
    }

    if (breaker.tripped && !stopped) {
      log(
        `${breaker.count} failures in a row; stopping rather than repeating them`,
      );
      stopped = true;
    }
  }

  return report;
}
