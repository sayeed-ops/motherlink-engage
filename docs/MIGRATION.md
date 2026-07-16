# Reddit data migration — ML Studio → Engage

> Phase 04. Brings ML Studio's live Reddit data into Engage and proves it
> behaves identically. Source is read-only; the write into Engage is additive,
> tagged, and reversible. ML Studio keeps running until cutover.

## Commands (`tools/`)

```
node migrate.mjs                 # DRY RUN — read source, validate, report. Writes nothing.
node migrate.mjs --apply         # write into Engage (only if the dry run is READY)
node migrate-verify.mjs          # parity: same brand/growth/answered buckets in both systems
node migrate-rollback.mjs        # DRY RUN — list what a rollback would remove
node migrate-rollback.mjs --confirm   # remove everything tagged { migratedFrom }
```

Keys: source `~/.config/motherlink-engage/migration-reader.json` (read-only on
`motherlink-studio`), target `~/.config/motherlink-engage/admin.json`.

## The key idea: keep the project id, and item ids fall out for free

Engage derives an item id as `${projectId}_${redditPostId}`, and ML Studio's
post-document id is already exactly that. So by **reusing each ML Studio project
id as the Engage project id**, every migrated item id equals the old post id —
and analyses/drafts (which point at `postId`) relink with **no id remapping**.
Migration is a re-parent + a few field renames, not a transform. It is also
idempotent: re-running `--apply` recursiveDeletes the prior migration of a
project (tagged docs only) and rewrites it.

## Mapping (flat `reddit_*` → nested `projects/{id}/…`)

| Source (ML Studio) | Target (Engage) | Notes |
|---|---|---|
| `reddit_projects/{id}` | `projects/{id}` + `projects/{id}/modules/reddit` | identity split from module config; `websiteUrl`→`clientWebsiteUrl`; `enabledModules:['reddit']` |
| `reddit_posts/{pid}` | `projects/{id}/items/{pid}` | `createdAtReddit`→`createdAtSource`; `redditPostId`→`externalId`; `platform:'reddit'` |
| `reddit_opportunity_analyses/{id}` | `projects/{id}/analyses/{id}` | `postId`→`itemId` (same value); growth fields stay **absent** when the source lacks them |
| `reddit_drafts/{id}` | `projects/{id}/drafts/{id}` | `postId`→`itemId`; a `analysisId` pointing at a skipped analysis is nulled |
| `reddit_sources/{id}` | `projects/{id}/sources/{id}` | as-is; `relevantSourceIds` in analyses filtered to surviving sources |
| `reddit_accounts/{id}` | `accounts/{id}` (top-level) | as-is |
| `reddit_post_jobs/{id}` | `jobs/{id}` (top-level) | ids + projectId unchanged, so still relinks |

Every migrated doc carries `{ migratedFrom, migratedAt, migratedBy }`.

**Not migrated:** `users`, `roles`, `features`, `invitations`, `system_settings`
(Engage has its own auth), `activity_logs` (tied to ML Studio uids + a different
action enum), `reddit_agent_status` (per-runtime).

**Membership is not assigned.** Migrated projects are visible to platform admins
by role; granting specific teammates access to a client is a deliberate step,
not a migration default.

## Orphan policy

ML Studio accumulated analyses/drafts whose **post no longer exists** — debris
from its purge / clean-history and from its delete-cascade leaving analyses of
deleted projects behind. With no post they never render, so the migration
**skips** them. The one hard rule: a **posted draft (the answered ledger) is
never skipped** — an orphaned posted draft would be a blocking error.

## Result (2026-07-16)

Applied cleanly; counts verified in Engage:

```
projects 4 · sources 18 · posts→items 599
analyses 753 → 530   (skipped 223 orphan — all from deleted projects/posts)
drafts   56  → 31    (skipped 25 orphan, all non-posted; all 14 posted kept)
accounts 3 · jobs 20
growthScore present on 301/530 kept analyses (all v3; 0 anomalies)
```

`migrate-verify.mjs` — **PARITY OK**: every project buckets identically in both
systems (items / analysed / brand / growth / answered) and the growth invariant
holds. e.g. BudgetLee = 20 brand · 28 growth · 14 answered, in both.

## What's next (still phase 05+)

- The migrated data is in Engage but **publishing is still off** — no local agent
  is wired, so nothing posts.
- Assign per-project team membership where needed (admins already see everything).
- Re-point ML Studio's poster agent at Engage, keep DRY_RUN, then side-by-side.
