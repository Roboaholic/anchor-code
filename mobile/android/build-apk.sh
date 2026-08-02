#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]]; then
  sdk=$ANDROID_HOME
elif [[ -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT" ]]; then
  sdk=$ANDROID_SDK_ROOT
elif [[ -d /home/zhenyu/env/android-sdk ]]; then
  sdk=/home/zhenyu/env/android-sdk
elif [[ -d /home/zhenyu/app_env/android-sdk ]]; then
  sdk=/home/zhenyu/app_env/android-sdk
else
  echo 'Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.' >&2
  exit 2
fi

ANDROID_HOME=$sdk ANDROID_SDK_ROOT=$sdk "$script_dir/gradlew" -p "$script_dir" assembleDebug
