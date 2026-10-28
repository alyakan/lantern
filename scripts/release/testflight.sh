#!/bin/bash
# Builds the phone app from origin/main and uploads it to TestFlight (fastlane `ios beta`), in its own worktree so nothing in
# progress is built by accident. About 7 minutes. Run in the background; needs the user's typed go-ahead first.
# The lane tags the build locally (mobile-build-0.1.0-N): push the tag after (needs approval), once the compliance step is done.
source "$(dirname "$0")/asc.sh"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WT="$(dirname "$REPO")/lantern-wt/testflight"
git -C "$REPO" fetch origin --tags --quiet
if [ -d "$WT" ]; then
  git -C "$WT" checkout --detach origin/main --quiet || exit 1
else
  git -C "$REPO" worktree add --detach "$WT" origin/main || exit 1
fi
source ~/.nvm/nvm.sh
nvm use 24 >/dev/null
export LANG=en_US.UTF-8 FASTLANE_SKIP_UPDATE_CHECK=1 FASTLANE_OPT_OUT_USAGE=1
unset EXPO_PUBLIC_FAKE_TIPS
cd "$WT/mobile" || exit 1
git -C .. log --oneline -1
npm ci --ignore-scripts > /tmp/lantern-npm-ci.log 2>&1
fastlane ios beta > /tmp/lantern-testflight.log 2>&1
echo "exit: $?" >> /tmp/lantern-testflight.log
grep -E "Build [0-9]+ of|Uploaded build|error|Error|exit:" /tmp/lantern-testflight.log | tail -8 | cut -c1-220
