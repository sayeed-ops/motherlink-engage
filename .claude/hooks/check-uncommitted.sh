#!/usr/bin/env bash
# Session-end check: is anything uncommitted in EITHER repo?
#
# There are two, and that is the whole point of this hook. `docs/` is a separate
# git repo with its own private remote — a push from the parent does NOT back it
# up. Documentation has silently gone unbacked-up here before,
# and in 2026-07 Google Drive deleted two never-committed source files off disk.
#
# Always exits 0. This is a reminder, never a blocker.

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$root" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0

count() { git ${2:+-C "$2"} status --porcelain 2>/dev/null | grep -c . || true; }

code=$(count)
docs=$(count x docs)

[ "${code:-0}" -eq 0 ] && [ "${docs:-0}" -eq 0 ] && exit 0

parts=""
[ "${code:-0}" -gt 0 ] && parts="${code} file(s) in the code repo"
if [ "${docs:-0}" -gt 0 ]; then
  [ -n "$parts" ] && parts="${parts}, "
  parts="${parts}${docs} in docs/ (separate private repo — a code push does not back it up)"
fi

if command -v jq >/dev/null 2>&1; then
  jq -n --arg m "$parts" \
    '{systemMessage: ("Uncommitted work: " + $m + ". Run /ship to document, commit and push both.")}'
else
  printf '{"systemMessage":"Uncommitted work in this project. Run /ship to document, commit and push both repos."}\n'
fi
exit 0
