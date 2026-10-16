#!/usr/bin/env bash
# Run the processor over a vault: one processing run, as every host runs it.
#
#   process.sh <vault-dir>
#
# Inputs reach the processor as data, never as source — a slug is an
# argument, not part of a command line anything parses:
#   TIRO_FORCE  "true" to reprocess articles already marked processed
#   TIRO_SLUG   only this article
# The LLM key is whatever variable the vault's config names (llm.api_key_env).
# GITHUB_OUTPUT and GITHUB_STEP_SUMMARY, when set, get the run's failure count
# and summary (ADR 0032).
#
# Exits with the processor's own status: 0 for any run that reported (its
# failures are in the output, not the status), 1 without a key, anything else
# when it crashed.
set -eo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: process.sh <vault-dir>" >&2
  exit 2
fi
vault="$(cd "$1" && pwd)"
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

# Recorded on articles made from saved links: this checkout is the code that
# clips their pages (ADR 0034).
TIRO_COMMIT="$(git describe --always)"
export TIRO_COMMIT

args=(--vault "$vault")
if [ "${TIRO_FORCE:-}" = "true" ]; then args+=(--force); fi
if [ -n "${TIRO_SLUG:-}" ]; then args+=(--slug "$TIRO_SLUG"); fi
# exec: one process, so a signal meant for the run reaches the processor.
exec bun run packages/processor/src/cli.ts run "${args[@]}"
