#!/bin/bash
# Shared by the TestFlight scripts: App Store Connect ids come from ~/.appstoreconnect/lantern.env (ASC_KEY_ID, ASC_ISSUER_ID;
# the .p8 key itself is in ~/.appstoreconnect/private_keys and is never printed). The API helper is Aly's asc.swift.
# shellcheck disable=SC1090
source "$HOME/.appstoreconnect/lantern.env" || { echo "missing ~/.appstoreconnect/lantern.env"; exit 1; }
export ASC_KEY_ID ASC_ISSUER_ID
ASC_TOOL="${ASC_TOOL:-swift /Users/alyyakan/dev/Github/Personal/prayers/tools/asc.swift}"
APP_ID=6825620145
asc() { $ASC_TOOL "$@"; }
