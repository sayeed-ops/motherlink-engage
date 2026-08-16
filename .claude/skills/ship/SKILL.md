---
name: ship
description: Document the session and push everything to the right repos. Updates HANDOFF and the subject docs, verifies the build, scans for secrets, then commits and pushes code to BOTH code remotes and docs to the separate private docs repo. Use when the user says ship, push, commit, "push the code", "update the docs", or at the end of a working session. Also use for --docs-only when only documentation changed.
---

# /ship — document, commit, push

This repo has **three git remotes across two repositories** and the docs are a
separate repo that a normal `git push` does not touch. Both facts have caused
real data loss here before. This command exists so neither depends on memory.

Arguments: `--docs-only` (skip the code half) · `--no-verify` (skip build; only
for doc-only changes).

## The layout, which is not obvious

| | Where | Notes |
|---|---|---|
| Code | `origin` with **two pushurls** | Two pushurls on one remote, so a single `git push` sends to both. **Both are PUBLIC** — check `git remote -v`. |
| Docs | `docs/` is **its own repo** | → a separate PRIVATE remote on `main`. The parent repo ignores it; `git -C docs remote -v` names it. **Nothing else backs it up.** |

**Vercel's production branch is `main`.** Pushing the working branch only
produces a PREVIEW deploy, so a ship that stops there has not delivered anything.
**`/ship` always means production** — promoting to `main` is part of this command,
not a separate decision to hand back to the operator (stated 2026-08-16). Step 4b
does it. Never push a failing build: this deploys production directly.

## Steps

Run these in order. Stop and report if any step fails — do not push past a
failure.

### 1. Verify the build (skip only with `--no-verify` or `--docs-only`)

```bash
launchctl unload ~/Library/LaunchAgents/io.motherlink.engage.devserver.plist
sleep 3
cd apps/web && npx tsc --noEmit && npm run build
launchctl load ~/Library/LaunchAgents/io.motherlink.engage.devserver.plist
```

The dev-server LaunchAgent **must** be stopped first — a production build and the
dev server cannot share `.next` and it wedges with no error. **Always reload it
afterwards**, including when the build fails.

Also `node --check` any changed `apps/poster-agent/**/*.mjs`.

### 2. Scan for secrets — the code repos are public

```bash
git status --porcelain
git ls-files | grep -iE '\.env$|vault.*\.html|proxies\.txt'      # must be empty
git diff | grep -inE "api[_-]?key *[=:] *['\"]?[a-z0-9]{16,}|password *[=:]|BEGIN (RSA )?PRIVATE KEY"
```

Verify `.env` and `private/` are still ignored rather than assuming it. **If
anything matches, stop and tell the user** — do not push and then rotate.

### 3. Update the documentation

`docs/` has one document per subject — see `docs/README.md` for the index. Put
findings where someone would look for them, not wherever is convenient:

- **`HANDOFF.md`** — always. Add or extend the dated session entry and update the
  `**Last updated:**` header line. Record what was verified, what was *not*, and
  anything the next person must not rediscover.
- **The subject document** — `WARMUP-LOOP.md`, `WARMUP-FOLLOWING.md`,
  `AGENT.md`, `NEW-REDDIT-PLAN.md`, `MIGRATION.md`. A new warm-up component gets
  its **own** file; do not grow one file to cover several subjects.
- **`REDDIT-DOM.md`** — any new or repaired selector, with the actual markup and
  what it cost to learn.
- **`docs/README.md`** — if a document was added or its purpose changed.

Keep the split with the code repos: **how to run it** is public
(`apps/*/README.md`), **how to operate it safely** is private (`docs/AGENT.md`).

### 4. Commit and push code

Group into a few reviewed commits by concern rather than one dump. End every
message with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

```bash
git add <paths>
git commit -F - <<'MSG'
...
MSG
git push origin "$(git branch --show-current)"
```

### 4b. Promote to production — ALWAYS, not on request

`/ship` already means production. Do not ask, and do not report a preview as a
finished ship.

```bash
git fetch origin main
RM=$(git ls-remote "$(git remote get-url origin)" main | cut -f1)
git merge-base --is-ancestor "$RM" HEAD || echo "DIVERGED — stop and ask"
git log --oneline "$RM"..HEAD          # show what production will gain
git push origin HEAD:main              # both pushurls; triggers the deploy
git branch -f main HEAD                # keep the local ref from drifting
```

Push `HEAD:main` rather than checking `main` out — switching branches churns
`.next` and fights the dev-server LaunchAgent.

**Stop and ask only if the fast-forward check fails.** A diverged `main` needs a
real merge and that is the operator's call.

### 5. Commit and push docs — separately

```bash
cd docs && git add -A && git commit -F - <<'MSG'
...
MSG
git push origin main
```

### 6. Verify both landed, then report

```bash
git rev-parse HEAD
for u in $(git remote get-url --push --all origin); do
  git ls-remote "$u" "$(git branch --show-current)" main    # BOTH refs, BOTH remotes
done
cd docs && git rev-parse HEAD && git ls-remote origin main
```

Compare the SHAs — do not report success from the absence of an error, and check
`main` as well as the working branch or you will report a preview as a
production deploy. Then tell the user: what was committed where, that a
**production** deploy is in flight, anything still unverified, and any action
left on their side.

## Guardrails

- **Never push a failing build.** Vercel deploys from this push.
- **Never `git add -A` in the parent.** Add paths explicitly; it is a public repo.
- Commit or push only when the user asked. `/ship` is that ask.
- If on `main`, branch first — production branch tracking is a Vercel setting and
  changing what `main` points at can move production unintentionally.
