#!/usr/bin/env bash
# What's new in the release tagged $1: feat/fix changes and user-facing PRs with a plain title merged since the previous tag, oldest first. A PR whose
# description has a "## Changelog" section adds its bullets; any other adds its title. Version bumps, chores, docs and
# Dependabot are left out. It is for the person using the app, so what only builds, signs or documents it is left out too: a
# change that only touched mobile/fastlane, mobile/scripts, .github or docs, and a PR whose "## Changelog" says "- none" (an
# internal change). Needs the full history with tags, and gh logged in (GH_TOKEN in CI).
set -euo pipefail

tag="$1"
# Only the Mac's own tags count: the phone's builds are tagged mobile-build-N, and are not a release of this.
prev=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)

notes=""
while IFS= read -r subject; do
  if [[ "$subject" =~ ^(feat|fix)(\(.*\))?!?:\ (.*)$ ]]; then
    title="${BASH_REMATCH[3]}"
  elif [[ "$subject" =~ ^.+\ \(#([0-9]+)\)$ ]] && [[ ! "$subject" =~ ^(chore|docs|ci|build|test|refactor|style)(\(|:) ]]; then
    # A merged user-facing PR can have a plain title, as #378 does.
    title="$subject"
  else
    continue
  fi
  changelog=""
  if [[ "$title" =~ ^(.*)\ \(#([0-9]+)\)$ ]]; then
    title="${BASH_REMATCH[1]}"
    pr="${BASH_REMATCH[2]}"
    # A PR that can't be read (an issue's number, a rate limit, not logged in) falls back to its title below.
    changelog=$(gh pr view "$pr" --json body -q .body | tr -d '\r' | awk '/^## /{on = /^## Changelog/; next} on && /^- /') || changelog=""
  fi
  # "- none" says the change is internal: it has nothing to tell the person using the app.
  if [ "$(printf %s "$changelog" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:].')" = "-none" ]; then
    continue
  fi
  if [ -n "$changelog" ]; then
    notes+="$changelog"$'\n'
  else
    # Capitalised by hand: macOS's bash 3.2 has no ${title^}.
    notes+="- $(printf %s "${title:0:1}" | tr '[:lower:]' '[:upper:]')${title:1}"$'\n'
  fi
done < <(git log --reverse --format=%s "${prev:+$prev..}$tag" -- . ':(exclude)mobile/fastlane' ':(exclude)mobile/scripts' ':(exclude).github' ':(exclude)docs')

if [ -n "$notes" ]; then
  printf "## What's new\n\n%s\n" "$notes"
fi
