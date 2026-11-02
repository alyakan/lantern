#!/bin/bash
# Prints the newest TestFlight builds (number and state). Run this before a build and before saying which number it is:
# other sessions upload builds too. The next build number is the newest plus one.
source "$(dirname "$0")/asc.sh"
asc GET "/v1/builds?filter[app]=$APP_ID&sort=-version&limit=3&fields[builds]=version,processingState" | grep -E '"version"|processingState'
git -C "$(dirname "$0")/../.." fetch origin --tags --quiet
git -C "$(dirname "$0")/../.." tag --sort=-creatordate -l "mobile-build-*" | head -3
