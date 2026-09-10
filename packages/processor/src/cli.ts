#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { TiroConfig } from "@tiro/shared/config";
import { backfillTitles } from "./backfill-titles.ts";
import { createDeadline, type Deadline } from "./deadline.ts";
import { type ChatFn, createChatClient } from "./llm/client.ts";
import { loadVaultConfig, runPipeline } from "./pipeline.ts";
import { repairVault } from "./repair.ts";
import { validateVault } from "./validate.ts";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  tiro-process run --vault <dir> [--slug <slug>] [--force] [--dry-run]",
      "  tiro-process validate --vault <dir>",
      "  tiro-process repair --vault <dir> [--slug <slug>] [--dry-run]",
      "  tiro-process backfill-titles --vault <dir> [--slug <slug>] [--force] [--dry-run] [--limit <n>]",
    ].join("\n"),
  );
  process.exit(2);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    vault: { type: "string" },
    slug: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    // parseArgs has no number type; validated where it is read.
    limit: { type: "string" },
  },
});

const command = positionals[0] ?? "run";
const vaultDir = values.vault;
const COMMANDS = new Set(["run", "validate", "repair", "backfill-titles"]);
if (vaultDir === undefined || !COMMANDS.has(command)) usage();

if (command === "validate") {
  process.exit(await validate(vaultDir));
} else if (command === "repair") {
  process.exit(await repair(vaultDir));
} else if (command === "backfill-titles") {
  process.exit(await backfill(vaultDir));
} else {
  process.exit(await run(vaultDir));
}

/**
 * The chat client both LLM commands build, in one place so they cannot drift on
 * the message that tells an operator which environment variable is missing.
 * Returns null when the key is absent, having already said so.
 */
function chatClientFor(config: TiroConfig, deadline: Deadline): ChatFn | null {
  const apiKey = process.env[config.llm.api_key_env];
  if (apiKey === undefined || apiKey === "") {
    console.error(
      `missing API key: set the ${config.llm.api_key_env} environment variable`,
    );
    return null;
  }
  return createChatClient({
    baseUrl: config.llm.base_url,
    apiKey,
    timeoutMs: config.llm.timeout_ms,
    maxRetries: config.llm.max_retries,
    deadline,
  });
}

async function run(vault: string): Promise<number> {
  const config = await loadVaultConfig(vault);
  const dryRun = values["dry-run"];
  // One clock for the whole run, shared with the chat client: the pipeline
  // decides what to start, the client makes sure nothing it starts outlives
  // the budget. Two separate deadlines would let a request run past the one
  // the pipeline is stopping against.
  const deadline = createDeadline(config.processing.run_budget_ms);

  let chat: ChatFn = async () => {
    throw new Error("LLM client unavailable in dry-run");
  };
  if (!dryRun) {
    const client = chatClientFor(config, deadline);
    if (client === null) return 1;
    chat = client;
  }

  const report = await runPipeline(
    {
      vaultDir: vault,
      ...(values.slug !== undefined ? { slug: values.slug } : {}),
      force: values.force,
      dryRun,
    },
    config,
    { chat, deadline },
  );

  console.log(
    `done: ${report.processed.length} processed, ${report.translated.length} translated, ` +
      `${report.imagesDownloaded} images downloaded (${report.imagesFailed} kept as hotlinks, ${report.imagesPruned} orphans removed), ` +
      `${report.summaryFailed.length} summary fallback(s), ${report.translationFailed.length} translation failure(s), ` +
      `${report.skipped.length} left for the next run, ${report.invalid.length} invalid`,
  );
  // Invalid articles are warnings here: exiting non-zero would fail the
  // workflow before its commit step, discarding the articles that DID
  // process. `validate` is the strict gate for contract violations.
  if (report.invalid.length > 0) {
    console.warn(
      `warning: ${report.invalid.length} invalid article(s) skipped — run 'tiro-process validate' for details`,
    );
  }
  // Not a warning: the run budget doing its job is the designed outcome for
  // an article too big to finish in one go. Its checkpoint is committed and
  // the next run resumes it, so say so plainly rather than as a failure.
  if (report.skipped.length > 0) {
    console.log(
      `budget reached; resuming next run: ${report.skipped.join(", ")}`,
    );
  }
  if (report.errored.length > 0) {
    for (const failure of report.errored) {
      // "stays pending" is a promise about the next run, and it is not always
      // true: an article whose marker could not be cleared, or whose forced
      // checkpoint could not be removed, keeps `processed_at` and will be
      // skipped rather than retried. Saying so either way beats a reassurance
      // that sends the operator back to a queue the article is not in.
      console.warn(
        failure.staysPending
          ? `warning: ${failure.slug} failed and stays pending: ${failure.error}`
          : `warning: ${failure.slug} failed and will NOT be retried by an ordinary run: ${failure.error}`,
      );
    }
  }
  return 0;
}

