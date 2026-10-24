#!/bin/bash
# Downloads the release's dmg (draft or published), copies the app out, and checks its signature and notarization.
# Does not touch /Applications. usage: stage-mac.sh 0.1.66  ->  /tmp/lantern-install-0.1.66/Lantern.app
set -e
V="$1"
[ -n "$V" ] || { echo "usage: stage-mac.sh <version>"; exit 1; }
DL=/tmp/lantern-dl-$V
MNT=/tmp/lantern-mount-$V
OUT=/tmp/lantern-install-$V
rm -rf "$DL" "$OUT" "$MNT"
mkdir -p "$DL" "$OUT" "$MNT"
gh release download "v$V" --repo alyakan/lantern --pattern "*aarch64.dmg" --dir "$DL"
DMG=$(ls "$DL"/*.dmg)
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null
trap 'hdiutil detach "$MNT" >/dev/null 2>&1 || true' EXIT
ditto "$MNT/Lantern.app" "$OUT/Lantern.app"
echo "version: $(defaults read "$OUT/Lantern.app/Contents/Info" CFBundleShortVersionString)"
codesign --verify --deep --strict "$OUT/Lantern.app" && echo "codesign: ok"
codesign -dv "$OUT/Lantern.app" 2>&1 | grep -E "Authority=Developer ID Application|TeamIdentifier"
spctl --assess --type execute -v "$OUT/Lantern.app" 2>&1
xcrun stapler validate "$OUT/Lantern.app" 2>&1 | tail -1
