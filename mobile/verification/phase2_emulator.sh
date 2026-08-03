#!/usr/bin/env bash
set -euo pipefail

: "${ANCHOR_APK:?source contract.sh first}"
: "${ANDROID_ADB:?source contract.sh first}"

serial=${ANDROID_EMULATOR_SERIAL:-emulator-5554}
"$ANDROID_ADB" -s "$serial" get-state >/dev/null
"$ANDROID_ADB" -s "$serial" install -r "$ANCHOR_APK" >/dev/null
"$ANDROID_ADB" -s "$serial" shell pm clear com.roboaholic.anchormobile >/dev/null
"$ANDROID_ADB" -s "$serial" shell am start \
  -n com.roboaholic.anchormobile/.MainActivity >/dev/null
sleep 6

activities=$("$ANDROID_ADB" -s "$serial" shell dumpsys activity activities)
if ! rg -q 'com.roboaholic.anchormobile/.MainActivity' <<< "$activities"; then
  echo 'PHASE2 RESULT=FAIL CLASS=APP_RUNTIME' >&2
  exit 1
fi

out=${ANCHOR_PHASE2_SCREENSHOT:-/tmp/anchor-mobile-phase2.png}
"$ANDROID_ADB" -s "$serial" exec-out screencap -p > "$out"
echo "PHASE2 RESULT=PASS feature=anchor_mobile_scan_ready screenshot=$out"
