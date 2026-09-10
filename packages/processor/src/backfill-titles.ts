import { parseArticle, stringifyArticle } from "@tiro/shared";
import { modelFor, type TiroConfig } from "@tiro/shared/config";
import { createDeadline, type Deadline } from "./deadline.ts";
import type { ChatFn } from "./llm/client.ts";
import { translateTitle } from "./llm/title.ts";

/**
 * Fill `title_zh` on articles the processor finished before the field existed
 * (ADR 0016).
 *
 * A one-shot repair path rather than a mode of `run`, for the same reasons
 * `repair` and `sweep --recanonicalize` are their own commands. `run` selects
 * by "processed_at is absent" (invariant 3); this needs exactly the articles
 * where it is *present*, and must not write it. Putting that inversion into
 * the code the vault workflow executes on every push, permanently, for a
 * one-time migration is the wrong trade.
 *
 * `--force` over the vault would do the job too, and cost the wrong thing:
 * only 12 of the vault's 39 translated articles still hold a translation
 * checkpoint, so 27 whole bodies would be re-translated and every image
 * re-downloaded, across hours of runs, to add one line each — inside a
 * 40-file diff that buries the 39 lines worth reading.
 */

export type BackfillSkipReason =
  | "zh-original"
  | "pending"
  | "already-translated";

export interface BackfillReport {
  scanned: number;
  /** `titleZh` is null under --dry-run, which makes no call and so has no
   * translation to report — only the fact that this article wants one. */
  filled: { slug: string; title: string; titleZh: string | null }[];
  skipped: { slug: string; reason: BackfillSkipReason }[];
  failed: { slug: string; error: string }[];
  /** Not reached: the budget ran out, or `--limit` was hit. Re-run to continue —
   * `title_zh` is its own progress marker, so there is nothing else to resume. */
  remaining: string[];
  invalid: { path: string; error: string }[];
}

export interface BackfillOptions {
  slug?: string;
  force?: boolean;
  dryRun?: boolean;
  limit?: number;
}

export interface BackfillDeps {
  chat: ChatFn;
  deadline?: Deadline;
  log?: (message: string) => void;
}

/**
 * Three consecutive failures ends the run.
 *
 * A dead provider otherwise costs 39 articles x maxRetries x the request
 * timeout before anyone sees a result, and every one of those failures is the
 * same failure. Same reasoning as the timeout-attempt limit in the chat client.
 */
const CONSECUTIVE_FAILURE_LIMIT = 3;

export async function backfillTitles(
  vaultDir: string,
  config: TiroConfig,
  options: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const log = deps.log ?? (() => {});
  // One clock, like `run`'s: this command is short, but invariant 8 says the
  // processor's budget is a single absolute deadline binding every stage and
  // request, and a second entry point that ignores it is a second way to hang
  // past the workflow's cap.
  const deadline =
    deps.deadline ?? createDeadline(config.processing.run_budget_ms);
  const model = modelFor(config, "summary");
  const target = config.translation.target;

  const articlesDir = `${vaultDir}/articles`;
  const report: BackfillReport = {
    scanned: 0,
    filled: [],
    skipped: [],
    failed: [],
    remaining: [],
    invalid: [],
  };

  const relPaths = Array.from(
    new Bun.Glob("*/index.md").scanSync({ cwd: articlesDir }),
  ).sort();

  let consecutiveFailures = 0;
  let stopped = false;

  for (const relPath of relPaths) {
    const [slug] = relPath.split("/");
    if (slug === undefined) continue;
    if (options.slug !== undefined && options.slug !== slug) continue;

    // Counted before the read, the way `repairVault` does it: an article that
    // cannot be parsed was still looked at, and "0 of 0" would read as "nothing
    // to do" rather than "the one you named is broken".
    report.scanned += 1;

    const indexAbs = `${articlesDir}/${relPath}`;
    let parsed: ReturnType<typeof parseArticle>;
    try {
      parsed = parseArticle(await Bun.file(indexAbs).text());
    } catch (error) {
      // One unreadable article never wedges the batch — the same isolation
      // `run` gives a failing article (invariant 7). It is still counted
      // against the command's exit status by the caller: it got no title, and
      // nothing else will say so.
      report.invalid.push({ path: relPath, error: String(error) });
      continue;
    }
    const { frontmatter, body } = parsed;

    if (frontmatter.lang === target) {
      report.skipped.push({ slug, reason: "zh-original" });
      continue;
    }
    if (frontmatter.tiro.processed_at === undefined) {
      // `run` will do this one better: it has the body, and it writes the
      // title in the same call as the summary.
      report.skipped.push({ slug, reason: "pending" });
      continue;
    }
    if (frontmatter.title_zh !== undefined && options.force !== true) {
      report.skipped.push({ slug, reason: "already-translated" });
      continue;
    }
    // Everything from here down is a genuine candidate, which is why the three
    // skips above come first: `remaining` promises a re-run will get to these,
    // and a Chinese original listed there would be a promise nothing can keep.
    //
    // The limit is applied above the dry-run branch, not with the deadline
    // below it, because it scopes *which articles this invocation is about* —
    // the same job `--slug` does, and `--slug` has always narrowed a dry run.
    // A dry run answering "what would --limit 3 do" with all 39 is the flag
    // meaning one thing in one mode and another in the other.
    if (options.limit !== undefined && report.filled.length >= options.limit) {
      stopped = true;
      report.remaining.push(slug);
      continue;
    }
    if (options.dryRun === true) {
      report.filled.push({ slug, title: frontmatter.title, titleZh: null });
      continue;
    }
    // The budget is not applied to a dry run: it makes no calls, so there is
    // nothing for a clock to protect.
    if (stopped || deadline.expired(config.llm.timeout_ms)) {
      stopped = true;
      report.remaining.push(slug);
      continue;
    }

    try {
      const titleZh = await translateTitle({
        chat: deps.chat,
        model,
        targetLang: target,
        title: frontmatter.title,
        domain: frontmatter.domain,
        ...(frontmatter.summary !== undefined
          ? { summary: frontmatter.summary }
          : {}),
        log,
      });
      if (titleZh === null) {
        // Not an exception, but not a success either: the article still has no
        // title, and that has to exit non-zero or nothing says so.
        report.failed.push({ slug, error: "no usable translation" });
        consecutiveFailures += 1;
      } else {
        // Stripped and re-added rather than assigned, so the key lands after
        // `tags` — where `processOne` puts it. Assigning onto the parsed object
        // would keep the schema's own position and make the next --force run a
        // pure-reordering diff.
        const { title_zh: _stale, ...previous } = frontmatter;
        await Bun.write(
          indexAbs,
          stringifyArticle({ ...previous, title_zh: titleZh }, body),
        );
        report.filled.push({ slug, title: frontmatter.title, titleZh });
        consecutiveFailures = 0;
      }
    } catch (error) {
      report.failed.push({ slug, error: String(error) });
      consecutiveFailures += 1;
    }

    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      log(
        `${consecutiveFailures} failures in a row; stopping rather than repeating them`,
      );
      stopped = true;
    }
  }

  return report;
}
