# Motherlink Engage

A multi-platform promotion and conversation-engagement platform. Reddit is the
first platform module; Quora, LinkedIn and others are intended to follow.

Engage is being extracted from the Reddit Visibility Assistant that currently
lives inside ML Studio (`motherlink-studio-v2`). Until cutover, **ML Studio
remains the system of record and the only thing that publishes to Reddit.**

## Status

Pre-cutover. Under construction. Not yet operational.

See [`MIGRATION-BRIEF.html`](MIGRATION-BRIEF.html) for the full audit of the
existing system and the phased migration plan.

## Layout

| Path | What |
|---|---|
| `apps/web/` | The Next.js app. Deploys to Vercel. |
| `tools/` | Migration and audit scripts. Not part of the app build. |
| `agent/` | *(not yet moved)* The local posting agent. Runs on the posting Mac beside AdsPower. |
| `desktop/` | *(not yet moved)* Electron menu-bar wrapper around the agent. |
| `docs/` | *(not yet moved)* Operational knowledge ported from ML Studio. |

## Stack

Next.js 16.2.10, React 19.2.4, TypeScript, Firebase (Auth + Firestore), Vercel.

Next is pinned to the same minor as ML Studio so the ported Reddit module keeps
its conventions. **16.2.10 rather than ML Studio's 16.2.5**: versions
`>=16.0.0 <16.2.6` carry a middleware/proxy auth-bypass
([GHSA-26hh-7cqf-hhc6](https://github.com/advisories/GHSA-26hh-7cqf-hhc6),
CVSS 7.5), which is disqualifying for an app whose purpose is server-side
authorization.

> Next 16 differs materially from older versions. Read
> `apps/web/node_modules/next/dist/docs/` before using unfamiliar Next APIs.

## What Engage changes vs. ML Studio

Everything else is ported as-is. These are deliberate departures:

1. **Server-side authorization.** ML Studio has no `firebase-admin`, no
   middleware, and no token verification — its API routes are unauthenticated
   and Firestore rules are its only authority. Engage verifies the caller's ID
   token and enforces permissions before doing work.
2. **Per-project isolation.** ML Studio's rules are `isSignedIn()` on every
   Reddit collection, so any signed-in user can read every client's data.
   Engage scopes access to project membership.
3. **Platform as data, not prefix.** `reddit_*` collection names become a
   `platform` discriminator so Quora and LinkedIn are additive.

## Credentials

Service-account keys live in `~/.config/motherlink-engage/` — **never** in this
repo. `.gitignore` blocks the usual filenames as a backstop, but the correct
location is outside the working tree.

## Setup

```bash
cd apps/web
npm install
npm run dev
```
