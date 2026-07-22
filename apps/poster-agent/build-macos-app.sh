#!/bin/bash
# Build "Motherlink Agent.app" — a double-clickable macOS app that launches the
# control panel with NO terminal window and a proper icon. Keep it on the Desktop
# or drag it to Applications.
#
# Uses only macOS built-ins (sips, iconutil) — no dependencies. Re-run this if you
# move the repo (the app stores the repo's absolute path).
set -e

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$AGENT_DIR/Motherlink Agent.app"
CONTENTS="$APP/Contents"

echo "Building: $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# --- Icon: appicon-1024.png -> AppIcon.icns via an iconset ---
if [ -f "$AGENT_DIR/appicon-1024.png" ]; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for pair in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
              "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
              "512 512x512" "1024 512x512@2x"; do
    set -- $pair
    sips -z "$1" "$1" "$AGENT_DIR/appicon-1024.png" --out "$ICONSET/icon_$2.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET")"
  echo "  icon built."
else
  echo "  (no appicon-1024.png — building without a custom icon)"
fi

# --- Info.plist ---
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Motherlink Agent</string>
  <key>CFBundleDisplayName</key><string>Motherlink Agent</string>
  <key>CFBundleIdentifier</key><string>io.motherlink.engage.agent</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# --- Executable: finds node, then runs the supervisor from the repo ---
cat > "$CONTENTS/MacOS/run" <<RUN
#!/bin/bash
# Launched from Finder with the SYSTEM PATH, which usually lacks a node installed
# under ~/.local, nvm, or homebrew — so locate it explicitly.
AGENT_DIR="$AGENT_DIR"
cd "\$AGENT_DIR" || exit 1

find_node() {
  command -v node 2>/dev/null && return 0
  for c in /opt/homebrew/bin/node /usr/local/bin/node \
           "\$HOME"/.local/node-*/bin/node "\$HOME"/.nvm/versions/node/*/bin/node \
           /opt/pkg/env/active/bin/node; do
    [ -x "\$c" ] && { echo "\$c"; return 0; }
  done
  return 1
}

NODE="\$(find_node | head -1)"
if [ -z "\$NODE" ]; then
  osascript -e 'display alert "Motherlink Agent" message "Could not find Node.js on this Mac. Install Node, then rebuild the app (build-macos-app.sh)."' >/dev/null 2>&1
  exit 1
fi
exec "\$NODE" supervisor.mjs
RUN
chmod +x "$CONTENTS/MacOS/run"

# Refresh Finder's icon cache for this bundle.
touch "$APP"

echo "Done. Double-click 'Motherlink Agent.app', or drag it to your Desktop / Applications."
