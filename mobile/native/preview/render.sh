#!/bin/bash
# Draws mobile/native/LanternCard.swift in each of its states to a picture (default /tmp/lantern-card.png).
# Needs only the Xcode command line tools: no simulator, no phone.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-/tmp/lantern-card.png}"
bin="$(mktemp -d)/lantern-card-preview"
swiftc -O -o "$bin" "$here/../LanternCard.swift" "$here/main.swift" 2>&1
"$bin" "$out"
