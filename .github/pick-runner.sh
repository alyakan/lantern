#!/bin/bash
# Says whether a job may use the maintainer's own Mac (the labels in CI_RUNNER) or goes to GitHub's runners: writes
# `mac=true` or `mac=false` to $GITHUB_OUTPUT. The Mac is used when it is online and idle; busy, asleep or gone, the job
# goes to GitHub's, so it doesn't sit waiting for a computer that won't pick it up.
#
# Reading a runner's state needs the Administration (read) permission, which the built-in GITHUB_TOKEN can't have: it is
# the repo secret RUNNER_STATUS_TOKEN, a fine-grained token for this repo only. Without that secret the Mac is used as
# before. This never fails: whatever goes wrong, the answer is false, a job that GitHub's runners can run.
#
# Env: RUNNER_LABELS (the CI_RUNNER variable, a JSON array of labels or one label), REPO (owner/name), GH_TOKEN (the
# secret, may be empty).
set -uo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
say() { echo "mac=$1" >> "$out"; exit 0; }

want=$(jq -c 'if type == "array" then . else [.] end' <<<"${RUNNER_LABELS:-}" 2>/dev/null) || say false
[ "$(jq 'length' <<<"$want")" -gt 0 ] || say false

if [ -z "${GH_TOKEN:-}" ]; then
  echo "No RUNNER_STATUS_TOKEN secret: the Mac is used without checking that it is free."
  say true
fi

# The reason is left out on purpose: an API error body has no business in a public log.
runners=$(gh api "repos/$REPO/actions/runners" --paginate --jq '.runners[]' 2>/dev/null) || {
  echo "::warning::Couldn't read the runners (is RUNNER_STATUS_TOKEN valid and unexpired?): using GitHub's."
  say false
}

free=$(jq -s --argjson want "$want" '
  [ .[]
    | select(.status == "online" and (.busy | not))
    | select([.labels[].name] as $have | all($want[]; . as $w | ($have | index($w)) != null))
  ] | length' <<<"$runners") || say false

if [ "${free:-0}" -gt 0 ]; then
  echo "The Mac is online and idle: using it."
  say true
fi
echo "The Mac is busy or offline: using GitHub's runner."
say false
