#!/usr/bin/env bash
# What's new in the release tagged $1: every feat: and fix: merged since the previous tag, oldest first. A PR whose
# description has a "## Changelog" section adds its bullets; any other adds its title. Version bumps, chores, docs and
# Dependabot are left out. Needs the full history with tags, and gh logged in (GH_TOKEN in CI).
set -euo pipefail

tag="$1"
prev=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || true)

notes=""
while IFS= read -r subject; do
  [[ "$subject" =~ ^(feat|fix)(\(.*\))?!?:\ (.*)$ ]] || continue
  title="${BASH_REMATCH[3]}"
  changelog=""
  if [[ "$title" =~ ^(.*)\ \(#([0-9]+)\)$ ]]; then
    title="${BASH_REMATCH[1]}"
    pr="${BASH_REMATCH[2]}"
    changelog=$(gh pr view "$pr" --json body -q .body | tr -d '\r' | awk '/^## /{on = /^## Changelog/; next} on && /^- /')
  fi
  if [ -n "$changelog" ]; then
    notes+="$changelog"$'\n'
  else
    # Capitalised by hand: macOS's bash 3.2 has no ${title^}.
    notes+="- $(printf %s "${title:0:1}" | tr '[:lower:]' '[:upper:]')${title:1}"$'\n'
  fi
done < <(git log --reverse --format=%s "${prev:+$prev..}$tag")

if [ -n "$notes" ]; then
  printf "## What's new\n\n%s\n" "$notes"
fi
