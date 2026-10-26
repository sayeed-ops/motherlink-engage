#!/bin/bash
# Double-click: starts the comment trial page at http://localhost:4700 and opens it.
# Read-only against Engage's database. Close this window (or Ctrl+C) to stop.
cd "$(dirname "$0")/../.."
( sleep 2 && open http://localhost:4700 ) &
exec node --env-file=apps/web/.env.local --experimental-transform-types --no-warnings --import ./tests/unit/register.mjs tools/comment-trial/server.mjs
