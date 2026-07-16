# Engage poster agent (local)

Runs on the posting Mac next to AdsPower. Drains Engage's `jobs` queue: for each
job it opens the account's AdsPower profile, **verifies** the logged-in user and
the thread, types the reply, submits, and writes the result back. Your computer +
AdsPower is the runtime — no server.

This is ML Studio's poster agent re-pointed at Engage's schema. The Firestore
paths (`jobs`, `agents/agent`, `accounts`, nested `projects/{id}/drafts` &
`items`) live in `agent-core.mjs`; the browser automation is unchanged.

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
- Each account on Engage's **Accounts** page has its **AdsPower profile ID** and
  the exact **Reddit username**, and that profile is **logged into that account**
  (done once, on its sticky IP).

## Run

```bash
npm start           # node --env-file=.env index.mjs
```

The Accounts page chip flips to **online** within ~20s. Queue a reply in
Opportunities (Publish → pick account) and watch the draft go
**Queued → Posting → Posted** (or, in dry run, Failed with a "typed but did not
submit" note — that's expected).

## Dry run first

`.env` ships with `DRY_RUN=1`: the agent opens the profile, verifies account +
thread, types the comment, then **stops without submitting** (and marks the job
failed with a dry-run note). Watch a few behave correctly, then set `DRY_RUN=0`
and restart to post for real.

## Safety

- **One agent only** against the queue — never two (the rate rails are evaluated
  per poll; two pollers could breach a daily cap).
- Automated posting is against Reddit's ToS; accounts get banned periodically.
  The per-account caps/intervals keep volume human — the agent re-checks them
  before every post and defers when the interval hasn't elapsed.
- Posts via **old.reddit.com** (stable markup). If posting fails with "could not
  find the comment box", Reddit changed its HTML — the selectors in
  `postComment()` need a tweak, and it saves `last-attempt.png` to help.
- Keep `.env` and any `service-account.json` out of git (already gitignored).
