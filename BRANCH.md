# `warmup-autopilot` — what's new since `main`

_Last updated 2026-10-27 · **in production** — everything below is on `main` as of 2026-10-27_

## Warm-up autopilot (new, step 1 of 3)
- **Switch an account on and it warms itself up every day.** No more queueing sessions by hand.
- Each day it **plans the account's sessions at irregular times inside its waking hours** (08:00–23:30 by default) **in the account's own time zone**, at least 75 minutes apart, and **takes about one day in seven off**.
- Accounts **climb stages by calendar day**: Settle (days 1–3, 1–2 sessions, no joining), Lurker (days 4–7), First words (days 8–14), Regular (day 15+). Joining the communities tagged Follow starts at Lurker.
- **Every number is adjustable** on the new **Autopilot** settings page (owner and admin): the stages, sessions per day, waking hours, days off, the default time zone (New York).
- **No run of short sessions.** Short sessions are natural, but after 2 short ones in a row (under 3 minutes) the next is re-rolled until it is longer. Both numbers are on the settings page; 0 turns it off. Each planned session shows its expected length.
- The account's **Warm-up → Autopilot** tab has the on/off switch, its stage and day, its time zone, **today's plan with each session's status**, and **Re-plan today**. Turning it off cancels the sessions that have not started.
- The server **wakes itself a few minutes before each planned session** and sleeps between them.
- Sessions planned for later **never block** a session you start by hand or an approved comment, and **Cancel** leaves them alone.
- **Comments on autopilot** (step 2) — one On/Off switch on the settings page. **On:** at each planned time the autopilot **finds 5 threads in 5 different joined Comment communities, writes comments for each, and an AI picks the single best one — most relevant to its thread, most human, least risky — and posts it by itself, no approval.** **Off:** it plans no comments.
  - Tried and approved on a test page first. Takes about 40–55 seconds; reads threads one at a time (never several at once), and the AI works on one thread at a time while the next is being read.
  - The picker avoids comments that claim an experience, job, family or expertise the account has not been given.
  - The other four threads are recorded as looked at, so no later search reads them again.
  - **"Look for a comment" on the Comment karma tab is unchanged** — one thread, you approve it.
  - Comments a day is set per stage (default: none before day 8, then up to 1 a day, then 1–2 from day 15). **Never before day 8**, whatever a stage says.
  - **Never in a thread where another of our accounts already is.**
  - **Project work comes first:** when a project reply is queued for an account, its autopilot comments still waiting that day are cancelled. Project replies themselves are never touched or held up, and comments you scan and approve yourself work exactly as before.
  - Each comment shows on the account's plan: planned, looking for a thread, posting, nothing worth a comment, not posted (and why), or cancelled.
- **Pausing on trouble and the overview of all accounts** come in step 3.
- The agent now reads up to 200 waiting jobs (was 50), so with many accounts on autopilot a session that is due is never missed. **This part needs `UPDATE.bat` on the server.**
- On a local dev server the day is planned with **Autopilot → Plan now**; the live site will plan by itself.

## Account activity — one history for everything (new)
- **Accounts → Activity** lists everything the tool did with every account: browsing sessions, joins, warm-up comments, project comments and Shopify replies. Each account's **Dashboard** shows the same list for that account.
- Filter by account, type (warm-up comments and project comments apart or together), who started it (autopilot, by hand, a project), status, project, and dates; "Show upcoming" adds autopilot's planned sessions. Last 30 days, with "Load older".
- Each row: when, how long, where, the status and why, steps and upvotes, and links — **Comment ↗** to the posted comment when it was captured, **Thread ↗** otherwise. Details show the steps, the comment text, and for project replies the original post and the analysis behind it.
- The scattered history is gone: Browsing loop no longer lists past sessions, and Comment karma's Scans shows only comments waiting for review or on their way.

## Smaller improvements (new)
- The Autopilot tab shows **your own local time** beside the account's (e.g. "10:23 (16:23 GMT+2)"), keeps sessions and comments in one list in time order, and counts down to the **next plan** ("Next plan in 2 h 36 min").
- Pages no longer show "Invalid or expired token" after the computer has slept — they quietly fetch a fresh login.
- The cloud server waits a few minutes after waking before starting a session (the first session after a wake used to crawl), and no longer opens a browser tab on every wake.

## Warm-up page tidied
- **Package designer** is replaced by **Autopilot**. **Post karma** is removed.

## New accounts find comments out of the box
- An account that never saved comment settings now **starts with Wasim.2's settings**: rising, hot and new feeds; threads up to 24 hours old with up to 200 comments; top comment up to 500; upvote ratio from 0.5; up to 4 comments per community a day; 8 threads per scan; and the four testing switches on. Accounts that already saved settings keep theirs.
