#!/usr/bin/env bash
# Tell the site to rebuild — a `vault-updated` repository_dispatch to tiro —
# when a run should publish (ADR 0032).
#
# The rule: a run deploys when it committed something, and also when a push,
# a manual run or a collections edit started it, committed or not. Such a
# push is a hand edit — `unlisted`, a deletion, a repair, a slug migration, a
# collection — whose content is already on main, so there is nothing to
# process and everything to publish. A scheduled run waits for a commit of its
# own: with nothing new, there is nothing to publish. The caller asks only once
# the run's commit step succeeded, so a deploy never publishes a vault the run
# failed to update.
#
# Inputs:
#   TIRO_TRIGGER     what started the run: push, workflow_dispatch, manual,
#                    schedule or publish
#   TIRO_COMMITTED   "true" when the run committed something
#   TIRO_DISPATCH_TOKEN, or TIRO_DISPATCH_TOKEN_FILE naming a file holding it:
#                    a token that may write to the site's repository
#   TIRO_SITE_REPO   the site's repository (default hutusi/tiro)
#   TIRO_GITHUB_API  the API to send it to (default https://api.github.com)
#
# Exits 0 when the site was told, or the rule says there is nothing to tell
# it; 1 when the dispatch was refused, could not be sent, or there is no
# token; 2 for a trigger it does not know.
set -eo pipefail

trigger="${TIRO_TRIGGER:-}"
case "$trigger" in
  push | workflow_dispatch | manual | publish) ;;
  schedule)
    if [ "${TIRO_COMMITTED:-}" != "true" ]; then
      echo "Not deploying: a scheduled run that committed nothing has nothing new to publish"
      exit 0
    fi
    ;;
  *)
    echo "::error::deploy.sh does not know the trigger '$trigger'" >&2
    exit 2
    ;;
esac

token="${TIRO_DISPATCH_TOKEN:-}"
if [ -z "$token" ] && [ -n "${TIRO_DISPATCH_TOKEN_FILE:-}" ]; then
  if ! token="$(cat "$TIRO_DISPATCH_TOKEN_FILE")"; then
    echo "::error::Could not read TIRO_DISPATCH_TOKEN_FILE ($TIRO_DISPATCH_TOKEN_FILE); the site was not told to rebuild"
    exit 1
  fi
  token="${token%$'\r'}"
fi
if [ -z "$token" ]; then
  echo "::error::No dispatch token (TIRO_DISPATCH_TOKEN or TIRO_DISPATCH_TOKEN_FILE); the site was not told to rebuild"
  exit 1
fi

repo="${TIRO_SITE_REPO:-hutusi/tiro}"
api="${TIRO_GITHUB_API:-https://api.github.com}"
# The token goes to curl on stdin, as its config: an argument would be on
# show to every user of the machine for as long as curl runs. printf is a
# builtin, so it never becomes one.
if ! status="$(
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS -o /dev/null -w '%{http_code}' --config - \
      --max-time 30 --retry 2 \
      -X POST \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      --data '{"event_type":"vault-updated"}' \
      "$api/repos/$repo/dispatches"
)"; then
  echo "::error::Could not reach $api to tell $repo to rebuild"
  exit 1
fi
if [ "$status" != "204" ]; then
  echo "::error::$repo refused the deploy dispatch (HTTP $status): check that the token can still write to it"
  exit 1
fi
echo "Asked $repo to rebuild the site ($trigger)"
