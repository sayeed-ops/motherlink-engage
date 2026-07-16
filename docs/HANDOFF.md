# Motherlink Engage — Handoff

> Living document. Updated at the end of every working session. Read this first
> when resuming. For the "why", see [OVERVIEW.md](./OVERVIEW.md).

**Last updated:** 2026-07-16 (read-architecture fix)
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
| 03 Port Reddit read path | 🟡 in progress — spine works, ~60% of features |
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
- [ ] **Favourites** (isFavorite is persisted; no UI to toggle).
- [ ] **NEW badges** (localStorage lastSeen) and **ANSWERED badges** (posted
      drafts as a ledger).
- [ ] **Purge / clean history / delete project** with scoped-purge retention
      (favourites and posts-with-drafts survive; an errored subreddit never
      wipes another's posts).
- [ ] **Mark posted**, **re-analyse**, **skip/archive item**, **draft reject +
      reviewer notes**.
- [ ] **Bulk JSON import** + **"Copy AI prompt to generate project/sources"**
      (`import-prompts.ts` is copied but unwired).
- [ ] **Search feedback card** (hitsBySubreddit, query echo).
- [ ] **Activity logs** write + view.
- [ ] **Project danger zone** UI.

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
cd tests && npm test                  # 40/40 rules isolation
cd tools && node e2e-users.mjs        # 17/17 user security (needs dev server up)
cd tools && node e2e-reddit-pipeline.mjs   # full pipeline (needs dev server up)
```

---

## Session log

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
