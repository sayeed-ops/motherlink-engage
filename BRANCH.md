# `warmup-autopilot` — what's new since `main`

_Last updated 2026-10-26 · **not in production** — being tested on a local dev server; goes live only when the owner says so_

## Warm-up autopilot (new, step 1 of 3)
- **Switch an account on and it warms itself up every day.** No more queueing sessions by hand.
- Each day it **plans the account's sessions at irregular times inside its waking hours** (08:00–23:30 by default) **in the account's own time zone**, at least 75 minutes apart, and **takes about one day in seven off**.
- Accounts **climb stages by calendar day**: Settle (days 1–3, 1–2 sessions, no joining), Lurker (days 4–7), First words (days 8–14), Regular (day 15+). Joining the communities tagged Follow starts at Lurker.
- **Every number is adjustable** on the new **Autopilot** settings page (owner and admin): the stages, sessions per day, waking hours, days off, the default time zone.
- The account's **Warm-up → Autopilot** tab has the on/off switch, its stage and day, its time zone, **today's plan with each session's status**, and **Re-plan today**. Turning it off cancels the sessions that have not started.
- The server **wakes itself a few minutes before each planned session** and sleeps between them.
- Sessions planned for later **never block** a session you start by hand or an approved comment, and **Cancel** leaves them alone.
- **Comments** join the autopilot in step 2; **pausing on trouble and the overview of all accounts** come in step 3.
- On a local dev server the day is planned with **Autopilot → Plan now**; the live site will plan by itself.

## Warm-up page tidied
- **Package designer** is replaced by **Autopilot**. **Post karma** is removed.

## New accounts find comments out of the box
- An account that never saved comment settings now **starts with Wasim.2's settings**: rising, hot and new feeds; threads up to 24 hours old with up to 200 comments; top comment up to 500; upvote ratio from 0.5; up to 4 comments per community a day; 8 threads per scan; and the four testing switches on. Accounts that already saved settings keep theirs.
