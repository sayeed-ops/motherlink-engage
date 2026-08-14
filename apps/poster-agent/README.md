# Engage poster agent (local)

Runs on the posting Mac next to AdsPower. Drains Engage's `jobs` queue: for each
job it opens the account's AdsPower profile, **verifies** the logged-in user and
the thread, types the reply, submits, and writes the result back. Your computer +
AdsPower is the runtime — no server.

This is ML Studio's poster agent re-pointed at Engage's schema. The Firestore
paths (`jobs`, `agents/agent`, `accounts`, nested `projects/{id}/drafts` &
`items`) live in `agent-core.mjs`; the browser automation is unchanged.

> **This file covers install and run.** How to *operate* it — which profile pairs
> with which IP, what the control switches actually mean, what to do when a job
> strands, and the capture rules — is in the private `docs/AGENT.md`. Two rules
> matter enough to repeat here:
>
> - **One agent, and one AdsPower profile per IP. Never two of either.**
> - **Restart the agent after any code change.** Module state and `.env` are read
>   once at startup, so a running agent silently enforces whatever it booted
>   with. If a plan's steps are being dropped, check the log for
>   `dropped N step(s) not in the warm-up vocabulary` before suspecting a bug.

## Setup

```bash
npm install                 # firebase-admin + puppeteer-core
cp .env.example .env        # then: chmod 600 .env  — and edit it
```

`.env` must point `SERVICE_ACCOUNT_PATH` at the **Engage** admin key
(`motherlink-engage`), not ML Studio's. The agent warns loudly at startup if the
key is for the wrong project. Leave `DRY_RUN=1` to start.

Prereqs:
- **AdsPower running**, Settings → **Local API enabled** (port 50325).
- **`ADSPOWER_API_KEY` set in `.env`** — copy it from the same **Settings → Local
  API** screen. AdsPower now requires auth: without the key every `/api/v1/*` call
  answers `{"code":-1,"msg":"Require api-key"}`. `/status` still answers without
  it, so the agent looks fine until it tries to open a profile and the job fails
  with `AdsPower API …: Require api-key`. The key is sent as an
  `Authorization: Bearer` header. AdsPower also rate-limits to roughly one request
  per second, so the agent spaces its calls automatically.
- Each account on Engage's **Accounts** page has its **AdsPower profile ID** and
  the exact **Reddit username**, and that profile is **logged into that account**
  (done once, on its sticky IP).

## Run — the control panel (no terminal)

Launches a tiny local **control panel** at **http://127.0.0.1:4599** that runs
the agent as a child process and gives you **Start / Stop / Restart**, live logs,
crash auto-restart, and a **Start at login** toggle (macOS/Windows/Linux). The
panel binds to `127.0.0.1` only — it never leaves the machine and reads no
secrets (the child agent does all that). Opening the panel auto-starts the agent.

**macOS — the app (recommended).** Build a real double-clickable app once:

```bash
./build-macos-app.sh        # makes "Motherlink Agent.app" (needs macOS: sips + iconutil)
```

Then keep **`Motherlink Agent.app`** on your Desktop or in Applications and
double-click it — no terminal window, proper icon. Re-run the build if you move
the repo (the app stores its absolute path). If macOS ever says "unidentified
developer", right-click → Open once.

**Other ways.** Double-click `Start Agent Panel.command` (macOS) / `Start Agent
Panel.bat` (Windows) — these open a small Terminal window that hosts the panel
(minimise it). Or just `npm run panel`. To go fully hands-off across reboots,
tick **Start at login** in the panel.

The panel controls the local **process**; the Engage web app's **Turn on/off**
and **Dry run** switches control it **remotely** (pause/resume a running agent).
They compose.

## Run — bare (terminal)

```bash
npm start           # node --env-file=.env index.mjs
```

