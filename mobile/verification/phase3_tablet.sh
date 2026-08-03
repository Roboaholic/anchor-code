#!/usr/bin/env bash
set -euo pipefail

: "${ANCHOR_APK:?source contract.sh first}"
: "${TABLET_ADB:?source contract.sh first}"
: "${TABLET_SERIAL:?source contract.sh first}"

port=${TABLET_ADB_PORT:-5038}
apk_win=$(wslpath -w "$ANCHOR_APK")

"$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" get-state >/dev/null
abi=$("$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r')
"$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" install -r "$apk_win" >/dev/null
"$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" shell pm clear com.roboaholic.anchormobile >/dev/null
"$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" shell am start \
  -n com.roboaholic.anchormobile/.MainActivity >/dev/null
sleep 8

activities=$("$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" shell dumpsys activity activities)
if ! rg -q 'com.roboaholic.anchormobile/.MainActivity' <<< "$activities"; then
  echo 'PHASE3 RESULT=FAIL CLASS=APP_RUNTIME' >&2
  exit 1
fi

out=${ANCHOR_PHASE3_SCREENSHOT:-/tmp/anchor-mobile-phase3.png}
"$TABLET_ADB" -P "$port" -s "$TABLET_SERIAL" exec-out screencap -p > "$out"
echo "PHASE3 RESULT=PASS feature=anchor_mobile_scan_ready abi=$abi screenshot=$out"
