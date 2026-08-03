#!/usr/bin/env bash
set -euo pipefail

: "${ANCHOR_RELAY_URL:=https://anchor-code-relay.anchor-code-mobile.workers.dev}"

health=$(curl -fsS "${ANCHOR_RELAY_URL}/health")
node -e '
const health = JSON.parse(process.argv[1]);
if (!health.ok || health.service !== "anchor-code-relay" || health.protocolVersion !== 1) process.exit(2);
' "$health"

echo "PHASE1 RESULT=PASS feature=anchor_relay url=${ANCHOR_RELAY_URL}"