async function validate(vault: string): Promise<number> {
  const report = await validateVault(vault);
  for (const error of report.errors) console.error(error);
  console.log(
    `validated ${report.articles} article(s), ${report.errors.length} error(s)`,
  );
  return report.errors.length > 0 ? 1 : 0;
}

/**
 * Repair clip-time markdown defects in place. Separate from `run` on purpose:
 * it needs no LLM and no budget, rewrites articles that are already processed,
 * and is meant to be read as a diff before it is committed.
 */
async function repair(vault: string): Promise<number> {
  const report = await repairVault(vault, {
    ...(values.slug !== undefined ? { slug: values.slug } : {}),
    dryRun: values["dry-run"],
  });
  for (const article of report.repaired) {
    console.log(`repaired ${article.slug} (${article.files.join(", ")})`);
  }
  for (const failure of report.refused) {
    console.warn(
      `warning: ${failure.slug} left unchanged, repair broke alignment: ${failure.errors.join("; ")}`,
    );
  }
  console.log(
    `${values["dry-run"] ? "would repair" : "repaired"} ${report.repaired.length} of ${report.scanned} article(s), ${report.refused.length} refused`,
  );
  // Refusals are the guard working, not a crash — but they are also the only
  // signal that an article still carries a defect, so they must not exit 0.
  return report.refused.length > 0 ? 1 : 0;
}

/**
 * Fill in the translated titles of articles processed before `title_zh`
 * existed. Hand-run and read as a diff, like `repair` — it rewrites articles
 * that are already processed and never touches their processing markers, so
 * nothing is re-queued and no deploy fires.
 */
async function backfill(vault: string): Promise<number> {
  const config = await loadVaultConfig(vault);
  const dryRun = values["dry-run"];
  const deadline = createDeadline(config.processing.run_budget_ms);

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`--limit must be a positive integer, got: ${values.limit}`);
      return 2;
    }
  }

  let chat: ChatFn = async () => {
    throw new Error("LLM client unavailable in dry-run");
  };
  if (!dryRun) {
    const client = chatClientFor(config, deadline);
    if (client === null) return 1;
    chat = client;
  }

  const report = await backfillTitles(
    vault,
    config,
    {
      ...(values.slug !== undefined ? { slug: values.slug } : {}),
      ...(limit !== undefined ? { limit } : {}),
      force: values.force,
      dryRun,
    },
    { chat, deadline, log: (message) => console.log(message) },
  );

  for (const article of report.filled) {
    console.log(
      article.titleZh === null
        ? `would translate ${article.slug}: ${article.title}`
        : `${article.slug}: ${article.title} → ${article.titleZh}`,
    );
  }
  for (const failure of report.failed) {
    console.warn(`warning: ${failure.slug} kept no title: ${failure.error}`);
  }
  for (const bad of report.invalid) {
    console.warn(`warning: ${bad.path} could not be read: ${bad.error}`);
  }
  console.log(
    `${dryRun ? "would fill" : "filled"} ${report.filled.length} of ${report.scanned} article(s), ` +
      `${report.skipped.length} skipped, ${report.failed.length} failed, ${report.invalid.length} unreadable, ` +
      `${report.remaining.length} left for a re-run`,
  );
  if (report.remaining.length > 0) {
    console.log(`re-run to continue: ${report.remaining.join(", ")}`);
  }
  // This exit code is the only signal that an article still has no title, so an
  // article that could not be read has to count too: it got no title and no call
  // was even attempted. Unlike `run`, which treats invalid articles as warnings
  // because exiting non-zero there would fail the vault workflow before its
  // commit step and discard the articles that did process (invariant 7), this
  // command is hand-run and read as a diff — like `repair`, which exits non-zero
  // on a refusal.
  return report.failed.length > 0 || report.invalid.length > 0 ? 1 : 0;
}
