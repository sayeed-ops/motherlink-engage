# Motherlink Engage — Handoff

> Living document. Updated at the end of every working session. Read this first
> when resuming. For the "why", see [OVERVIEW.md](./OVERVIEW.md).

**Last updated:** 2026-07-29 (**new-reddit posting LIVE** — humanized approach flow, approach plans + execution traces stored and shown; see the 07-28/29 session log and [NEW-REDDIT-PLAN.md](./NEW-REDDIT-PLAN.md))
**Repo:** github.com/sayeed-ops/motherlink-engage (private)
**Firebase:** motherlink-engage (Spark plan)
**Deploy target:** Vercel (not yet deployed; local dev only so far)
**Local dev:** `cd apps/web && npm run dev` → http://localhost:3010
**Poster agent:** run the **local control panel** — build once with `apps/poster-agent/build-macos-app.sh`, then double-click **Motherlink Agent.app** (or `npm run panel`, or `Start Agent Panel.command`). It runs the agent as a child with Start/Stop/logs. Bare terminal way still works: `cd apps/poster-agent && npm start`. **Dry-run is toggled from the Accounts page** (Firestore `agents/control`, re-read every poll); `.env` `DRY_RUN` is only the seeded default.
**Posting surface:** **new reddit (`www.reddit.com`) is now the default and is live-verified.** `POST_SURFACE=new` in `.env`, live-switchable via `agents/control.postSurface`. old.reddit remains untouched as instant rollback (`old`). A job now takes **~4–6 minutes** because it browses like a person before replying — see the approach flow below.
**Migration:** applied — ML Studio's 4 projects live in Engage (see [MIGRATION.md](./MIGRATION.md))
**ML Studio still live & authoritative:** motherlink-studio-v2.vercel.app (publishing not yet cut over)

### ⚠️ Branch & commit state (read before touching git)
- **UNCOMMITTED WORK (2026-07-29):** the entire new-reddit posting move + approach
  plans/traces is **working and live-verified but NOT yet committed**. Changed:
  `apps/poster-agent/{index,agent-core}.mjs`, `apps/poster-agent/reddit/*` (three
  files new: `browse.mjs`, `plan.mjs`, plus `helpers/executor/actions/comment-new`),
  `apps/web/src/modules/reddit/approach.ts` (new),
  `apps/web/src/components/ApproachPlanView.tsx` (new),
  `apps/web/src/server/{jobs,accountActivity}.ts`,
  `apps/web/src/components/AccountDashboard.tsx`,
  `apps/web/src/app/(app)/projects/[projectId]/reddit/page.tsx`, `docs/*`.
  Web build + typecheck clean; lint unchanged (the 2 pre-existing
  `react-hooks/set-state-in-effect` issues in `reddit/page.tsx` are NOT ours —
  13 exist across 8 files repo-wide). **No `firestore.rules` change needed** —
  jobs are already member-readable whole-doc and server-written.
