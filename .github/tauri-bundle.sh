#!/bin/bash
# tauri-action runs "<tauriScript> build <args>". In release.yml the app is already compiled (by the build job, whose binary
# is downloaded into target/), so it is bundled instead: signed, made into the dmg and the self-update, without compiling.
set -euo pipefail
if [ "${1:-}" != build ]; then
  echo "tauri-bundle.sh: expected 'build', got '${1:-}'" >&2
  exit 1
fi
shift
exec npx tauri bundle "$@"
