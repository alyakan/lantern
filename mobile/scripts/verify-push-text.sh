#!/bin/bash
# Compiles the notification extension's decrypt code (targets/notification-service/PushText.swift) on its own and checks it
# against the shared vector (src/protocol/push-vector.json), no device or Xcode project needed. Needs swiftc (Xcode's).
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -O -o "$out/verify" "$here/targets/notification-service/PushText.swift" "$here/scripts/verify-push-text/main.swift"
"$out/verify" "$here/src/protocol/push-vector.json"
