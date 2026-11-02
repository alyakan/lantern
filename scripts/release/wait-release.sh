#!/bin/bash
# Waits (up to ~30 min) for the release workflow run of tag v$1 to finish, then prints its result and the draft release.
# usage: wait-release.sh 0.1.66
V="$1"
[ -n "$V" ] || { echo "usage: wait-release.sh <version>"; exit 1; }
REPO=alyakan/lantern
run=""
for i in $(seq 1 30); do
  run=$(gh run list --repo "$REPO" --workflow release.yml --json databaseId,headBranch --jq ".[] | select(.headBranch==\"v$V\") | .databaseId" | head -1)
  [ -n "$run" ] && break
  sleep 10
done
[ -n "$run" ] || { echo "no release run for v$V"; exit 1; }
for i in $(seq 1 180); do
  s=$(gh run view "$run" --repo "$REPO" --json status,conclusion --jq '"\(.status) \(.conclusion)"')
  case "$s" in completed*) break;; esac
  sleep 10
done
echo "run $run: $s"
gh release view "v$V" --repo "$REPO" --json isDraft,name,url,assets --jq '"draft=\(.isDraft) \(.name) \(.url)\n" + ([.assets[].name] | join("\n"))' 2>&1
