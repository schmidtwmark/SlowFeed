#!/usr/bin/env bash
#
# Build the macOS Slowfeed app in Release and install it into /Applications,
# overwriting any previous copy in place. Because the Dock pins an app by
# path, re-running this keeps the pinned Dock icon pointing at the freshly
# built version — no need to re-pin.
#
# Usage:
#   ./scripts/install-macos.sh
#
# Then (first time only): launch /Applications/slowfeed-client.app, right-click
# its Dock icon → Options → Keep in Dock.

set -euo pipefail

PROJECT="slowfeed-client/slowfeed-client.xcodeproj"
SCHEME="slowfeed-client"
CONFIG="Release"
APP_NAME="slowfeed-client.app"
DEST="/Applications/${APP_NAME}"

cd "$(dirname "$0")/.."

echo "▸ Building ${SCHEME} (${CONFIG}) for macOS…"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination 'platform=macOS' \
  build \
  >/tmp/slowfeed-install-build.log 2>&1 \
  || { echo "✗ Build failed. Tail of log:"; tail -40 /tmp/slowfeed-install-build.log; exit 1; }

# Resolve the built .app location from the build settings (robust against
# DerivedData path hashing).
BUILT_DIR=$(xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination 'platform=macOS' \
  -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')

SRC="${BUILT_DIR}/${APP_NAME}"
if [[ ! -d "$SRC" ]]; then
  echo "✗ Could not find built app at: $SRC"
  exit 1
fi

# Quit the app if it's running, otherwise replacing the bundle can fail or
# leave a half-updated copy.
if pgrep -x "$SCHEME" >/dev/null 2>&1; then
  echo "▸ Quitting running instance…"
  osascript -e 'quit app "Slowfeed"' 2>/dev/null || pkill -x "$SCHEME" || true
  sleep 1
fi

echo "▸ Installing to ${DEST}…"
rm -rf "$DEST"
# ditto preserves code signature + bundle structure (cp -R can mangle it).
ditto "$SRC" "$DEST"

echo "✓ Installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null || echo '') → ${DEST}"
echo "  Launch it once, then right-click the Dock icon → Options → Keep in Dock."
