#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createDeadline } from "./deadline.ts";
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
  },
});

const command = positionals[0] ?? "run";
const vaultDir = values.vault;
const COMMANDS = new Set(["run", "validate", "repair"]);
if (vaultDir === undefined || !COMMANDS.has(command)) usage();

if (command === "validate") {
  process.exit(await validate(vaultDir));
} else if (command === "repair") {
  process.exit(await repair(vaultDir));
} else {
  process.exit(await run(vaultDir));
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
    const apiKey = process.env[config.llm.api_key_env];
    if (apiKey === undefined || apiKey === "") {
      console.error(
        `missing API key: set the ${config.llm.api_key_env} environment variable`,
      );
      return 1;
    }
    chat = createChatClient({
      baseUrl: config.llm.base_url,
      apiKey,
      timeoutMs: config.llm.timeout_ms,
      maxRetries: config.llm.max_retries,
      deadline,
    });
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