Either way, the Accounts page chip flips to **online** within ~20s. Queue a reply in
Opportunities (Publish → pick account) and watch the draft go
**Queued → Posting → Posted** (or, in dry run, Failed with a "typed but did not
submit" note — that's expected).

## Dry run — toggle from the web UI

`.env`'s `DRY_RUN` is only the **default** the agent seeds on first run. The live
switch is the **Dry run** toggle on the **Accounts** page: it's stored in
Firestore (`agents/control`) and the agent re-reads it **every poll**, so you flip
between dry-run and live posting from the web UI with **no restart**. In dry run
the agent opens the profile, verifies account + thread, types the comment, then
**stops without submitting** (marking the job failed with a dry-run note).

Start with dry run on, watch a few behave correctly, then turn it off on the
Accounts page to post for real.

## Reading the status chip — "1 queued and nothing happens"

**A post that looks stuck is almost always a post that is running.** A humanized
job (browse → find the post → read → skim comments → type) legitimately takes
**4–7 minutes**. That is deliberate: the pacing is the point.

The agent loop is single-threaded. It claims the oldest queued job and then
**blocks inside `processJob()`** for the whole run. Two things used to go wrong in
that window, and together they produced the classic report *"I click Post, it says
1 queued, and nothing happens"*:

1. **The queue count included the job being worked on.** `claimOldestQueued()`
   counted queued docs *before* flipping one to `posting`, so the chip showed
   `1 queued` and stayed there for minutes.
2. **Nothing wrote a heartbeat while the job ran.** The UI calls the agent offline
   after 20s without a stamp (`ONLINE_WINDOW_MS`), so a working agent went dark
   mid-post.

### How it works now

- `claimOldestQueued()` returns `{ ref, job, queued }` where **`queued` is what is
  still *waiting*** — the in-flight job is excluded, because it isn't waiting, it's
  running. It also returns the claimed doc's data, so the caller needs no second
  read. (`queued` comes off a `limit(20)` page, so it saturates at 19. It's a chip,
  not a total.)
- `agents/agent.current` is a map describing the in-flight job —
  `{ jobId, subreddit, expectedUsername, startedAtMs, stage }`. Absent when idle:
  the agent **deletes** the field rather than leaving a stale one, and clears it on
  startup too, so a crashed agent can't leave a phantom "posting…".
- `stage` is coarse and updated in place as the job advances: `starting` →
  `opening profile` → `posting to r/x` → `reading account stats`.
- A **heartbeat ticker** (`HEARTBEAT_MS`, default 5s, capped at 10s) runs *inside*
  the job, independent of the poll loop, so `lastSeenAt` stays fresh across the
  full several minutes.

The chip therefore reads **`online · posting r/frugal · 3m`** while a job runs,
`online · 2 queued` when work is waiting for a free agent, and `online · idle`
when there's nothing to do.

### Where the code lives

| Concern | File |
|---|---|
| Claim + `queued` arithmetic, heartbeat shape | `agent-core.mjs` — `claimOldestQueued`, `heartbeat` |
| Ticker, `currentJob`, `setStage` calls | `index.mjs` — search `startHeartbeatTicker` |
| Turning the doc into chip text | `apps/web/src/lib/agentStatus.ts` — `readAgentStatus` |
| The two chips | `apps/web/src/components/AgentControls.tsx`, `SidebarAgentControl.tsx` |
| Wiring test (claim + heartbeat) | `tools/e2e-poster-agent.mjs` steps 2–3 |

### If it looks stuck again, check in this order

1. **Chip says `posting … Nm`** → it's working. A job over ~10 minutes is a real
   stall; the agent's own `STALE_POSTING_MS` sweep will fail it eventually.
2. **Chip says `N queued` and never moves** → nobody is draining. Is the agent
   process actually up on the posting Mac? Is another job's account gated (look for
   `job … waiting: Min interval not elapsed` in the agent log — that defers, and a
   deferred job goes back to `queued`)?
3. **Chip says `offline`** → the process is down, or its key can't write
   `agents/agent`. The agent exits loudly at startup on both.
4. **Job went `failed` with "typed but did not submit"** → that's **dry run**. It's
   the expected outcome, not a fault. Turn dry run off to post for real.

## Recovering a stopped-mid-post job

If the agent is stopped while a job is posting, that job is left in `posting`.
On its next run the agent clears any `posting` job older than `STALE_POSTING_MS`
(default 20m — raised from 10m because the humanized approach flow legitimately
runs several minutes, and reclaiming a live job would mark a real post failed) to
**failed** — never auto-re-queued, since the comment may have gone up before the
stop. Check Reddit, then use **Post again** in the UI if it didn't. You can also
**Cancel** a queued/posting job from the Opportunities page.

## Safety

- **One agent only** against the queue — never two (the rate rails are evaluated
  per poll; two pollers could breach a daily cap).
- Automated posting is against Reddit's ToS; accounts get banned periodically.
  The per-account caps/intervals keep volume human — the agent re-checks them
  before every post and defers when the interval hasn't elapsed.
- Posts via **new reddit** (`www.reddit.com`) since 2026-07-29 — `POST_SURFACE`
  flips it back to `old` with no code change if Shreddit's markup drifts. If
  posting fails with "could not find the comment box", Reddit changed its HTML:
  the fragile selectors are confined to `reddit/comment-new.mjs` and
  `reddit/browse.mjs` so repairs stay local, and a `last-attempt.png` is saved to
  help. Recorded markup lives in the private `docs/REDDIT-DOM.md`.
- Keep `.env` and any `service-account.json` out of git (already gitignored).
