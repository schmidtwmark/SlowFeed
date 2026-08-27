#!/usr/bin/env bash
#
# Sync the Chrome extension from the Safari one.
#
# The Safari extension's Resources/ directory is the single source of truth for
# the blocker's logic (rules.js, block.js, block.css, popup.*). The scripts are
# written against MV3 and bind `browser` or `chrome` at runtime, so the same
# files run unmodified in both browsers — this script just copies them into the
# unpacked-extension layout Chrome expects.
#
# Usage:
#   ./scripts/build-chrome-extension.sh          # sync
#   ./scripts/build-chrome-extension.sh --check  # verify in sync, don't write
#
# The output IS committed, so the extension can be loaded without a build step.
# Re-run this after editing anything under SlowfeedBlocker/Resources/.

set -euo pipefail

cd "$(dirname "$0")/.."

SRC="slowfeed-client/SlowfeedBlocker/Resources"
DEST="chrome-extension"
FILES=(manifest.json rules.js block.js block.css popup.html popup.js)

mode="${1:-sync}"

if [[ "$mode" == "--check" ]]; then
  drift=0
  for f in "${FILES[@]}"; do
    if ! diff -q "$SRC/$f" "$DEST/$f" >/dev/null 2>&1; then
      echo "✗ out of sync: $f"
      drift=1
    fi
  done
  if [[ $drift -eq 0 ]]; then
    echo "✓ chrome-extension/ is in sync with $SRC"
  else
    echo "Run ./scripts/build-chrome-extension.sh to update."
    exit 1
  fi
  exit 0
fi

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$f"
  echo "  synced $f"
done
echo "✓ chrome-extension/ updated from $SRC"
echo "  Load it: chrome://extensions → Developer mode → Load unpacked → chrome-extension/"
