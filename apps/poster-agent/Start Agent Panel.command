#!/bin/bash
# Motherlink Agent — control panel launcher (macOS). Double-click to open the
# panel in your browser. A small Terminal window stays open hosting it — minimise
# it and control the agent from the browser. Close this window to stop everything.
# For a hands-off setup, tick "Start at login" in the panel.

cd "$(dirname "$0")" || exit 1

# When launched from Finder this runs with the SYSTEM PATH, which usually does NOT
# include a node under ~/.local, nvm, or homebrew (those are added by ~/.zshrc,
# which Finder does not source). So locate node explicitly rather than trust PATH.
find_node() {
  command -v node 2>/dev/null && return 0
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME"/.local/node-*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    /opt/pkg/env/active/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node | head -1)"
if [ -z "$NODE" ]; then
  echo "Could not find Node.js."
  echo "Fix: edit this file and set NODE to the full path of your 'node' binary,"
  echo "or add its folder to /etc/paths. In Terminal, 'which node' shows the path."
  echo
  echo "Press Return to close…"
  read -r
  exit 1
fi

echo "Using node: $NODE"
exec "$NODE" supervisor.mjs
