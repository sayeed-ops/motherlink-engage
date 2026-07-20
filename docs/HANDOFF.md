# Motherlink Engage — Handoff

> Living document. Updated at the end of every working session. Read this first
> when resuming. For the "why", see [OVERVIEW.md](./OVERVIEW.md).

**Last updated:** 2026-07-20 (user hard-delete + archive; custom roles + per-member permission editing)
**Repo:** github.com/sayeed-ops/motherlink-engage (private)
**Firebase:** motherlink-engage (Spark plan)
**Deploy target:** Vercel (not yet deployed; local dev only so far)
**Local dev:** `cd apps/web && npm run dev` → http://localhost:3010
**Poster agent:** `cd apps/poster-agent && npm start` (drains Engage's queue via AdsPower). **Dry-run is now toggled from the Accounts page** (Firestore `agents/control`, re-read every poll); `.env` `DRY_RUN` is only the seeded default.
**Migration:** applied — ML Studio's 4 projects live in Engage (see [MIGRATION.md](./MIGRATION.md))
**ML Studio still live & authoritative:** motherlink-studio-v2.vercel.app (publishing not yet cut over)

---

## Migration phase tracker

| Phase | State |
|---|---|
| 00 Preserve + audit | ✅ done |
| 01 Decisions | ✅ done |
| 02 Standalone shell (auth, tenancy, permissions) | ✅ done |
| 03 Port Reddit review tool | 🟡 near-complete — review workflow, lifecycle/danger zone, bulk import, search feedback, activity viewer, accounts, and the publish ENQUEUE path. Only the local posting agent (drains the queue, actually posts) remains. |
| 04 Migration dry-run into staging | ✅ done — dry-run + applied into Engage; parity verified (buckets identical) |
| 05 Side-by-side parallel run | 🟡 unblocked — agent runs against Engage in dry-run; go-live is flipping DRY_RUN=0 |
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
      **Verified live in DRY_RUN on the posting Mac** (2026-07-17): connects,
      chip goes online, claims a queued job and runs the AdsPower/old.reddit path.
      The ONLY thing left before real posting is flipping `DRY_RUN=0` for a first
      live reply on a warming account. The old desktop menubar app is ML Studio's
      and won't work against Engage — run this agent (or re-wrap it later).
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
- **Posting drives old.reddit.com, by design.** The agent's `postComment()`
  automates old.reddit because it's stable, server-rendered HTML (a plain
  `textarea[name="text"]` + form POST). A comment posted there **is the same
  comment** on new Reddit — the reply is visible on reddit.com regardless — so
  there's no functional reason to switch unless a target subreddit disables
  old.reddit, an account only works on the new UI, or Reddit sunsets old.reddit.
  - **Plan if/when needed — add new Reddit as a FALLBACK, do NOT replace:** try
    old.reddit first, drop to reddit.com only when the box/thread isn't found.
    Keeps the stable path for the ~95% case.
  - Scope: rework only `postComment()` (~130 lines) in
    `apps/poster-agent/index.mjs`; loop/queue/rails/write-back are untouched. Six
    steps change because new Reddit ("Shreddit") is React + web components with
    shadow DOM:
    - the comment box is a **contenteditable rich-text editor inside shadow
      DOM**, not a textarea — the crux. Puppeteer pierces OPEN shadow roots via
      `>>>`, but not closed ones (may need a CDP / keyboard-coordinate fallback);
    - confirm success + capture the permalink by **intercepting the GraphQL/POST
      response**, not scraping the virtualized comment list;
    - login + thread verification move into components (the URL check still works).
  - Real cost is upkeep: new Reddit's obfuscated markup breaks selectors often
    (old.reddit was chosen precisely because it's frozen) and it has more
    client-side bot detection. Budget ~1 day to build + recurring maintenance.

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
```

---

## Session log

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
  `reddit-review-parity`): author **and** committer changed from
  `Sayeed <sunaanmaster@gmail.com>` → `sayeedops <sayeed@motherlink.io>`
  (`git filter-branch`, `refs/original` cleared, reflog expired). No
  `sunaanmaster` remains anywhere reachable. The two commits that had rolled to
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
