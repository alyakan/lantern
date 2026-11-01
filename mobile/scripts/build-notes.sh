#!/usr/bin/env bash
# What's new in a phone build: feat/fix changes and user-facing PRs with a plain title that touched the app in mobile/ between $1 (the previous build's tag) and $2
# (the commit being built, HEAD when left out), oldest first, as "- " bullets. It is for the person using the app, so what only
# builds it is left out: a change that only touched mobile/fastlane or mobile/scripts (how a build is made and signed), and a PR
# whose "## Changelog" says "- none" (an internal change). A PR whose description has a "## Changelog" section adds its bullets;
# any other adds its title. Version bumps, chores, docs and Dependabot are left out, and so is a change that only regenerated
# the protocol bindings (a Mac-side change, which the Mac's release notes already tell). Needs gh logged in
# to read a PR's bullets: without it a PR falls back to its title. Same rules as .github/release-notes.sh, for the phone.
set -euo pipefail

from="${1:?the tag or commit of the previous build}"
to="${2:-HEAD}"

# The paths below are the repository's, whatever folder this is run from.
cd "$(git rev-parse --show-toplevel)"

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
    changelog=$(gh pr view "$pr" --json body -q .body 2>/dev/null | tr -d '\r' | awk '/^## /{on = /^## Changelog/; next} on && /^- /') || changelog=""
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
done < <(git log --reverse --format=%s "$from..$to" -- mobile/ ':(exclude)mobile/src/protocol/generated' ':(exclude)mobile/fastlane' ':(exclude)mobile/scripts')

printf %s "$notes"
