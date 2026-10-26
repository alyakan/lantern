#!/bin/bash
# Quits Lantern, replaces /Applications/Lantern.app with the staged copy (see stage-mac.sh), marks the next launch so the open
# chats come back, and opens it. It quits the app that is running the session that started it: run it DETACHED
# (nohup bash scripts/release/swap-mac.sh 0.1.66 >/dev/null 2>&1 &), then read /tmp/lantern-swap-<version>.log.
V="$1"
[ -n "$V" ] || { echo "usage: swap-mac.sh <version>"; exit 1; }
STAGED=/tmp/lantern-install-$V/Lantern.app
[ -d "$STAGED" ] || { echo "stage it first: stage-mac.sh $V"; exit 1; }
LOG=/tmp/lantern-swap-$V.log
exec > "$LOG" 2>&1
sleep 3
osascript -e 'tell application "Lantern" to quit'
for i in $(seq 1 40); do
  pgrep -f "/Applications/Lantern.app/Contents/MacOS/lantern" >/dev/null || break
  sleep 1
done
sleep 2
rm -rf /Applications/Lantern.app.old
mv /Applications/Lantern.app /Applications/Lantern.app.old || exit 1
ditto "$STAGED" /Applications/Lantern.app || { mv /Applications/Lantern.app.old /Applications/Lantern.app; exit 1; }
xattr -dr com.apple.quarantine /Applications/Lantern.app
# Read once by the new app at launch (ignored if older than 10 minutes): without it a script swap loses the open chats (0.1.59+).
touch "$HOME/Library/Application Support/io.github.alyakan.lantern/restore-on-launch"
open -a /Applications/Lantern.app
sleep 5
defaults read /Applications/Lantern.app/Contents/Info CFBundleShortVersionString
rm -rf /Applications/Lantern.app.old
echo done