- Working branch: **`access-roles-and-warmup-designer`** — 7 commits ahead of `main`, committed & pushed; the per-account Dashboard + in-session stats self-report is the newest commit (see the 07-22 "account dashboard" session log). **PR to `main` opened — [#4](https://github.com/sayeed-ops/motherlink-engage/pull/4)** (user manages merges). `firestore.rules` changed earlier → **still needs `firebase deploy --only firestore:rules`** before the statSnapshots subcollection reads work in production (the agent writes them via Admin SDK regardless; only the dashboard sparkline read needs the rule).
- **All on the branch (in order):** design-system/branding refresh · access management (user archive + hard-delete, custom roles, granular permissions, people picker) · warm-up designer · draft editing + edit-reason training capture · local agent control panel + macOS app (`supervisor.mjs`, `build-macos-app.sh`, launchers) with `AgentControls` (status + dry-run, Accounts only).
- A short-lived remote agent on/off switch was built then **removed** same day (superseded by the control panel + dry-run) — don't re-add it.
- Next git action when ready: **open a PR to `main`** (user manages merges). Nothing pending to commit.

---

## Migration phase tracker

| Phase | State |
|---|---|
| 00 Preserve + audit | ✅ done |
| 01 Decisions | ✅ done |
| 02 Standalone shell (auth, tenancy, permissions) | ✅ done |
| 03 Port Reddit review tool | ✅ done — review workflow, lifecycle/danger zone, bulk import, search feedback, activity viewer, accounts, publish enqueue, **and the local posting agent (posts for real on new reddit, verified live 2026-07-29)** |
| 04 Migration dry-run into staging | ✅ done — dry-run + applied into Engage; parity verified (buckets identical) |
| 05 Side-by-side parallel run | 🟡 in progress — **two real comments posted through Engage on 2026-07-29** (r/budget, r/personalfinance). Dry-run toggle still available per-run from the Accounts page. |
| 06 UAT | ⬜ |
| 07 Cutover (move publishing) | ⬜ |
| 08 Soak | ⬜ |
| 09 (dropped — ML Studio is being kept) | — |

---

## What exists and is verified

**Foundation (phase 02 — done)**
- Firebase project, Firestore, Google + Email/Password auth providers.
- Security rules: default-deny, per-project membership, `allow write: if false`
  on client data. **40/40 isolation tests pass** (`tests/rules.test.mjs`),
  deployed.
- Server tier: `src/server/admin.ts` (Admin SDK, `server-only`), `auth.ts`
  (token verification + permission gates), `route.ts` (`withAuth` wrapper).
- User admin: provision by email, roles, revoke (kills live sessions).
  **13/13 security tests** (`tools/e2e-users.mjs`).
- App shell on the real Motherlink design system (copied byte-identical from ML
  Studio), light mode default.
- Profile editing, `lastLoginAt` stamped server-side.

**Reddit module (phase 03 — partial)**
- Lib copied byte-identical: `prompts.ts`, `redditFetch.ts`, `throttle.ts`,
  `import-prompts.ts`, `types.ts`, `redditClient.ts`.
- `deepseek.ts`, `rss.ts`, `store.ts` — shared clients + server persistence.
- Routes (all authenticated, permission-gated): config, fetch, analyze, draft,
  items, sources.
- UI at `/projects/:id/reddit`: Opportunities, Knowledge, Settings tabs.
- **Full pipeline verified e2e against real Reddit + DeepSeek**
  (`tools/e2e-reddit-pipeline.mjs`): configure → fetch → analyze → draft, with
  the growth invariant and forged-analysis rejection confirmed.

**Posting on new reddit + humanized approach (2026-07-28/29 — LIVE)**
- **Two real comments posted** through Engage on new reddit, first attempt each:
  r/budget `…/comment/p0fl386/` and r/personalfinance `…/comment/p0fna8z/`.
- The account no longer teleports to a thread. Every reply runs an **approach
  plan** — a JSON itinerary composed at enqueue time, walked by a shared executor:
  `open_home → search_subreddit → scroll_feed → find_target → read_post →
  [skim_comments] → [upvote_post] → [upvote_comment] → post_comment`.
- **Layered so warm-up gets it free (Phase 4):** Layer A vocabulary/composer
  (`apps/web/src/modules/reddit/approach.ts`), Layer B interaction primitives
  (`apps/poster-agent/reddit/{browse,comment-new,helpers}.mjs`), Layer C executor
  (`reddit/executor.mjs` — per-step timeout, human gaps, graceful abort, trace),
  Layer D thin flows. A warm-up plan is a different itinerary over the SAME
  primitives.
- **Plan + trace are stored on the job forever** (`approachPlan`, `approachTrace`)
  and rendered read-only in two places: Opportunities (queued/posted/failed) and
  **Account Dashboard → Activity → Recent**. Plan = intent, trace = what actually
  happened (which search route landed, browsed vs direct, comments read of how
  many, votes skipped as already-upvoted, characters typed).
- Verified end-to-end: a plan generated by the **web app** executed **verbatim** by
  the agent, actual 262s against a 268s estimate.

**Tooling (`tools/`)**
- `provision-user.mjs` — bootstrap/admin CLI (no public seed route).
- `backup.mjs` — read-only production backup (managed export unavailable on
  Spark). First backup: 1,708 docs, no unknown collections.
- `count-docs.mjs`, `census.mjs` — production data census.
- `verify-admin.mjs` — server-tier connectivity check.
- e2e suites above.

---

## Reddit feature parity — the gap

Engage has the fetch → analyse → draft spine. ML Studio's tool has more.
**NOT YET PORTED:**

- [x] **Accounts** — posting identities, AdsPower profile ids, daily caps, min
      intervals, status (active/warming/flagged/banned), and the rate gate
      (`accountPostGate`). `/accounts` page (live client-SDK reads), CRUD routes
      gated on the global `accounts.manage`, and the gate as a pure client+server
      function. Identity + rails only — no posting.
- [x] **Post queue + agent status chip** — enqueue built (Publish → pick account
      → `POST reddit/jobs`, `drafts.publish`, server gate re-check, no
      double-queue, live status). The **local agent** in
      [apps/poster-agent/](../apps/poster-agent/) drains `jobs/`, heartbeats to
      `agents/agent`, writes back to nested `projects/{id}/…`, advances counters.
      **Verified live in DRY_RUN on the posting Mac** (2026-07-17), then **POSTING
      FOR REAL on new reddit (2026-07-29)** — two comments out, each on the first
      attempt, through the full humanized approach flow. The old desktop menubar
      app is ML Studio's and won't work against Engage — run this agent (or
      re-wrap it later).
- [x] **Favourites** — star toggle on each card; `isFavorite` is a
      purge-retention flag. Server route `PATCH .../reddit/items`.
- [x] **NEW badges** (localStorage lastSeen, per project) and **ANSWERED badges**
      (derived live from posted drafts).
- [x] **Purge / clean history / delete project** with scoped-purge retention.
      Auto-purge runs once at the end of a fetch cycle (`POST reddit/purge`,
      scoped to the subreddits that returned posts); clean history and delete
      live in the project-page **Danger zone** (type-to-confirm), gated on
      `project.settings`. Retention proven: favourites + answered survive purge,
      posted drafts survive clean, delete removes the whole subtree.
- [x] **Mark posted**, **re-analyse**, **skip/archive item** (→ Archived tab,
      reversible), **draft reject + reviewer notes**. Item mutations gated on
      `items.analyze`, draft mutations on `drafts.generate`.
- [x] **Bulk JSON import** + **"Copy AI prompt"** — wired `import-prompts.ts` on
      the Settings page (config: paste-to-fill + copy prompt) and the Knowledge
      page (sources: paste array/object → one POST per row, created/failed tally,
      + copy prompt with the client's context baked in).
- [x] **Search feedback card** (hitsBySubreddit + query echo) on Opportunities,
      accumulated across the per-subreddit search loop. (Plain fetch still shows
      the one-line "N new · M cleared" summary.)
- [x] **Activity logs** — server-side **write** helper (`src/server/activityLog.ts`)
      wired to clean-history + delete-project (WARNING). **Viewer** at `/activity`
      (admin-only nav; live client-SDK reads): a platform admin sees everything,
      any user sees their own. As more consequential actions start logging, they
      appear here automatically.
- [x] **Project danger zone** UI (project page: clear Reddit history + delete
      project).

Rough estimate: the spine is ~60% of the tool by feature count, less by value
(the spine is the hard part). Do NOT call this "done" until the list clears.

---

## Known issues / decisions

- **READ LATENCY — FIXED (2026-07-16).** Was: every read proxied browser → our
  server → Firestore, ~1.1–1.4s, no cache. Now:
  - **Hot reads go direct from the browser** via the client SDK (`lib/data.ts`,
    `lib/useProjects.ts`) with `onSnapshot` — local IndexedDB cache, live
    updates, one hop. Opportunities/items/analyses/drafts/sources/config/members
    and the projects list all read this way. Same model as ML Studio.
  - **`checkRevoked` dropped** in `verifyIdToken`: 496ms → 1ms per request. Safe
    because disabling a user also disables the Auth user + revokes tokens, and
    we still re-check `status === 'disabled'` on the profile.
  - **Server caches profile + membership** (30s TTL, `invalidateCaller()` on any
    access change so revocation/permission changes are immediate). Repeat
    server calls dropped ~1,100ms → ~300ms.
  - Reads stay enforced by rules (proven: 44/44). Writes stay server-only.
  - New rule: collection-group read on `members` scoped to `resource.data.uid ==
    auth.uid`, so the client can list its own memberships. Deployed.
  - NOTE: raw latency from a dev machine to Firestore (nam5) is ~250ms+; the
    client SDK cache hides it after first load. Production (Vercel, US) is
    faster and the cache still applies.
- **Stranded `posting` jobs — FIXED (2026-07-20).** A stopped agent used to leave
  a job in `posting` forever (which also blocked re-publishing the draft). The
  agent now clears any `posting` job older than `STALE_POSTING_MS` (default 10m)
  to **failed** — deliberately NOT re-queued, since the comment may have posted
  before the stop; auto-requeue would double-post. It surfaces in the UI for the
  operator to check Reddit and **Post again**. See `reclaimStalePosting` in
  `apps/poster-agent/agent-core.mjs`.
- **Remaining agent defects to fix AFTER parity:** username check skippable when
  `expectedUsername` empty; `deleteProjectCascade` leaves jobs behind; rate gate
  implemented three times. Documented in the migration brief.
- **Reddit fetch 429 — FIXED (2026-07-18).** The `ProxyAgent` in
  `apps/web/src/modules/reddit/redditFetch.ts` was memoized, so undici keep-alive
  pinned ~2 IPRoyal exit IPs; a multi-subreddit sweep hammered Reddit from those
  2 IPs and tripped per-IP 429. Now a fresh `ProxyAgent` is built per request AND
  per retry (new exit IP each time), closed after the body is read. Verified 8/8
  subreddits → 200. Do NOT re-memoize it (comment in the file says so).
- **Desktop "Motherlink Poster" app is ML Studio's — NOT this repo, and inert for
  Engage.** It's a separate Electron app built for ML Studio's flat schema
  (`reddit_post_jobs`…), so with the Engage key loaded it still can't see Engage's
  nested queue — which is why the Accounts chip stayed offline when only it ran.
  Engage posting = the CLI agent (`apps/poster-agent`) + the Accounts-page
  dry-run toggle. Its "Dry run" checkbox does nothing for Engage. Quit it unless
  you're still running ML Studio in parallel.
- **Distributed / VPS topology (how it scales to a team).** Two planes: the
  **web app** (control plane — used from any computer by any member; Publish
  writes a fully-denormalised job carrying the `adsPowerProfileId`, thread, body;
  the dry-run toggle is global) and **one agent next to AdsPower** (execution
  plane — drains the queue, opens the profile the job names, posts). The agent
  MUST run wherever AdsPower runs (it connects to a browser WS endpoint AdsPower
  exposes on `127.0.0.1`), so on a VPS the agent runs on the VPS; members' laptops
  only enqueue. Still exactly ONE agent (rate rails are per-poller). Each profile
  keeps its own sticky IP via AdsPower, so the VPS IP never leaks. The VPS needs a
  GUI session (AdsPower runs real, non-headless browsers).
- **IPRoyal:** read proxy and sticky posting proxies share one sub-user, so
  rotating the exposed credential would break all AdsPower profiles. Deferred;
  create an `app-read` sub-user before side-by-side. Engage currently borrows ML
  Studio's `REDDIT_PROXY_URL` for local dev.
- **Resend** still uses the sandbox sender; email is off by default anyway.
- **Posting drives NEW reddit (`www.reddit.com`) — SUPERSEDED 2026-07-29.** This
  entry used to say old.reddit was the design choice with new reddit as a possible
  fallback. That reversed: the operator wanted the account's **entire footprint**
  (browse, warm-up, posting) to live on one surface so behaviour is consistent — a
  casual-user persona, not an old.reddit power user. New reddit is now the default
  and is live-verified.
  - `POST_SURFACE` (env default + `agents/control.postSurface`, re-read every
    poll) switches `old | new` with zero code change. **old.reddit's
    `postComment()` is untouched and remains the instant rollback.**
  - It cost more than the ~1 day budgeted here, almost entirely in DOM
    archaeology — see the Validation log in
    [NEW-REDDIT-PLAN.md](./NEW-REDDIT-PLAN.md), which records every selector that
    was wrong and why. The upkeep warning below still stands: Shreddit's
    obfuscated markup WILL drift. All fragile selectors are deliberately confined
    to `apps/poster-agent/reddit/{comment-new,browse}.mjs` so repairs stay cheap
    and local.
  - The composer turned out to be a **Lexical rich editor** (`div[contenteditable]
    [data-lexical-editor]`, light DOM) that only exists after clicking a
    **collapsed `<textarea>` living in an open shadow root**. Success is confirmed
    from the create-comment network response, as planned.

## Secrets & credentials (locations only — never commit)

- `~/.config/motherlink-engage/admin.json` — Engage Admin SDK key.
- `~/.config/motherlink-engage/migration-reader.json` — read-only key on
  motherlink-studio (Cloud Datastore Viewer).
- `apps/web/.env.local` — Firebase client config + DEEPSEEK_API_KEY +
  REDDIT_PROXY_URL (borrowed from ML Studio for now). Gitignored.
- Compromised key `f86bfb0b` was revoked. IPRoyal password is exposed in an
  earlier session transcript — rotate via new sub-user, don't rotate in place.

## How to verify everything still works

```
cd apps/web && npm run build          # typecheck + build
cd tests && npm test                  # 51/51 rules isolation (incl. activity_logs + jobs list queries)
cd tools && node e2e-users.mjs        # 17/17 user security (needs dev server up)
cd tools && node e2e-reddit-pipeline.mjs   # full pipeline (needs dev server up)
cd tools && node e2e-reddit-curation.mjs   # favourite/skip/reject/mark-posted (dev server up; no DeepSeek spend)
cd tools && node e2e-reddit-lifecycle.mjs  # scoped purge / clean / delete on a throwaway project (dev server up)
cd tools && node e2e-reddit-import.mjs     # bulk source import tally is honest (throwaway project; dev server up)
cd tools && node e2e-reddit-accounts.mjs   # account CRUD + validation + counter defaults (dev server up)
cd tools && node e2e-reddit-publish.mjs    # enqueue: gate re-check + dedupe + denormalised job (dev server up)
cd tools && node e2e-poster-agent.mjs      # agent Firestore wiring (heartbeat/rails/write-back) — no browser needed
cd apps/web && npm run lint           # 13 PRE-EXISTING react-hooks errors across 8 files — none are new work
```

**Verifying the new-reddit posting path** needs the posting Mac with AdsPower
running — there is no headless substitute, and the selectors only exist on a real
logged-in thread. Do it in this order:

1. Turn **dry-run ON** from the Accounts page, queue one reply, watch the agent
   panel. A green run logs the plan, each step, then
   `composer: box holds N/N chars (exact match)` and stops before submitting.
2. Read the log for the approach itself — the step names and their outcomes are
   the test. `find_target: not found … navigating directly` is normal, not a bug.
3. Only then flip dry-run OFF for one live reply on a warming account.
4. Check the plan + trace render on the Account Dashboard afterwards.

To drive the browser directly while debugging, get the endpoint from AdsPower's
local API — `curl http://local.adspower.net:50325/api/v1/browser/local-active`
returns `data.list[].ws.puppeteer` for any already-open profile, which you can
`puppeteer.connect()` to without disturbing the agent's own session.

---

## Session log

### 2026-07-28/29 — NEW-REDDIT POSTING LIVE + humanized approach flow + approach plans/traces

The big one. Posting moved from old.reddit to new reddit, and the account stopped
teleporting to threads: it now browses like a person before it replies. Two real
comments went out. **Design doc + full DOM archaeology:
[NEW-REDDIT-PLAN.md](./NEW-REDDIT-PLAN.md) — read its Validation log before
touching any selector.**

**Why new reddit at all.** Not because old.reddit broke — it still works and is
still the rollback. The operator wanted the account's **entire footprint**
(browsing, warm-up, posting) on one surface so behaviour is consistent: a casual
user, not an old.reddit power user. `POST_SURFACE=old|new` flips it live.

**The approach flow.** Composed per reply, different every time:
```
open_home → search_subreddit → scroll_feed → find_target → read_post
          → [skim_comments ~65%] → [upvote_post ~20%] → [upvote_comment ~20%] → post_comment
```
- Always starts on the **home feed** and reaches the subreddit **through search**.
  Three routes, rolled per plan: `typeahead` (click the community out of the
  suggestions), `communities` (search → Communities tab), `posts` (spot it in the
  results). If the rolled route misses it falls through the other two, then to a
  direct visit — a small sub surfaces in some places and not others.
- `find_target` scrolls the feed hunting the card by exact id (`t3_<postId>`),
  bounded by BOTH a scroll count and a 120s clock, then falls back to opening the
  thread directly. **The fallback is the normal case, not a failure** — queued
  drafts are often days old.
- `skim_comments` reads a plan-rolled **1–13 comments** (clamped to what exists),
  walking comment to comment rather than scrolling blind.
- Upvotes only ever add a vote that isn't there (`aria-pressed` checked first) and
  only pick an **already well-upvoted** comment. They never fail a job.

**Pacing — one knob.** `HUMAN_PAUSE_MAX_SEC` (default 13) drives every "how long
before the next thing" pause. The draw is **skewed, not uniform**: 55% under 15% of
max, 30% middle, 15% up to full. A flat 0–13 made the typical pause ~6.5s across
~21 pause sites — 2¼ minutes of pure waiting, and "always about six seconds" is its
own tell. Mean is now 3.14s, median 1.8s. A job runs **~4–6 min**.

**Approach plans (Phase 3).** `apps/web/src/modules/reddit/approach.ts` is the
**source of truth** — pure and side-effect free like `warmup.ts`, so it runs
server-side at enqueue and in the browser for display. `enqueuePostJob()` freezes
the plan onto the job. **Every random decision is resolved at composition time**
(route, sort, bursts, hunt budget, reading seconds, comment count, which optional
steps and in what order, every gap), so the stored plan is the whole story and the
display needs no runtime guesswork. The agent's `reddit/plan.mjs` is now only the
FALLBACK for jobs queued before this existed.

**Execution traces.** The plan says intent; the agent writes back `approachTrace`
saying what happened — on success AND failure (the trace rides on the thrown error
so a failed job records how far it got). This matters because intent and reality
diverge normally: a route misses and recovers, a post isn't in the feed, a vote is
already in place. Rendered as a timeline with per-action icons, status rings
(✓ done / − skipped / ✕ failed), real elapsed times, and `may change` chips on the
steps reality can overrule (chips disappear once it has run).

**Where to look:** Opportunities (queued/posting/posted/failed) and **Account
Dashboard → Activity through the tool → Recent**. The Dashboard is the real home —
a posted draft leaves the review queue.

**DOM facts that cost the most to learn** (all verified live; full detail in the
plan doc):
- The thread page carries **TWO** "Join the conversation" textareas — a 0×0 decoy
  and the real one under `comment-composer-host`. A first-match deep query returns
  the decoy, whose `boundingBox()` is null, which wedged the composer for a whole
  session. **`deepQueryHandle` is now visibility-filtered by default.**
- Measure geometry **in-page via `getBoundingClientRect()`**, never Puppeteer's
  `boundingBox()` — CDP's box model returns null for slotted/shadow-hosted nodes.
- Focus checks must **pierce shadow roots**; `document.activeElement` only reports
  the shadow host.
- While collapsed, `shreddit-composer`, the editor and the submit button all
  measure 0×0. Clicking the collapsed textarea expands them and drops the caret in.
- The feed is **virtualized** — check for the target after every scroll burst.
  Reddit also renders many screens ahead, so "in the DOM" ≠ "scrolled to".
- Vote buttons: post → `shreddit-post` shadow root; comment →
  `shreddit-comment-action-row` shadow root (**lazy** — the comment must be on
  screen first). `aria-pressed` is the vote state.
- Logged-in handle IS cheaply readable: `after-login-toast-dispatcher[username]`
  (also `achievements-entrypoint`, `community-author-flair`). Closed the deferred
  wrong-account check.
- **Never scroll a thread to the true page bottom** — Reddit leaves ~220px of empty
  footer and parking there is a tell. `readableScrollLimit()` + `maxY` bounds fix
  it. **Do NOT apply to feeds** — infinite scroll needs to reach the bottom to load.
- **Puppeteer does NOT auto-dismiss dialogs** (`CdpPage.#onDialog` only emits), so
  an unhandled `beforeunload` would wedge a tab forever. `autoHandleDialogs()` is
  registered on every page. Note: the dialog could NOT be reproduced from
  automation across five navigation methods — it affects a human driving the
  AdsPower window, not the agent.

**Other changes:** `STEP_TIMEOUT_MS` 150s→300s (typing ~1000 chars takes ~100s);
`STALE_POSTING_MS` 10m→20m (a humanized job legitimately runs 4–7 min, and
reclaiming a live job would mark a real post failed); dry runs now **clear the
composer** so the tab is handed back clean (Reddit persists drafts — runs used to
log "clearing N leftover chars"); comment text is verified **letter-perfect** before
submit, with a CDP `Input.insertText` repair pass, and a still-mismatched box
hard-aborts rather than posting corrupted text.

**Where things live**

| File | What |
|---|---|
| `apps/web/src/modules/reddit/approach.ts` | **Source of truth** — vocabulary, `composeApproachPlan()`, display + trace helpers. Pure, runs both sides. |
| `apps/web/src/components/ApproachPlanView.tsx` | The read-only timeline (icons, status rings, `may change` chips) |
| `apps/web/src/server/jobs.ts` | Composes + freezes `approachPlan` at enqueue |
| `apps/web/src/server/accountActivity.ts` | Carries plan/trace to the Dashboard (only for the ~15 in `recent`) |
| `apps/poster-agent/reddit/browse.mjs` | Layer B browse primitives — **all fragile feed/search/vote selectors** |
| `apps/poster-agent/reddit/comment-new.mjs` | Layer B composer + submit — **all fragile composer selectors** |
| `apps/poster-agent/reddit/helpers.mjs` | Shared low-level: deep query, human click/scroll/type, pause, dialogs |
| `apps/poster-agent/reddit/executor.mjs` | Layer C `runPlan` — timeouts, gaps, graceful abort, trace |
| `apps/poster-agent/reddit/actions.mjs` | action type → primitive registry |
| `apps/poster-agent/reddit/plan.mjs` | FALLBACK composer only (jobs with no stored plan) |

**Knobs** (all `apps/poster-agent/.env`, documented in `.env.example`):
`POST_SURFACE=new|old` · `HUMAN_PAUSE_MAX_SEC=13` · `STEP_TIMEOUT_MS=300000` ·
`STALE_POSTING_MS=1200000` · `DRY_RUN` (seed only — the Accounts page toggle wins).

**New job-document fields:** `approachPlan` (written by the web app at enqueue),
`approachTrace` (written by the agent on success or failure). Both optional —
every reader is defensive, so pre-existing jobs render fine.

**Next:** Phase 4 — warm-up execution, reusing Layer B/C as-is.

### 2026-07-22 (cont.) — per-account Dashboard + in-session stats self-report

Each account now has its own page (`/accounts/[accountId]`) with **Dashboard** and
**Settings** tabs; the grid became the roster + create surface, cards link in.
Warm-up keeps its own page, linked from the detail header.

The design decision that shaped it: **do NOT crawl the 50 accounts from the
rotating read proxy** — a central crawler on a cadence manufactures the exact
"these accounts move together" correlation Reddit would need. Instead the accounts
**self-report**: the poster agent, already logged in as the account in its own
AdsPower profile on its own sticky IP, reads that account's own stats **in-session**.
**No API/fetch/`.json`** — the agent navigates to the account's own profile page
(a page real users visit), dwells, and reads karma + cake day straight from the
rendered sidebar DOM ("copy the text, keep the important part"). There is no
request the human UI wouldn't also make, so nothing anomalous to flag. Split:
- **Reddit-side truth (captured in-session, the only part that needs the agent):**
  link/comment/total karma + Reddit account age, from the profile sidebar DOM.
  Subscriptions are NOT on the sidebar, so this path leaves them unset (-1);
  capturing them would need a second navigation to the My Subreddits page — TBD.
  `AccountStats` in `types.ts`.
- **Our own activity (never scraped — we generated it):** posts made via the tool,
  subreddit, success/fail, permalinks, dates — aggregated from `jobs` in
  `server/accountActivity.ts` (`GET /api/accounts/[id]/activity`).

- **Data model.** `accounts/{id}` gains `stats` (latest), `statsBaseline` (frozen
  first capture — the "is it improving since we took it on" anchor;
  `createdAt` = registered-here date), `statsRefreshRequestedAt`, `redditCreatedUtc`.
  New append-only `accounts/{id}/statSnapshots/{id}` drives the karma sparkline.
  `firestore.rules`: signed-in read on the subcollection, client writes denied
  (**deploy needed**).
- **Agent.** `captureAccountStats()` in `index.mjs` navigates to
  `old.reddit.com/user/{username}/`, dwells + scrolls a little (human), and reads
  karma + cake day from the sidebar via `page.evaluate` DOM text parsing (regex on
  `.side` innerText, `<time datetime>` for age) — **no fetch/JSON**.
  `store.writeAccountStats()` in `agent-core.mjs` writes latest, seeds baseline
  once, appends a snapshot, clears the refresh flag. Gated by `shouldCaptureStats()`
  so the profile visit is **occasional, not every post**: only on first-ever
  capture, when stale (`STATS_MAX_AGE_MS`, default 3d), or when the "Update data"
  button set the flag. Runs **before** CLOSE_AFTER and **even in dry-run**
  (read-only). Best-effort: any failure is swallowed so it can never affect posting.
- **"Update data" button** (`POST /api/accounts/[id]/refresh-stats`, gated
  `accounts.manage`) sets `statsRefreshRequestedAt` — it does NOT dispatch a
  crawler; the flag is honoured opportunistically next session. UI says so.
- **UI.** `AccountForm.tsx` (shared create/edit), `AccountDashboard.tsx` (KPI tiles
  with Δ-since-baseline, inline-SVG karma sparkline, our-activity summary),
  `/accounts/[accountId]/page.tsx` (tabs). Grid cards show captured karma when
  present (`123 karma`) else manual (`0 karma*`). **No subscriptions tile** (the
  no-fetch profile path can't read it).
- **Dry-run switch now in the sidebar.** `SidebarAgentControl.tsx` (compact:
  online/queued dot + a Dry run ↔ LIVE toggle) added to `AppShell` above the
  footer, shown only to account managers. Same `agents/control.dryRun` state as the
  Accounts-page `AgentControls` chip (both subscribe to the same doc, stay in
  sync) — so the kill switch is one click from any page, not just Accounts.
- **In-app comment reader (NOT a Reddit link).** Recent posts used to link out to
  the live comment permalink — but a reviewer repeatedly landing on one set of
  accounts' comments from their own browser/IP is its own correlation tell. So
  "Read" now opens an **in-app panel** showing our OWN saved copies: the original
  post, our analysis, and the comment — no reddit.com pageview at all. The
  permalink is shown as plain non-clickable text with a note to act on it from the
  account's own AdsPower browser, not the dashboard's. `server/accountPosts.ts`
  (`getAccountPostContext`: job → draft → item+analysis) + `GET
  /api/accounts/[id]/posts/[jobId]`.
- **Verified:** `npm run build` + `tsc` clean; eslint clean on all NEW files;
  `node --check` on both agent files. **NOT run:** live click-through (needs auth);
  the profile-sidebar DOM parse against real old.reddit (the karma/`<time>` selectors
  are coded to old.reddit's known markup but unverified live — test on the Mac in
  DRY_RUN first, it captures there too, and check a `statSnapshots` doc lands with
  sane karma); no e2e harness yet for the new routes / `writeAccountStats`.

### 2026-07-22 (cont.) — local agent control panel (no terminal)

The web on/off can't cold-start a dead process after reboot; the user wanted a
non-terminal way to launch/stop the agent, cross-platform (not mac auto-launch).
Built a zero-dependency **local control panel** that supervises the agent.

- **`apps/poster-agent/supervisor.mjs`** (pure Node http + child_process, no deps):
  runs `index.mjs` as a child, serves a self-contained browser panel at
  **127.0.0.1:4599** (bind localhost-only, reads no secrets). Start / Stop /
  Restart, live logs via SSE, crash auto-restart with backoff + crash-loop bailout
  (5 rapid crashes → give up), and **Start at login** (best-effort per-OS: macOS
  LaunchAgent plist + launchctl, Linux ~/.config/autostart .desktop, Windows HKCU
  Run key). Opening the panel auto-starts the agent (`PANEL_NO_AUTOSTART=1` to
  disable). Tries to open the browser on launch.
- **Launchers:** `Start Agent Panel.command` (macOS, chmod +x) / `.bat` (Windows),
  plus `npm run panel`. The `.command` opens a Terminal that hosts the panel
  (minimise it) — for truly terminal-free across reboots, use Start at login.
- **Separation:** panel = local PROCESS control; the web app's Turn on/off +
  Dry run = REMOTE pause/resume of a running agent. They compose.
- **macOS `.app` wrapper.** `build-macos-app.sh` (built-ins only: sips + iconutil)
  produces **Motherlink Agent.app** — double-click, no terminal window, real icon
  (`appicon-1024.png` → AppIcon.icns). Bakes the repo's absolute path + robust node
  lookup; a copy sits on the Desktop. The .app bundle is gitignored (machine-
  specific); the build script + icon source are committed.
- **Root cause of a "127.0.0.1 refused" report (FIXED).** Not a conflict — the
  panel never launched. This Mac's node is at `~/.local/node-*/bin` (on PATH only
  via `~/.zshrc`, NOT in `/etc/paths`); a Finder double-click runs with the SYSTEM
  path, so `#!/bin/bash` + `exec node` → node-not-found → nothing bound. Both the
  `.command` and the `.app` now locate node explicitly (homebrew / /usr/local /
  ~/.local/node-* / nvm) instead of trusting PATH. The launchd plist was already
  robust (absolute node path). Verified the fix under a simulated clean-PATH launch.
- **Verified:** `node --check` on supervisor; booted it (PANEL_NO_AUTOSTART=1),
  `/api/status` returns correct JSON, autostart reports supported on darwin; the
  `.app`'s executable serves the panel under an `env -i` clean-PATH launch. Did NOT
  start the real child (needs .env/key). README updated (app is the recommended run).

### 2026-07-22 (cont.) — in-app agent power switch (on/off) — BUILT then REMOVED

Briefly built a remote on/off (`agents/control.enabled`) that paused/resumed a
running agent, on the Dashboard + Accounts. **Removed the same day** once the
local control panel landed: it did real Start/Stop of the process, and dry-run
already covers "stop posting remotely" — a third overlapping switch (and agent
status on the general Dashboard) was redundant/confusing. All of it was
uncommitted, so it was backed out cleanly:
- Deleted `POST /api/agent/power` + `setEnabled`; reverted the agent's `enabled`
  flag (readEnabled/countQueued/ensureControl/heartbeat) — `node --check` clean.
- `AgentControls.tsx` trimmed to **status (online/offline) + dry-run toggle**, and
  removed from the Dashboard; it now lives ONLY on Accounts. `.dot.paused` dropped.
- **What remains for the agent:** the local control panel/app (Start/Stop/logs) +
  the dry-run switch on Accounts. That's the intended surface.

### 2026-07-22 — draft editing + edit-reason training capture (Layer 1)

Built draft editing with a training-signal capture loop. Design agreed up front
(all "recommended"): per-project `drafts.train` permission, unified edit+reject
feedback, tags + free text, Layer 1 only (no Obsidian yet).

- **Permission:** new per-project `drafts.train` (types.ts PERMISSIONS +
  PERMISSION_META, new 'train' group). Only `manager` bundle holds it by default;
  admins grant it via the roles/Adjust UI. Editing a draft stays on
  `drafts.generate`; only a train-holder's rationale is captured.
- **Editor (`DraftEditor.tsx`):** Reddit **Markdown** textarea + formatting
  toolbar (bold/italic/strike/code/superscript/link/quote/list) + **Write/Preview
  tabs**. Preview via `modules/reddit/redditMarkdown.ts` — a small, safe renderer
  of Reddit's subset (escapes first, closed tag set, http(s)/mailto hrefs only;
  safe for dangerouslySetInnerHTML). No WYSIWYG so what posts == what you see.
- **Reason capture:** for `drafts.train` holders the editor requires a reason —
  tag chips (DRAFT_REASON_TAGS: too_salesy, wrong_tone, factual_fix, …) + free
  text — before saving, unless "Minor edit — don't train" is ticked. Reject also
  captures tags+reason for train holders (unified feedback).
- **Data:** `RedditDraft.aiOriginalBody` stamped at creation (pristine model
  output, never overwritten — edits stay trainable against it). Append-only
  `projects/{id}/draftFeedback/{id}` records: before/after, tags, reason, +context
  (subreddit, suggestedAngle, model, promptVersion) — export-ready for Obsidian.
- **Route:** `POST .../reddit/draft/feedback` (kind edit|reject), gated
  `drafts.generate`; writes a feedback record ONLY when caller also holds
  `drafts.train`, gave a reason, and didn't mark it minor. `requireProjectPermission`
  returns the held perms so the train check is free. Only status 'draft' editable.
- **Opportunities page:** Edit button on active drafts → inline editor; reject form
  gains reason chips for train holders; both go through the feedback endpoint. The
  page now subscribes to the caller's own member doc to know `drafts.train` live.
- **NOT built (Layer 2, agreed):** Obsidian sync, few-shot mining, edit-distance /
  tag-frequency metrics. Data is shaped so those are a pure transform.
- **Verified:** `npm run build` + typecheck clean; eslint clean on all new files
  (the 2 on the reddit page pre-existed). No rules change (draftFeedback rides the
  project subtree: server-write-only, read via project.view). Not click-tested live
  (needs auth); DeepSeek untouched.

### 2026-07-20 (cont.) — account warm-up designer (design only, not wired)

Built the warm-up **designer** for posting accounts — a multi-day, editable,
human-like activity schedule that ages an account before it posts. **NOTHING
executes yet**: actions are labelled placeholders; wiring each to a real
AdsPower/Reddit step is the next pass. The `type` discriminator is the seam.

- **Domain model (`src/modules/reddit/warmup.ts`, pure/shared).** Atomic actions
  (browse_home, scroll_feed, open_post, read_dwell, open_subreddit,
  search_keyword, expand_comments, upvote_post/comment, save_post, follow_post,
  join_subreddit, view_profile, idle) with dwell ranges + param keys. **Packages**
  = pre-built human-like flows (quick_peek, casual_browse, discover_and_join,
  keyword_hunt, sub_catchup, light_engage) with optional-chance steps so instances
  vary. `composeWarmupPlan(days, ctx)` ramps intensity (lurk → engage) and weights
  packages by phase — the deterministic "auto design" and the AI fallback.
  `normalizeWarmupPlan` bounds/validates anything from the client. Runs in browser
  + server (no server-only, uses Math.random which is fine outside workflows).
- **AI design (`src/server/warmup.ts`).** `designWarmupPlan` asks DeepSeek for a
  day-by-day PACKAGE skeleton (JSON), then expands it into concrete bounded actions
  from the library — so AI shapes the schedule but can't emit an invalid action.
  Falls back to `composeWarmupPlan` when DeepSeek is unconfigured/errors/returns
  junk, so it always returns a usable plan (`ai:false` in that case).
- **Storage.** Plan is a field on the account doc (`accounts/{id}.warmupPlan`) —
  small, rides the existing client accounts subscription, **no rules change** (still
  `allow write:if false`; writes server-only). Routes under
  `/api/accounts/[accountId]/warmup`: `generate` (POST, returns unsaved plan),
  `PUT` (save, normalised), `DELETE` (clear). All gated `accounts.manage`.
- **Designer UI (`WarmupDesigner.tsx` + `/accounts/[id]/warmup`).** Pick N days →
  Generate with AI / Start blank. Per day: reorder **blocks** (a package or lone
  action moves as a unit), add package/action, remove, edit each action's label +
  params + dwell + gap-to-next (with humanised hint) + jitter, **merge** 2+ selected
  actions into a custom package, ungroup, rename packages, add/remove days. Unsaved-
  changes badge; Save/Delete. Accounts cards got a **Warm-up** link + a "Nd" badge.
- **Verified:** `npm run build` clean (typecheck + build); eslint clean on all new
  files (the 3 on accounts/page.tsx pre-existed). **NOT run:** live click-through
  (needs auth) and DeepSeek path (needs key + spend) — the deterministic composer is
  the tested path by construction. No e2e harness yet.

### 2026-07-20 (cont.) — user delete/archive + custom roles + granular permissions

Two features, both around access management. Not yet committed; build + lint clean.

- **Feature 1 — retire a person three ways (People page).** Previously the only
  option was Revoke (status `disabled`). Added:
  - **Archive** — new `UserStatus` value `archived`. Revokes access exactly like
    disabled (Auth user disabled + refresh tokens revoked) AND hides the row from
    the default roster. Reversible via **Unarchive**. A "Show archived (N)" toggle
    reveals them. This is the "so they don't bother viewing" ask.
  - **Delete** — the `DELETE /api/users/[uid]` route was a soft-disable; it is now
    a real hard delete: removes the Auth user, the `users/{uid}` profile, and every
    `projects/*/members/{uid}` doc (via a collection-group query + batch). Leaves
    `createdBy`/authorship uid strings on past work intact (history, not access).
    Owner-only can delete an owner; can't delete self; type-nothing inline
    two-step confirm in the UI; writes a `user.deleted` WARNING activity log.
- **Feature 2 — make roles + edit individual actions.**
  - **Custom roles**: new top-level `roles/{roleId}` collection + `/api/roles`
    (GET any provisioned caller; POST/PATCH/DELETE platform-admin) + `/roles`
    admin page (`RolesAdmin`). A role is a named permission set; the four built-in
    bundles (viewer/analyst/approver/manager) show read-only alongside custom ones.
    Granting still stores the EXPANDED permission array on the member — editing or
    deleting a role never changes anyone's live access (same guarantee as bundles).
  - **Granular per-member editing**: `PATCH /api/projects/[id]/members/[uid]` sets
    a member's exact permissions. Project page gained an **Adjust** button per
    member → grouped permission checkboxes (`PermissionCheckboxes`, shared with the
    role builder, grouped free / spends-money / touches-internet from new
    `PERMISSION_META`). Guards the last-manager-strands-project case. The add-member
    picker now lists roles from `/api/roles` (built-in + custom) instead of the
    hardcoded bundle names.
- **No firestore.rules change**: `roles/` is read only through the server (Admin
  SDK bypasses rules); no client SDK read, so default-deny covers it. All queries
  are single-field (no new composite index).
- **Design-system fix (checkboxes).** The permission checkboxes first shipped
  looking broken — full-width, 36px-tall boxes — because the global
  `input, select, textarea { width:100%; height:36px }` rule in `globals.css` also
  caught `input[type=checkbox]`. Added a proper base `input[type=checkbox|radio]`
  style (appearance:none, 16px, on-brand indigo fill + CSS checkmark, focus ring)
  so checkboxes render correctly app-wide, plus `.perm-*` classes and a redesigned
  `PermissionCheckboxes` (grouped, full-row hit target, selected-row highlight).
  The old `.check` helper was dead CSS (no usages). NOTE: the app's design system
  ALREADY uses Geist (Geist Sans + Geist Mono via `next/font/google` in
  `layout.tsx`) — "Vercel structure + Motherlink indigo" — so nothing to add there.
- **Add-to-project is now a dropdown, not a typed email.** New `GET /api/directory`
  (any provisioned caller; returns only uid/name/email of non-disabled/archived
  users — roles/status stay admin-only on `/api/users`). The project Access form's
  email input became a **person picker** filtered to exclude existing members, with
  a graceful empty state ("everyone already has access" / link to People). Grant
  still POSTs the selected person's email, so the members route is unchanged.
- **Logo + favicon refreshed.** New brand mark (gradient logomark #3D3AAD→#9492DE
  + "engage" wordmark) replaced `public/logo/{dark,light}.svg` (dark = white
  wordmark, light = #0A0A0A wordmark; logomark identical, theme-swapped by the
  existing `.logo-dark/.logo-light` CSS). Favicon set generated from the logomark:
  `src/app/icon.svg` (SVG favicon), `src/app/favicon.ico` (16/32/48 PNG-in-ICO),
  `src/app/apple-icon.png` (180, full-bleed) — all auto-wired by Next's file-based
  metadata (`/icon.svg` + `/apple-icon.png` show as routes in the build). Source
  `ML engage logo.svg` moved out of the repo root. Regenerate rasters with the
  scratchpad `gen-icons.mjs` (uses the already-present `sharp`).
- **Verified:** `npm run build` clean (typecheck + build); eslint clean on all new
  routes + components. **NOT yet run:** live e2e (no roles/delete e2e harness
  written yet — worth adding, mirroring `e2e-users.mjs`) and manual click-through.
  Poster agent still STOPPED from the prior session.

### 2026-07-20 — posting controlled from the UI + proxy 429 fix

Two commits on `reddit-review-parity` (`14713f6`, `da93cd5`).

- **Reddit fetch 429 (`14713f6`).** Root cause: memoized `ProxyAgent` → undici
  keep-alive pinned ~2 IPRoyal exit IPs → per-IP 429 on multi-subreddit sweeps.
  Fix: fresh `ProxyAgent` per request and per retry (new exit IP each), closed
  after body read; retries 2→3. Proven end-to-end (8/8 subreddits 200, incl. the
  `r/financialindependence` that failed). See the "Known issues" bullet.
- **Live dry-run toggle (`da93cd5`).** Dry-run moved out of the agent's `.env`
  (read once at boot) into Firestore `agents/control.dryRun`, re-read every poll.
  New `POST /api/agent/dry-run` (gated `accounts.manage`) + `server/agentControl.ts`;
  toggle rendered on the **Accounts** page. Agent seeds the doc create-only from
  the env default, then obeys the UI within one poll — no restart. Effective mode
  reported in the heartbeat.
- **Cancel + re-post (`da93cd5`).** New `POST .../reddit/jobs/cancel` (gated
  `drafts.publish`) + `cancelJob` in `server/jobs.ts`. Opportunities page gained
  **Cancel** on queued/posting replies and clearer **Post again** on
  failed/cancelled. `jobByDraft` now carries `jobId`.
- **Stale-`posting` reclaim (`da93cd5`).** Agent clears jobs stuck in `posting`
  (older than `STALE_POSTING_MS`, def 10m) to **failed** — not re-queued, to avoid
  double-posting. `apps/poster-agent/agent-core.mjs`.
- **Verified:** tsc clean; `e2e-poster-agent` green; live Firestore round-trip of
  the control doc (seed / read / no-clobber / non-boolean→null) and stale-job
  reclaim (→ failed, scoped, count-exact); no NEW lint errors (the 5 pre-exist on
  main). NOTE: the new control-doc + reclaim logic has no committed e2e harness
  yet — was checked with throwaway inline scripts. Worth adding one later.
- **⚠️ Near-miss during testing:** a reclaim test re-queued a REAL stuck job
  (draft `IJdD79nR`, r/budget); the live agent (dryRun=false) grabbed it and began
  posting. Caught and killed the agent before submit (no permalink written — did
  NOT post); job parked `cancelled`. This is why reclaim now marks jobs *failed*,
  never re-queues. **Current state: the poster agent is STOPPED** (restart with
  `cd apps/poster-agent && npm start`), and draft `IJdD79nR` is cancelled/free —
  use **Post again** if you want it live.
- **Clarified (see Known issues):** the desktop "Motherlink Poster" app is ML
  Studio's, not this repo, and inert for Engage; and the VPS/distributed topology.

### 2026-07-17 (cont.) — repo authorship + new-reddit plan
- Rewrote git history across ALL commits on both branches (`main` +
  `reddit-review-parity`): author **and** committer changed from a personal
  account to `sayeedops <sayeed@motherlink.io>` (`git filter-branch`,
  `refs/original` cleared, reflog expired). The two commits that had rolled to
  07-17 were **backdated to 07-16** so the last commit reads yesterday. Local git
  config updated; both branches force-pushed.
  - GitHub attributes by email — `sayeed@motherlink.io` must be verified on the
    `sayeed-ops` account for the avatar/link to attach; the Contributors graph
    recomputes off `main` and can lag a bit.
- Wrote the **new-reddit posting plan** under Known issues / decisions (add new
  Reddit as a fallback, not a replacement — old.reddit stays the default).

### 2026-07-17 — poster agent verified live (dry-run) + boot fixes
- Ran the agent on the posting Mac. Two blockers fixed on the way:
  - The agent's `.env` wasn't created by `cp` — recreated with an **absolute**
    key path (`/Users/sayeed/.config/motherlink-engage/admin.json`); Node does
    not expand `~`, and the agent now expands it + fails loudly on a bad key.
  - Real bug: `import admin from 'firebase-admin'` exposes no `.credential` in
    ESM/v14 — the agent would have crashed. Switched `index.mjs` to the modular
    API (`firebase-admin/app` + `/firestore`), matching the tools. Added a
    startup connectivity check that exits loudly on wrong-project / read-only key.
- Result: agent **connects to motherlink-engage, chip goes online, drains the
  queue in dry-run**. Commit `f314bcb`.
- **Go-live is now one flag:** set `DRY_RUN=0` in `apps/poster-agent/.env` and
  restart, then do a first real reply from a **warming** account and confirm the
  permalink comes back. Keep ONE agent running. That is the cutover moment —
  after it, publishing has moved to Engage and ML Studio can stop posting.
- Running the agent: `cd apps/poster-agent && npm install && npm start` (needs
  `.env` + AdsPower running with Local API on). See its README.

### 2026-07-16 (cont.) — poster agent ported to Engage
- Ported ML Studio's `reddit-poster-agent` into `apps/poster-agent/`. Split into
  `agent-core.mjs` (Firestore, Engage schema, browser-free, injectable db) and
  `index.mjs` (the loop + AdsPower/Puppeteer, ported verbatim). Collection remap:
  `reddit_agent_status/agent`→`agents/agent`, `reddit_post_jobs`→`jobs`,
  `reddit_accounts`→`accounts`, `reddit_drafts`/`reddit_posts`→
  `projects/{projectId}/drafts`/`items` (keyed off `job.projectId`).
- Verified the changed half (`tools/e2e-poster-agent.mjs`, 10/10, no browser):
  heartbeat lands in `agents/agent`; rails (gate/nextCounters) correct; success
  write-back sets job→posted, draft→posted+attribution, item→drafted, and
  advances the account counter — all on Engage's nested paths.
- **NOT verified (needs the Mac):** AdsPower open, login + thread verification,
  old.reddit type/submit, selector drift. Run in DRY_RUN first.
- **Warnings recorded for the operator:** the screenshotted desktop menubar app
  is ML Studio's build — even with Engage's key it writes to the wrong
  collections; run the new agent. The 3 migrated accounts carry ML Studio's
  AdsPower profile IDs — confirm those profiles exist + are logged in before
  DRY_RUN=0. One agent only. Start on a warming/throwaway account.

### 2026-07-16 (cont.) — data migration (phase 04)
- Migrated ML Studio's live Reddit data into Engage. Full write-up:
  [MIGRATION.md](./MIGRATION.md). Tooling in `tools/`: `migrate.mjs` (dry-run
  default + `--apply`), `migrate-verify.mjs` (parity), `migrate-rollback.mjs`.
- Key move: **reuse each ML Studio project id as the Engage project id**, so the
  derived item id (`projectId_redditPostId`) equals the old post id and
  analyses/drafts relink with no id remapping. `--apply` is idempotent and
  additive (writes only `{ migratedFrom }`-tagged docs; never touches native
  Engage data like the budgetlee test project).
- The dry-run caught real orphans first: 223 analyses + 25 drafts whose posts are
  gone (debris from ML Studio's purge and its delete-cascade leaving deleted
  projects' rows behind). Policy: skip orphans, **never a posted draft** — all 14
  answered drafts have their posts, all 25 skipped drafts are non-posted.
- Applied cleanly. Counts in Engage: 4 projects · 18 sources · 599 items · 530
  analyses (223 orphan skipped) · 31 drafts (25 skipped) · 3 accounts · 20 jobs;
  growthScore on 301/530 (all v3, 0 anomalies).
- **Parity proven** (`migrate-verify.mjs`): every project buckets identically in
  both systems (items/analysed/brand/growth/answered) and the growth invariant
  holds — e.g. BudgetLee 20 brand · 28 growth · 14 answered in both. This is the
  phase-04 "behaves identically" gate.
- Migrated projects are visible to platform admins (no per-project membership
  assigned — a deliberate later step). Publishing stays off (no agent). ML Studio
  untouched (read-only). Undo any time: `node migrate-rollback.mjs --confirm`.
- NOTE: the migrated data now lives in the Engage Firestore alongside the
  budgetlee test project. If you want a clean slate, roll back and re-apply.

### 2026-07-16 (cont.) — publish enqueue groundwork (Part A, steps 1–2)
- Built the enqueue side of publishing — everything in THIS repo; the local
  posting agent is a separate follow-up.
  - `POST /api/projects/:id/reddit/jobs` (gated `drafts.publish`): loads the
    draft+item+account, re-checks the rate gate server-side (client picker check
    is only a hint), refuses to double-queue a draft, and writes a fully
    denormalised job to the top-level `jobs/` queue. `server/jobs.ts` +
    `server/accounts.ts::getAccount`.
  - Opportunities: an approved draft shows **Publish → pick account** (each
    account shows remaining/cap or the block reason, disabled when the gate says
    no or there's no AdsPower profile). After queueing, the draft shows live
    status (queued/posting/posted/failed) from a `jobs` subscription. The picker
    states plainly that nothing posts until the agent runs.
  - Accounts page: the posting-agent **heartbeat chip** (online within 20s / else
    offline). Reads offline today — no agent is wired.
- **Why counters aren't touched here:** advancing an account's daily count is a
  real-post event, so it belongs to the agent, not enqueue. Queuing does not
  consume the cap; the agent re-checks before each post.
- **Safe by construction:** Engage's `jobs/` queue is a different Firebase
  project from ML Studio's, so ML Studio's agent can't drain it, and no Engage
  agent exists yet — queued jobs simply wait.
- Verified: `npm run build` clean; rules **48 → 51** (jobs list-query cases — the
  Opportunities subscription shape); `tools/e2e-reddit-publish.mjs` 15/15
  (validation, banned-account gate block, denormalised job fields, dedupe,
  already-posted guard).
- **Next to finish publishing:** re-point ML Studio's local poster agent
  (`reddit-poster-agent/`) at Engage's Firebase project + service account (keep
  DRY_RUN), and have it advance counters + write back status on success. Then
  the migration (Part B).

### 2026-07-16 (cont.) — accounts module
- Built the posting-identity layer (NOT publishing): `/accounts` — a grid of
  account cards + create/edit form, admin/`accounts.manage`-only nav.
  - Reads client-side (accounts are top-level and hold no secrets; rules already
    allow any signed-in read, deny client writes). Writes via `POST /api/accounts`
    and `PATCH`/`DELETE /api/accounts/:id`, gated on the global `accounts.manage`.
  - `server/accounts.ts` sanitises + bounds the editable fields and seeds the
    rolling-window counters (postCountToday 0, resetAt now, lastPostAt null);
    counters are never client-set — only the (future) posting path moves them.
  - `modules/reddit/accountGate.ts` — `accountPostGate` ported verbatim from ML
    Studio as a PURE function taking epoch-ms fields, so the UI and the eventual
    server enqueue share one decision. The cards show remaining/cap, interval,
    karma, profile id, and the block reason.
- Deliberately scoped OUT: the posting queue (`jobs/`), the local agent, and the
  agent-status chip — that is the actual publishing surface and stays last per
  OVERVIEW (publishing moves after parity sign-off + dry-run + side-by-side).
- Verified: `npm run build` clean; `tools/e2e-reddit-accounts.mjs` 17/17 (CRUD,
  validation, "u/" strip, dailyCap floor, counter defaults, unknown-id guards);
  the pure gate exercised directly (node --experimental-strip-types) across 9
  rail cases (banned/flagged/cap/window-reset/interval/nextAllowed). Rules
  already covered accounts (anon denied, signed-in read, client writes denied).

### 2026-07-16 (cont.) — activity-logs viewer
- Built `/activity` — an admin-only nav item and a live log viewer. Reads go via
  the client SDK under the existing `activity_logs` rule: a platform admin lists
  the whole collection; anyone else is restricted to their own entries
  (`q.myActivityLogs` supplies the required `userId` filter, sorted client-side
  to avoid a composite index). The page still works for a non-admin who lands on
  it directly — rules, not the hidden nav link, are the control.
- Verified: `npm run build` clean; rules suite **44 → 48** (added activity_logs
  LIST-query cases — admin lists all, user lists own, user denied the unfiltered
  list and denied another user's filter; the get() cases already existed).
  Confirmed real, correctly-shaped entries already exist (the earlier clean/
  delete e2es wrote them; `activity_logs` is top-level so they survived the
  throwaway-project deletes).
- With this, everything on the gap list is done **except Accounts + posting
  queue + agent status**, which OVERVIEW holds until last (publishing moves after
  parity sign-off, migration dry-run, and side-by-side). Phase 03 is
  feature-complete for the non-publishing surface.

### 2026-07-16 (cont.) — setup ergonomics
- Wired the onboarding surface, reusing the byte-identical `import-prompts.ts`:
  - **Settings**: a "Bulk import from JSON" card — paste a config object to fill
    the form (applies the 7 RedditModuleConfig fields; name/website belong to the
    project and are noted, not applied), plus "Copy AI prompt to generate
    project" (takes a company identifier so the LLM doesn't cross-talk).
  - **Knowledge**: "Bulk import" — paste a JSON array (or single object), one
    POST per row through the existing sources route, with a created/failed tally;
    plus "Copy AI prompt" with the client's context baked in (loaded best-effort
    from config + project).
  - **Opportunities**: the search-feedback card (query echo + per-subreddit
    hits), accumulated across the per-subreddit search loop.
- `buildSourcesImportPrompt` now takes a `SourcesPromptContext` (a Pick of
  RedditProject) so Engage's split Project + module-config can build it without a
  cast. This is a UI-helper signature only — the parity-critical prompts in
  `prompts.ts` are untouched.
- Verified: `npm run build` clean; new `tools/e2e-reddit-import.mjs` — 3/3 (the
  bulk tally is honest: url + pasted_text created, a non-http url counted failed,
  exactly 2 persisted). No server route logic changed (the fetch route already
  returned hitsBySubreddit/query), so the pipeline/curation/lifecycle suites are
  unaffected.
- Remaining gap-list items: **activity-logs viewer** (writes exist, no UI), and
  **Accounts + posting queue** — which stay last per OVERVIEW (publishing moves
  last, after parity sign-off).

### 2026-07-16 (cont.) — project lifecycle / danger zone
- Ported the destructive-op trio with the retention invariant intact:
  - **Auto scoped purge** — `POST reddit/purge` (gated `items.fetch`). The
    Opportunities fetch cycle accumulates fresh item ids + the subreddits that
    actually returned posts, then reconciles once. Favourite + has-draft
    protections are enforced server-side (never from the client body), so a bad
    request can only clear one's own non-favourited, un-answered history within
    the named subreddits. Errored/empty subreddits are out of scope and never
    wiped. Fetch now reports "N new · M cleared (kept K ★)".
  - **Clean history** — `POST reddit/clean` (gated `project.settings`). Clears
    items + analyses + non-posted drafts; keeps config, sources, members, and
    posted drafts (the ANSWERED ledger).
  - **Delete project** — `DELETE /api/projects/:id` (gated `project.settings`).
    `recursiveDelete` on `projects/{id}/` removes the whole subtree — no orphans,
    closing ML Studio's "cascade leaves drafts/jobs behind" defect.
  - UI: a type-to-confirm **Danger zone** on the project page (type `clean` /
    the project name), shown only to platform admins or holders of
    `project.settings`.
- Added `src/server/activityLog.ts` — server-only audit writes, doc shape
  mirrors ML Studio; clean + delete emit WARNING entries. **No viewer yet** (that
  and the full search-feedback card are the remaining bits of those gap items).
- Verified: `npm run build` clean; new `tools/e2e-reddit-lifecycle.mjs` —
  **25/25** on a throwaway project (scoped purge keeps fresh/favourite/answered
  and leaves the other subreddit alone; clean keeps posted drafts + sources;
  delete empties the subtree). Curation e2e still green (no regression). No
  rules change needed — activity_logs was already server-write-only with a
  read rule.
- NOTE: auto-purge is client-cycle-driven (like ML Studio), so a direct API
  fetch (agent, e2e-pipeline) does NOT purge — only the UI fetch loop does.

### 2026-07-16 (cont.) — review-workflow actions
- Ported the daily-driver curation layer onto the fetch→analyse→draft spine:
  favourite star, skip/archive (new **Archived** tab, reversible via Unskip),
  re-analyse, mark-posted, draft reject + reviewer notes, and NEW/ANSWERED
  badges. Behaviour matched to ML Studio's opportunities page.
- The architectural change from ML Studio: it did all of these as client-side
  `updateDoc` calls. Here every mutation goes through a permission-gated server
  route (`PATCH .../reddit/items`, `PATCH .../reddit/draft`); reads stay live via
  onSnapshot, with a small optimistic overlay so the star/skip feel instant.
  Gates: item curation → `items.analyze`, draft status → `drafts.generate`
  (both held by the `analyst` bundle so the daily workflow isn't blocked).
  **These gate choices are worth a look** — favourite/skip are free & reversible
  yet sit behind a money-spend permission; revisit if a viewer should be able to
  curate.
- NEW badge is per-project localStorage (`motherlink-engage:reddit:lastSeen:*`),
  like ML Studio. ANSWERED derives live from `draft.status === 'posted'`.
- Verified: `npm run build` clean (typecheck + build); new
  `tools/e2e-reddit-curation.mjs` — 14/14 against the live server, asserting
  persistence + input guards + that mark-posted keeps the post status and the
  ANSWERED ledger in agreement. No DeepSeek spend (seeds its draft via Admin SDK).
- Not done in this pass (next up on the gap list): purge/clean-history/danger
  zone, bulk import + copy-prompt, search feedback card, activity logs. Accounts
  + posting queue stay last per OVERVIEW (publishing moves last).

### 2026-07-16 — read architecture fix + docs
- Wrote OVERVIEW.md and this HANDOFF.md.
- Fixed read latency: hot reads now go direct from the browser via the client
  SDK (live, cached); checkRevoked dropped (496ms→1ms); server caches
  profile+membership with immediate invalidation on access change.
- Rules 40→44 tests (added collection-group members read + client list-path
  checks). User security 13→17 (added promote-via-API + revocation-beats-cache).
  Rules deployed. Full pipeline still green.

### 2026-07-15 (cont.) — Reddit module
- Ported lib byte-identical; built deepseek/rss/store; config/fetch/analyze/
  draft/items/sources routes; Opportunities/Knowledge/Settings UI.
- Adopted the real Motherlink design system; light default.
- Full pipeline verified against real Reddit + DeepSeek.

### 2026-07-15 — foundation
- Closed the world-writable production database (user published the hotfix;
  PR #1 merged on ML Studio).
- Created Firebase project, rules (40/40), server tier, user admin (13/13).
- Scaffolded on Next 16.2.10 (closes CVSS 7.5 auth-bypass in ML Studio's
  16.2.5). Backup tooling; first backup 1,708 docs.
- Preserved the untracked motherlink-poster Electron app.
