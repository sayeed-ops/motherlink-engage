# Motherlink Engage — Overview

> The north-star document. What we are building and why. Changes rarely.
> For "where are we right now", see [HANDOFF.md](./HANDOFF.md).

## What this is

Motherlink Engage is a **multi-platform promotion and conversation-engagement
platform**. It is being extracted from the Reddit Visibility Assistant that
currently lives inside ML Studio (`motherlink-studio-v2`), and rebuilt as a
standalone product that can host many client projects, many team members, and
eventually many platforms.

Reddit is the first platform. Quora, LinkedIn, and other forums are intended to
follow as additional modules — not additional apps.

## The two goals, and the tension between them

1. **Preserve the Reddit tool exactly.** Same features, same behaviour, same
   hard-won operational knowledge. A user of the current tool should find
   everything they had, working the way it worked.
2. **Make the architecture flexible** for team usage and more tools: real
   accounts, per-client access control, and a module system that makes adding
   Quora additive rather than a second rewrite.

These pull against each other. Goal 1 says "change nothing"; goal 2 says
"change the foundation." The resolution: **change the foundation, keep the
behaviour.** The Reddit compute — prompts, RSS parsing, proxy handling, the
agent — is copied byte-identical. Everything around it (auth, persistence,
tenancy) is rebuilt.

## Why a rebuild and not a lift-and-shift

The audit (`../MIGRATION-BRIEF.html`) found that ML Studio's Reddit tool has no
real security or tenancy model:

- Its production Firestore rules were `allow read, write: if true` — the whole
  database was world-readable and world-writable.
- Its API routes have no authentication. An anonymous curl to production still
  returns real Reddit posts fetched through the paid proxy.
- Any signed-in user could read and write every client's data.
- Invitation tokens were `Math.random()`, stored in plaintext, and readable by
  anyone.

None of that can be "ported." The authorization layer is the actual reason
Engage exists. Everything else is a move.

## Target architecture

**Two tiers, clean seam.**

- **Client (browser).** Reads data it is allowed to see, directly from
  Firestore, using security rules for enforcement. Fast, cached, real-time.
- **Server (route handlers, Admin SDK).** Every write, and every action that
  spends money or touches the public internet. Verifies the caller's ID token
  and checks their permission before acting.

**Authorization is two layers.**

- **Global role** (`owner` / `admin` / `member`) — platform-wide standing.
  Mirrored into a custom auth claim so rules can check it without a read.
- **Per-project permissions** — what you may do for one client. Stored on
  `projects/{id}/members/{uid}`, read by rules on every request.

**Platform is data, not a name.** A project holds modules; every item carries a
`platform` discriminator. Adding Quora means a new module, not a parallel set of
`quora_*` collections.

**Permissions split by what they cost**, not by view-vs-edit:

- free — `project.view`, `project.edit`, `knowledge.manage`, `analytics.view`
- spends money — `items.fetch` (proxy bandwidth), `items.analyze` /
  `drafts.generate` (DeepSeek credit)
- touches the public internet — `drafts.approve`, `drafts.publish` (irreversible)

## Data model

```
users/{uid}                                  profile, global role, status
projects/{projectId}                         one client; enabledModules[]
  members/{uid}                              THE authorization record; permissions[]
  modules/reddit                             per-client Reddit config
  sources/{sourceId}                         knowledge base
  items/{itemId}                             fetched posts (platform-discriminated)
  analyses/{analysisId}                      scores; immutable; promptVersion stamped
  drafts/{draftId}                           generated replies
accounts/{accountId}                         posting identities (top-level; shared)
jobs/{jobId}                                  the post queue (top-level; one agent drains)
agents/{agentId}                             agent heartbeat
activity_logs/{logId}                        audit
invitations/{invId}                          server-side only
```

Accounts and jobs are top-level, not per-project: one Reddit identity posts
across several clients, and the local agent needs a single global queue to
drain.

## The three deployables (unchanged from ML Studio's design)

1. **The web app** — Next.js on Vercel. What this repo is.
2. **The local posting agent** — Node + Admin SDK + Puppeteer, runs on one Mac
   beside AdsPower, drains the job queue and posts to Reddit. Copied essentially
   as-is; only its Firebase project config changes.
3. **The Electron menu-bar wrapper** — packages the agent for a non-technical
   operator.

Firestore is the entire message bus between them. No VPS, no queue service.

## Operational knowledge that must survive (the expensive part)

This is documented at length in ML Studio's `reddit-tool-complete-guide.md`.
The load-bearing facts:

- **RSS, not the JSON API.** `.json` returns 403 for this network; the official
  API's Nov-2025 policy won't approve a promotional use case and applying can
  flag accounts. RSS + a browser User-Agent + a rotating residential proxy is
  the only path that returns 200.
- **Reading and posting need opposite proxy types.** Rotating residential for
  reads; one sticky ISP IP pinned per account for posting. Crossing them gets
  accounts banned.
- **Credentials never live in the product.** Reddit sessions live in AdsPower
  profile state, bound to sticky IPs, on the posting Mac. Not in Firestore, not
  in the repo.
- **Prompt versions carry data semantics.** Analysis `v3` introduced
  `growthScore`; ~60% of production analyses predate it and legitimately have no
  growth score. Draft `v2` fixed a capitalization regression.
- **The growth invariant.** growth ⟺ `mentionRecommendation: 'no'` ⟺ the reply
  structurally cannot pitch the brand. This is the safety property that makes
  account-warming replies safe.
- **Automated posting is against Reddit's ToS.** Accounts will be banned
  periodically; the system is built to rotate them in and out.

## Non-negotiables

- ML Studio keeps running and keeps publishing until Engage is fully verified.
- Do not modify production data without a backup and an approved plan.
- Do not run two agents against one queue (rate rails would be evaluated
  concurrently and could breach a daily cap).
- Publishing does not exist in Engage until parity is signed off.
- No secrets in the repo or in documentation.

## Definition of done (v1)

Engage does everything ML Studio's Reddit tool does — **except that it is
multi-tenant, access-controlled, and team-ready** — and the current tool's real
data has been migrated and verified to behave identically. Publishing is the
last capability to move, via a single agent re-point.
