#!/bin/bash
# Waits (up to ~12 min) for TestFlight build $1 to finish processing, then answers its encryption export question the way it
# was answered for builds 1 to 3 (standard Noise/X25519/ChaCha20 encryption: no extra declaration), and prints the result.
# usage: testflight-compliance.sh 24
source "$(dirname "$0")/asc.sh"
V="$1"
[ -n "$V" ] || { echo "usage: testflight-compliance.sh <build>"; exit 1; }
for i in $(seq 1 24); do
  out=$(asc GET "/v1/builds?filter[app]=$APP_ID&filter[version]=$V&fields[builds]=version,processingState,usesNonExemptEncryption" 2>&1)
  id=$(echo "$out" | grep -m1 '"id"' | sed 's/.*: "\(.*\)".*/\1/')
  if [ -n "$id" ] && echo "$out" | grep -q '"processingState" : "VALID"'; then
    echo "build $V is $id and VALID"
    asc PATCH "/v1/builds/$id" "{\"data\":{\"type\":\"builds\",\"id\":\"$id\",\"attributes\":{\"usesNonExemptEncryption\":false}}}" 2>&1 | grep -E "HTTP|usesNonExempt"
    exit 0
  fi
  sleep 30
done
echo "build $V did not finish processing in time"
