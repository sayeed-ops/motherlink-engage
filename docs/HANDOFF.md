# Motherlink Engage — Handoff

> Living document. Updated at the end of every working session. Read this first
> when resuming. For the "why", see [OVERVIEW.md](./OVERVIEW.md).

**Last updated:** 2026-07-16 (activity-logs viewer)
**Repo:** github.com/sayeed-ops/motherlink-engage (private)
**Firebase:** motherlink-engage (Spark plan)
**Deploy target:** Vercel (not yet deployed; local dev only so far)
**Local dev:** `cd apps/web && npm run dev` → http://localhost:3010
**ML Studio still live & authoritative:** motherlink-studio-v2.vercel.app

---

## Migration phase tracker

| Phase | State |
|---|---|
| 00 Preserve + audit | ✅ done |
| 01 Decisions | ✅ done |
| 02 Standalone shell (auth, tenancy, permissions) | ✅ done |
| 03 Port Reddit review tool | 🟡 near-complete — full review workflow, lifecycle/danger zone, bulk import, search feedback, activity viewer. Only Accounts + posting queue remain (held to last). |
| 04 Migration dry-run into staging | ⬜ not started |
| 05 Side-by-side parallel run | ⬜ |
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

- [ ] **Accounts** — posting identities, AdsPower profile ids, daily caps, min
      intervals, status (active/warming/flagged/banned), the rate gate
      (`accountPostGate`). Currently top-level `accounts/` collection exists in
      the rules but has no UI or API.
- [ ] **Post queue + agent status chip** (`jobs/`, `agents/` — in rules, not
      built).
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
- **Agent defects to fix AFTER parity, not during:** no job lease/TTL (a
  crashed agent strands a job in `posting` forever); username check skippable
  when `expectedUsername` empty; `deleteProjectCascade` leaves jobs behind; rate
  gate implemented three times. All documented in the migration brief.
- **IPRoyal:** read proxy and sticky posting proxies share one sub-user, so
  rotating the exposed credential would break all AdsPower profiles. Deferred;
  create an `app-read` sub-user before side-by-side. Engage currently borrows ML
  Studio's `REDDIT_PROXY_URL` for local dev.
- **Resend** still uses the sandbox sender; email is off by default anyway.

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
cd tests && npm test                  # 48/48 rules isolation (incl. activity_logs list queries)
cd tools && node e2e-users.mjs        # 17/17 user security (needs dev server up)
cd tools && node e2e-reddit-pipeline.mjs   # full pipeline (needs dev server up)
cd tools && node e2e-reddit-curation.mjs   # favourite/skip/reject/mark-posted (dev server up; no DeepSeek spend)
cd tools && node e2e-reddit-lifecycle.mjs  # scoped purge / clean / delete on a throwaway project (dev server up)
cd tools && node e2e-reddit-import.mjs     # bulk source import tally is honest (throwaway project; dev server up)
```

---

## Session log

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
