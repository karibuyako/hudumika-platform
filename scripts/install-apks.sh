#!/usr/bin/env bash
# Install Hudumika APKs onto a USB-connected Android phone (USB debugging on).
# Usage:
#   ./scripts/install-apks.sh            # download v1.0.9 APKs + install all 3
#   ./scripts/install-apks.sh --logs     # follow logcat filtered to Hudumika + crash stack
set -uo pipefail

BASE="https://github.com/karibuyako/hudumika-platform/releases/latest/download"
APPS=(consumer provider rider)
OUT="${OUT:-/tmp/hudumika-apks}"
mkdir -p "$OUT"

if [[ "${1:-}" == "--logs" ]]; then
  echo "==> Following logcat (Ctrl+C to stop). Reproduce the crash, then paste the output."
  adb logcat -c
  adb logcat '*:E' | grep -iE "hudumika|expo|reactnative|hermes|fatal|AndroidRuntime" || adb logcat '*:E'
  exit 0
fi

adb start-server >/dev/null 2>&1
echo "==> Devices:"
adb devices
if ! adb devices | grep -q $'\tdevice$'; then
  echo "ERROR: no phone in 'device' state. Check USB debugging + RSA prompt on the phone."
  exit 1
fi

for app in "${APPS[@]}"; do
  apk="$OUT/hudumika-$app.apk"
  if [[ ! -f "$apk" ]]; then
    echo "==> Downloading hudumika-$app.apk ..."
    curl -sSL -o "$apk" "$BASE/hudumika-$app.apk"
  fi
  echo "==> Installing hudumika-$app.apk ..."
  adb install -r "$apk"
done

echo "==> Done. Launch each app from the phone and follow docs/USB-TESTING.md"
