import { appendFileSync } from "node:fs";
import { type PipelineReport, PROVIDER_FAILURE_LIMIT } from "./pipeline.ts";

/**
 * How many outcomes of a run will not fix themselves by waiting (ADR 0032).
 *
 * A hard failure and an article that no longer parses both need a person:
 * the first is retried, but a retry that keeps failing is only ever visible
 * here, and the second is skipped by every run until someone edits it. Neither
 * a budget deferral nor a settled marker counts. A deferral is the budget
 * doing its job, and `summary_failed` / `translation_failed` are recorded in
 * the article itself, never retried, and listed in the summary instead — so a
 * red run means "look at this", not "this happened once". An article the run
 * halted before (a provider outage) is pending work too; the outages that
 * halted it are what count.
 */
export function failureCount(report: PipelineReport): number {
  return report.errored.length + report.invalid.length;
}

/** An error message as one line of Markdown that cannot break its list item. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

function slugs(list: readonly string[]): string {
  return list.map((slug) => `\`${slug}\``).join(", ");
}

/** A Markdown account of one run, for the workflow's job summary. */
export function formatRunSummary(report: PipelineReport): string {
  const lines = [
    "### Tiro processing run",
    "",
    "| | |",
    "| --- | --- |",
    `| Processed | ${report.processed.length} |`,
    `| Translated | ${report.translated.length} |`,
    `| Left for the next run | ${report.skipped.length} |`,
    ...(report.halted.length > 0
      ? [`| Not attempted | ${report.halted.length} |`]
      : []),
    `| Failed | ${report.errored.length} |`,
    `| Invalid | ${report.invalid.length} |`,
    `| Images | ${report.imagesDownloaded} downloaded, ${report.imagesFailed} kept as hotlinks, ${report.imagesPruned} orphans removed |`,
  ];

  if (report.errored.length > 0) {
    lines.push("", "**Failed** — these turn the run red:");
    for (const failure of report.errored) {
      const fate = failure.staysPending
        ? "stays pending, retried next run"
        : "will NOT be retried by an ordinary run";
      lines.push(`- \`${failure.slug}\` (${fate}): ${oneLine(failure.error)}`);
    }
  }
  if (report.invalid.length > 0) {
    lines.push(
      "",
      "**Invalid** — skipped by every run until fixed; `tiro-process validate` has the details:",
    );
    for (const bad of report.invalid) {
      lines.push(`- \`${bad.path}\`: ${oneLine(bad.error)}`);
    }
  }
  if (report.summaryFailed.length > 0 || report.translationFailed.length > 0) {
    lines.push(
      "",
      "**Needs a look** — processed, but marked in the article; reprocess with `force` + slug:",
    );
    if (report.summaryFailed.length > 0) {
      lines.push(`- summary fallback: ${slugs(report.summaryFailed)}`);
    }
    if (report.translationFailed.length > 0) {
      lines.push(`- translation failed: ${slugs(report.translationFailed)}`);
    }
  }
  if (report.skipped.length > 0) {
    lines.push(
      "",
      `**Left for the next run** (budget reached): ${slugs(report.skipped)}`,
    );
  }
  if (report.halted.length > 0) {
    lines.push(
      "",
      `**Stopped early** — the provider failed ${PROVIDER_FAILURE_LIMIT} articles in a row; not attempted, still pending: ${slugs(report.halted)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Hand a run's outcome to GitHub Actions when running there: the summary to
 * `$GITHUB_STEP_SUMMARY`, and `failures=<n>` to `$GITHUB_OUTPUT` for the
 * workflow's last step, which turns the job red only after the commit and the
 * deploy (invariant 7). Outside Actions neither variable is set and this does
 * nothing.
 *
 * Never throws. By the time this runs the articles are written, and a report
 * that could not be saved is no reason to crash out of a run that worked and
 * turn it red for the wrong cause. It warns instead; a missing failure count
 * leaves the job green, and the warning in the log is what explains it.
 */
export function publishRunReport(
  report: PipelineReport,
  env: Record<string, string | undefined> = process.env,
  append: (path: string, text: string) => void = appendFileSync,
  warn: (message: string) => void = console.warn,
): void {
  const targets: [string | undefined, string, string][] = [
    [env.GITHUB_STEP_SUMMARY, formatRunSummary(report), "job summary"],
    [env.GITHUB_OUTPUT, `failures=${failureCount(report)}\n`, "failure count"],
  ];
  for (const [path, text, what] of targets) {
    if (path === undefined || path === "") continue;
    try {
      append(path, text);
    } catch (error) {
      warn(`warning: could not write the ${what}: ${String(error)}`);
    }
  }
}
