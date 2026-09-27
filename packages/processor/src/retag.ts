import {
  type ArticleFrontmatter,
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
  inVaultScripts,
  MIN_TAGS,
  respell,
  undecided,
  undecidedTags,
  VOCABULARY_MIN_ARTICLES,
  writableTags,
} from "./tag-policy.ts";

/**
 * Give already-processed articles their tags in the vault's form (ADR 0033,
 * ADR 0035): Chinese first, spelled as the aliases and the vocabulary spell
 * them, the article's topics kept.
 *
 * A one-shot command beside `backfill-titles`, for its reasons: it needs
 * exactly the articles `run` skips, must not touch their processing markers,
 * and a `--force` over the vault would re-translate whole bodies and
 * re-download every image to change one line each. An article whose tags only
 * need respelling by the aliases is rewritten with no call; the rest take one
 * small call each, from the title and summary.
 */

export type RetagSkipReason = "pending" | "already-tagged";

export interface RetagReport {
  scanned: number;
  /** Asked the model. `after` is null under --dry-run, which makes no call. */
  retagged: { slug: string; before: string[]; after: string[] | null }[];
  /** Rewritten with no call: the aliases alone put its tags in the vault's
   * form. Under --dry-run, what they would be. */
  respelled: { slug: string; before: string[]; after: string[] }[];
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
  /** `undecided` tags two or more articles share. Until each has an alias, the
   * run is `refused`: those are the tags the vocabulary should offer, and it
   * cannot offer them in a spelling the vault has not chosen (ADR 0035). */
  undecided: { tag: string; articles: number }[];
  refused: boolean;
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
 * Whether tags, already respelled, are in the vault's form: `MIN_TAGS` to
 * `TAG_LIMIT` of them, none in kana or hangul, none still `undecided`. An
 * article whose respelled tags pass needs no call — written as respelled, or
 * skipped when that is what it already has — unless `--force`. That is what
 * makes the command resumable: a retagged article passes, so a re-run asks
 * about none of them. There is no cap on new tags here, since translating an
 * article's tags makes each one new to the vocabulary by spelling; what a
 * re-run does ask about again is a tag the model left in lowercase English,
 * until an alias settles it.
 */
function settled(
  tags: readonly string[],
  aliases: ReadonlyMap<string, string | null>,
): boolean {
  return (
    tags.length >= MIN_TAGS &&
    tags.length <= TAG_LIMIT &&
    tags.every(inVaultScripts) &&
    !tags.some((tag) => undecided(tag, aliases))
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
    respelled: [],
    unchanged: [],
    skipped: [],
    failed: [],
    remaining: [],
    invalid: [],
    vocabulary: [],
    undecided: [],
    refused: false,
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
  const tagLists = articles.map((a) => a.parsed.frontmatter.tags ?? []);
  report.vocabulary = buildVocabulary(tagLists, aliases);
  report.undecided = undecidedTags(tagLists, aliases).filter(
    (t) => t.articles >= VOCABULARY_MIN_ARTICLES,
  );
  // The order a migration to Chinese-first tags needs, enforced: aliases
  // first. Retagged against a vocabulary missing the vault's own recurring
  // tags, articles would each coin their own spelling of them. A dry run
  // still shows what it would do.
  if (report.undecided.length > 0 && options.dryRun !== true) {
    report.refused = true;
    return report;
  }

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
    const respelled = respell(before, aliases, report.vocabulary);
    const needsNoCall = options.force !== true && settled(respelled, aliases);
    if (needsNoCall && sameTags(respelled, before)) {
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
    if (needsNoCall) {
      if (options.dryRun !== true) {
        try {
          await Bun.write(
            `${articlesDir}/${relPath}`,
            stringifyArticle(withTags(frontmatter, respelled), body),
          );
        } catch (error) {
          // One article, like any other failure here: recorded, and the run
          // goes on. Not counted toward the breaker, which is for a provider
          // failing the same small request — no request was made.
          report.failed.push({ slug, error: String(error) });
          continue;
        }
      }
      report.respelled.push({ slug, before: [...before], after: respelled });
      continue;
    }
    if (options.dryRun === true) {
      report.retagged.push({ slug, before: [...before], after: null });
      continue;
    }
    if (stopped || deadline.expired(config.llm.timeout_ms)) {
      stopped = true;
      report.remaining.push(slug);
      continue;
    }

    // The Chinese summary the site shows, with the original beside it for
    // exact names; a Chinese article has only the first.
    const summary = frontmatter.summary ?? frontmatter.summary_orig;
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
        title: frontmatter.title_zh ?? frontmatter.title,
        ...(frontmatter.title_zh !== undefined
          ? { originalTitle: frontmatter.title }
          : {}),
        summary,
        ...(frontmatter.summary_orig !== undefined &&
        frontmatter.summary_orig !== summary
          ? { originalSummary: frontmatter.summary_orig }
          : {}),
        currentTags: respelled,
        vocabulary: report.vocabulary,
        log,
      });
      // No cap on new tags: each tag translated is new to the vocabulary by
      // spelling, and capping them is how a pilot lost an article's topic.
      const after =
        offered === null
          ? []
          : writableTags(offered, aliases, log, report.vocabulary, {
              maxNew: Number.POSITIVE_INFINITY,
            });
      if (after.length < MIN_TAGS) {
        // Its old tags stay: fewer than three would take it off tag pages it
        // was on, for a reply that did not follow the prompt.
        report.failed.push({
          slug,
          error:
            after.length === 0
              ? "no usable tags in the reply"
              : `only ${after.length} usable tag(s) in the reply`,
        });
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
