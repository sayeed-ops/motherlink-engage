# New-Reddit posting + humanized approach flow — design & build plan

> Living design doc — the HOW. Update the phase checklist as we build.
>
> **Status: Phases 0–3 shipped and live-verified (2026-07-29). New reddit is the
> posting default; old.reddit is the rollback.** This doc superseded the handoff's
> old "Posting drives old.reddit.com, by design" decision, which has been rewritten
> to match.
>
> **Read this alongside [HANDOFF.md](./HANDOFF.md), not instead of it.** The handoff
> is the WHAT and WHY (state, decisions, file map, knobs); this is the HOW —
> exact DOM layouts, the behaviour rules, and a run-by-run Validation log of
> everything that broke and why. **Before changing any selector or timing, read
> the Validation log.**

## Goal

1. Post comments on **new reddit** (`www.reddit.com` / "Shreddit"), and make the
   account's **entire footprint** (browsing, warm-up, posting) live on new reddit
   so behaviour is consistent (a casual-user persona, not an old.reddit power user).
2. **Humanize** each post: don't teleport to the thread and dump a comment. First
   search the subreddit, land on it, sort, browse, **read the post as if reading**
   (random dwell, ≤2 min), sometimes skim comments (sometimes not), *then* comment.
3. When an account is picked for a comment, generate a **posting/approach plan**
   (the itinerary of humanized steps), store it, and show it read-only. Then run it.

## Hard guardrails (from the operator)

- **Never delete the existing old.reddit posting mechanism.** It stays as a
  working fallback. A `POST_SURFACE = old | new` flag toggles between them; if new
  reddit fails, flip back to `old` with zero code change.
- The Reddit micro-interactions must be a **reusable library** — built once, used
  by both the posting approach-flow AND (later) warm-up execution. No reinventing
  the wheel when warm-up gets wired.
- Plan before building; build in phases, spike the hardest part first.

## Layered architecture (the reuse design)

```
Layer A  Plan / vocabulary   (apps/web .../warmup.ts + a new approach-action type)
         Pure data. Action types, dwell/jitter ranges, plan composition.
         A plan is a JSON itinerary of steps. Shared web+agent (as data).

Layer B  Interaction primitives   (apps/poster-agent/reddit/*)   ← reusable bricks
         One small human-timed fn per micro-interaction on NEW reddit:
         openSubreddit, scrollFeed, openPost, readDwell, expandComments,
         searchKeyword, findOrNavigateTarget, typeAndSubmitComment, ...
         Warm-up will call these SAME functions.

Layer C  Plan executor   (apps/poster-agent/reddit/executor.mjs)   ← shared driver
         runPlan(page, plan, ctx): walks any itinerary, dispatches each step to
         its Layer-B primitive via a registry, applies dwell+gap+jitter, enforces
         a per-step timeout + graceful abort (fail cleanly, never post if broken).
         Posting AND warm-up both call runPlan — they differ only in the plan.

Layer D  Flows   (thin)
         Posting: compose approach plan → runPlan (terminal step posts).
         Warm-up (later): compose warm-up plan → the SAME runPlan.
```

The seam that makes warm-up nearly free later is the **action-type contract**
(the type string + its params), defined once in Layer A and implemented once in
Layer B. Warm-up execution = "compose a warm-up plan → runPlan." No new
interaction code.

## Fallback / rollback

- `POST_SURFACE`: env default (`old`) + live override on `agents/control.postSurface`
  (re-read each poll, same pattern as `dryRun`) so it can flip without a restart.
- `old` → existing `postComment()` in `index.mjs`, untouched.
- `new` → Layer-B `typeAndSubmitComment` run via `runPlan`.
- The browse primitives are new-reddit-only (warm-up will also use new reddit).
- Dry-run still applies on both surfaces (type but don't submit).

## Reaching the target post (decision: browse-find, else direct-nav)

Drafts can sit queued for days, so the target is often not "new" — scrolling to
find it is unreliable. So: do the browse **theater** (subreddit, scroll, maybe an
unrelated post, read), then reach the target by **attempting to browse-find it
within a short budget, falling back to direct navigation** to the thread URL.
The theater builds the footprint; arrival is guaranteed by the fallback.

## Maintenance reality

new reddit's obfuscated markup will drift and break selectors. ALL fragile
selectors live in Layer B, one place, clearly labeled, so repairs are localized
and cheap. Budget recurring upkeep.

---

## Phase checklist

- [x] **Phase 0 — Surface flag + Layer B/C scaffolding.** `POST_SURFACE` flag
      (env + control doc). New `apps/poster-agent/reddit/` module: `helpers.mjs`
      (shared low-level), `executor.mjs` (`runPlan`), `actions.mjs` (registry).
      Old path untouched & default.
- [x] **Phase 1 (spike) — Post ONE comment on new reddit. DONE — posted live
      2026-07-29.** `typeAndSubmitComment`: navigate/verify thread, verify
      logged-in user, open the contenteditable composer (shadow-DOM pierce), type,
      submit, confirm + capture permalink. First live run posted on the first
      attempt and captured the permalink — see run 8. The load-bearing unknown of
      the whole new-reddit move is now closed.
- [x] **Phase 2 — Browse primitives.** `apps/poster-agent/reddit/browse.mjs`:
      `open_home` (land on the feed and browse it), `search_subreddit` (reach the
      sub through the header search; auto-falls back to a direct visit),
      `open_subreddit` (direct visit, +sort), `scroll_feed`, `find_target`
      (browse-find → direct-nav fallback, bounded by BOTH a scroll count and a
      120s clock), `read_post` (dwell ≤120s), `skim_comments` (~65% of runs).
      Registered in `actions.mjs`; composed by `composeApproachPlan()` in
      `reddit/plan.mjs`. Validated live in dry-run — see runs 5 and 6. Still to
      come: `expand_comments`, `upvote_post`, `upvote_comment`, `idle`.

### The approach flow

```
open_home → search_subreddit → scroll_feed → find_target → read_post
          → [skim_comments, ~65%] → post_comment
```

A session always starts on the **home feed** and reaches the subreddit **through
search** — it never teleports to a subreddit or thread URL. Direct navigation
survives only as an automatic fallback: to the subreddit if search fails, to the
thread if the post can't be found in the feed within budget.

### Reaching the subreddit — three routes, not one path

`search_subreddit` takes a `via` param, rolled in the plan:

| Route | Weight | What it does |
|---|---|---|
| `typeahead` | 40% | Types the name, clicks the community straight out of the suggestions dropdown. Never presses Enter. Fastest (~17s) and the most natural. |
| `communities` | 40% | Types, Enter, then switches the results tab to **Communities** and picks it there. The reliable route for a small sub. |
| `posts` | 20% | Types, Enter, spots the community in the ordinary post results. |

If the chosen route doesn't land, the primitive **falls through the other two,
then to a direct visit** — a small sub can be absent from the typeahead *and* from
post results, so degrading beats failing. Every route verifies it actually landed
on the right subreddit before returning.

Match the community link **exactly** (`a[href="/r/<sub>/"]`). Verified live: a
posts-results page for "personalfinance" lists **r/UKPersonalFinance first**, so a
loose `href*=` match lands on the wrong community.

### Reading comments — bounded by count, never by "scroll until time is up"

`skim_comments` takes `comments: 1-13` (rolled in the plan) and walks to comment
#1, #2, … #N, dwelling at each. `min(wanted, available)` — a short thread is read
in full.

This replaced blind pixel-scrolling, which had two failure modes the operator
caught: on a big thread it just kept scrolling, and on any thread it eventually
**bottomed out in Reddit's empty footer and parked there**. Sitting in dead space
below the last comment is a tell.

Also fixed at the helper level: `readableScrollLimit(page)` returns the bottom of
the last comment (or the post) held a little short of the true page bottom, and
`humanDwell`/`humanScroll` accept it as `maxY`. Measured on a live thread: reading
2 of 7 comments ends **2089px** short of the bottom; reading all 7 ends 76px short.

> **Thread pages only.** Never apply the ceiling to a feed — an infinite feed only
> loads more posts as you approach the bottom of what's rendered, so clamping there
> would stop `find_target` from ever reaching new posts.

### Voting

```
POST     <shreddit-post> #shadow-root
           → button[upvote][data-action-bar-action="upvote"]     (32x32)
COMMENT  <shreddit-comment> → <shreddit-comment-action-row> #shadow-root
           → button[upvote]                                      (32x32)
```

- **`aria-pressed` carries the current vote state.** Clicking an already-upvoted
  button REMOVES the vote, so both primitives check it first and skip if it reads
  `"true"`. An unconditional click would silently un-upvote things the account had
  already voted on.
- **The comment action row is lazy** — `div[slot="actionRow"]` stays empty until a
  `faceplate-loader` fills it, triggered by the comment being scrolled into view.
  So `upvote_comment` must bring its target on screen before the button exists.
- **Comment choice is "already popular".** Top-level comments only (`depth="0"`,
  score on the `score` attribute), filtered to `score >= minScore` (2) AND at or
  above the median of the candidates, then a random pick from the top 3. Being the
  lone upvoter on a dead comment is a pattern; piling onto a popular one is not.
- **Upvoting never fails a job.** Both primitives swallow their own errors and
  return `{ skipped: true }` — a drifted selector loses a nice-to-have, it does not
  lose a queued post.
- Frequency: ~20% post, ~20% comment. The post upvote lands either side of
  `skim_comments` (50/50) so the vote isn't always at the same point in the
  sequence; the comment upvote always comes after, since that's when you'd have
  read one worth upvoting.
- **Dry-run detects but never clicks.** A vote is a real, visible action, so
  `DRY_RUN` logs what it *would* upvote and stops.

### The "Reload site? Changes you made may not be saved." dialog

Two independent fixes, because the risk and the cause are different things.

**Cause removed:** a dry run types but never submits, so it used to leave the
composer dirty — Reddit then kept the draft (the next run logged "clearing N
leftover chars") and the page stayed armed with a `beforeunload` handler.
`post_comment` now clears the editor at the end of a dry run, so the tab is handed
back clean. Verified: composer reads **0 chars** afterwards.

**Risk closed:** `autoHandleDialogs(page)` is registered on every page the agent
drives. **Puppeteer does NOT dismiss dialogs for you** — `CdpPage.#onDialog` only
emits the `dialog` event, so with no listener a dialog stays open and the tab is
wedged until a human clicks it. The handler accepts `beforeunload` (= the blue
Leave/Reload button) and dismisses anything else, since cancelling is the
conservative answer to a prompt we didn't expect.

> Worth recording: the dialog could NOT be reproduced from automation. With a
> 248-char dirty composer, all five navigation paths went straight through — CDP
> `goto`, CDP `reload`, in-page `location.reload()`, in-page `location.href`, and a
> real synthesized click on a link. Chrome appears to suppress it for
> automation-driven navigation. So this was never blocking the agent (every dry run
> navigated away from a dirty composer fine); it blocks a HUMAN driving the
> AdsPower window by hand. The handler is insurance against a Chrome/Reddit change,
> not a fix for an observed agent failure.

### Pacing — one knob

`HUMAN_PAUSE_MAX_SEC` (default **13**, in `helpers.mjs`) sets the range for every
"how long before the next thing" pause: between plan steps, between scroll bursts,
before clicking a spotted post, while looking at the search typeahead.

**The draw is SKEWED, not uniform** — this matters more than the max. A flat
`0..13` sounds human but makes the *typical* pause ~6.5s, because 11-13s is as
likely as 0-2s. With ~21 pause sites in a run that alone added ~2¼ minutes, and
"always about six seconds" is its own regularity. The bands (fractions of the max,
so the shape survives retuning):

| Weight | Band (at max=13) | Reads as |
|---|---|---|
| 55% | 0.0-2.0s | already decided, just acting |
| 30% | 2.0-6.0s | a beat |
| 15% | 6.0-13s | something caught the eye |

Measured over 200k draws: **mean 3.14s, median 1.8s, 90th percentile 8.3s**, full
range still reachable. Versus uniform's mean 6.49s — about **70s saved per run**.

It is deliberately NOT applied between individual scroll increments inside a burst
(nobody waits 13s between two flicks of the wheel); those stay sub-second, and the
pause lands after the burst. Raising this knob lengthens jobs roughly linearly —
`find_target`'s 120s clock exists so the hunt can't outrun the executor's per-step
timeout when the pauses roll high.
- [x] **Phase 3 — Approach plan + display. DONE.**
      `apps/web/src/modules/reddit/approach.ts` is now **the source of truth** for
      the approach vocabulary and `composeApproachPlan()` — pure and side-effect
      free, like `warmup.ts`, so it runs server-side at enqueue and in the browser
      for display. `enqueuePostJob()` composes the plan and freezes it onto the job
      as `approachPlan`; `ApproachPlanView` renders it read-only behind an
      "Approach" button on a queued/posting reply. The agent honours
      `job.approachPlan` verbatim; its own `reddit/plan.mjs` is now only the
      fallback for jobs queued before this existed.
      The vocabularies stay **separate from warm-up on purpose**: `find_target` and
      `post_comment` mean "we are here to post a specific reply", which must never
      leak into a warm-up plan whose whole point is that it posts nothing.
      **EVERY random decision is resolved into a concrete param at composition
      time**, so the stored plan is the whole story and the display needs no
      runtime guesswork —

      | Decision | Param |
      |---|---|
      | which search route | `search_subreddit.via` |
      | feed sort | `search_subreddit.sort` |
      | scroll bursts (home / sub) | `open_home.bursts`, `scroll_feed.bursts` |
      | hunt budget | `find_target.maxScrolls`, `.maxSeconds` |
      | reading time | `read_post.seconds` |
      | how many comments | `skim_comments.comments`, `.seconds` |
      | which optional steps, and in what order | presence + position of `skim_comments` / `upvote_post` / `upvote_comment` |
      | every hesitation | `gapAfterSec` on each step |

      The only things left to runtime are facts the plan cannot know: how many
      comments the thread actually has, whether the post is findable in the feed,
      and whether something is already upvoted.

      The plan is deliberately **not editable**. Its value is being generated fresh
      and differently each time; hand-tuning would pull every account back onto the
      same path, which is the pattern the whole design exists to avoid.

      **Where to see it.** Two places, same component (`ApproachPlanView`):
      - **Opportunities** — behind an "Approach" button on a queued/posting reply
        (what it's *about* to do), and on posted/failed/cancelled ones (what it
        did). Note a posted draft usually leaves the review queue, which is why
        the Dashboard is the real home for history.
      - **Account Dashboard → Activity through the tool → Recent** — an "Approach"
        button next to "Read" on every job. This is where you audit an account's
        footprint rather than review a draft.

      **Presentation.** A timeline: one icon medallion per action, threaded by a
      connecting line, with a status ring once it has run (green ✓ done, grey −
      skipped, red ✕ failed) and the real elapsed time per step. Detail lines carry
      only the concrete numbers this run rolled — a step whose label already says
      everything (an upvote is just an upvote) shows no second line.

      **"May change" flags.** Some of a plan is a decision (how long to read, how
      many bursts to scroll) and some is an INTENTION that reality can overrule.
      Those steps carry a `may change` chip and a one-line reason —
      `approachStepCaveat()` — so the plan never reads as a guarantee:

      | Step | Why it may change |
      |---|---|
      | `search_subreddit` | route can miss → tries the other two, then direct |
      | `find_target` | post may not be in the feed → opens the thread directly |
      | `skim_comments` | reads fewer if the thread has fewer |
      | `upvote_post` / `upvote_comment` | skipped if already upvoted / none qualify |

      The chips disappear once the job has run — by then the trace says what
      actually happened, so a caveat would just be noise.

      **Plan + trace = the reply's permanent history.** The plan says what was
      intended; the agent writes back `approachTrace` saying what actually
      happened, on success AND on failure. Both live on the job document, which
      nothing deletes — so a posted comment keeps its whole story, and a failed one
      shows exactly how far it got. `runPlan` collects the trace and attaches it to
      the thrown error on failure precisely so the partial record survives.

      This matters because intent and reality diverge in normal operation: the
      chosen search route may miss and recover via another, the post may not be
      findable in the feed and get reached directly, an upvote may be skipped
      because the account had already upvoted. The trace records which:

      | Recorded | Where it comes from |
      |---|---|
      | which search route actually landed | `via` on `search_subreddit` |
      | browsed to the post vs went directly, and after how many scrolls | `via` + `scrolls` on `find_target` |
      | comments actually read, of how many | `read` / `available` |
      | whether a vote registered, or was already in place | `upvoted` / `skipped` + `reason` |
      | characters typed, and whether they matched the draft | `landed` / `exact` |
      | seconds each step really took | `elapsedSec` |
- [ ] **Phase 4 (later) — Warm-up execution** reuses Layer B/C as-is.

## Deferred / later

- [x] **Exact wrong-account check on new reddit.** ~~Needs the opened-drawer
      markup.~~ SOLVED without opening the drawer: several current-user Shreddit
      components carry the handle as a light-DOM attribute —
      `after-login-toast-dispatcher[username]`, `achievements-entrypoint[username]`,
      `community-author-flair[username]` — and `shreddit-app[user-logged-in]` is
      the authoritative logged-in flag. Reads "Derek-Coker" correctly (run 4).
      Mismatch hard-aborts live, warns in dry-run, as before.

## Layout reference — the subreddit feed (mapped live, run 5)

```
<shreddit-post id="t3_<postId>" permalink="/r/…" post-title="…" feedindex="N"
               comment-count score author subreddit-name created-timestamp>
  ├─ a[slot="full-post-link"]              (whole card, 732x270)
  └─ a[slot="title"]#post-title-t3_<id>    (700x24)   ← what a person clicks
```

- The target post is found by **exact id** (`t3_<redditPostId>`) — no title matching.
- **The feed is virtualized**: cards are dropped from the DOM once scrolled well
  past (27 → 24 posts; the first card was gone after 6 screens). The target check
  must therefore run after EVERY scroll burst, not once at the end.
- **Rendered ≠ reached**: Reddit renders many screens ahead, so the card is often
  already in the DOM when you arrive. `find_target` requires it to be within ~1.5
  viewports before clicking, otherwise it keeps scrolling — else the run "finds"
  the post instantly and teleports past the whole feed.
- Sort works as a plain URL path: `/r/<sub>/`, `/r/<sub>/new/`, `/r/<sub>/top/`.
- Header search box is `textarea[name="q"]` inside `faceplate-search-input`'s
  **shadow root** — `#search-input textarea` from document can never match it.
- Comments: `shreddit-comment-tree` > `shreddit-comment[thingid][depth][author]`.

## Layout reference — the comment composer (mapped live, run 4)

```
main > comment-body-header > shreddit-async-loader
  ├── faceplate-tracker > faceplate-tracker > faceplate-textarea-input
  │      #shadow → textarea#innerTextArea        ← DECOY. Always 0x0, never laid out.
  └── comment-composer-host                      ← the REAL composer
        ├── faceplate-tracker > faceplate-textarea-input
        │      #shadow → textarea#innerTextArea  ← COLLAPSED box (the visible one)
        └── faceplate-form > shreddit-composer[event-source="comment_composer"]
              ├── div[slot="rte"][contenteditable][data-lexical-editor]  ← EXPANDED editor
              └── button#comment-composer-submit-button
```

Two rules this layout imposes on every future primitive:

1. **Deep queries must filter on visibility.** The decoy sits earlier in BFS order,
   so a first-match query returns a node with no box. `deepQueryHandle` is now
   visible-only by default (`{ visibleOnly: false }` to opt out).
2. **While collapsed, `shreddit-composer`, the rte div and the submit button all
   measure 0x0.** Clicking the collapsed textarea expands them *and* puts the caret
   straight into the Lexical div. So: click collapsed → wait for the rte to gain a
   box → type there.

## Validation log (fill in as tested on the Mac)

- **2026-07-28, run 1 (dry-run):** ✅ surface flag works, agent navigates to the
  thread on new reddit. ❌ **logged-in-user check false-aborted** — read
  "Autodesk" (a comment/post author) because the selector was page-wide
  `a[href^="/user/"]`. Fix shipped: read the header/account-button only, and make
  a mismatch a warning (not abort) in dry-run so the composer can be reached.
  STILL TO VALIDATE: whether the new header selector reads the real handle
  ("Derek-Coker"), and everything past it — **composer selectors, typing into the
  contenteditable, submit button, permalink capture.**
- **2026-07-28, run 2 (dry-run):** ✅✅ **Composer works** — the box is a real
  `<textarea id="innerTextArea">` in an OPEN faceplate shadow root; deep-shadow
  query finds it, focus + type lands text. Full dry-run flow completed. Two fixes
  from this run: (a) fast keystrokes dropped ~4% of chars (550→527) into the
  React-controlled textarea → now set the exact value via the native setter +
  input event after typing, so content is letter-perfect; (b) the logged-in-user
  read returned nothing ("could not read the logged-in user") — **header/account
  selector still wrong; need the account-button markup.** STILL TO VALIDATE:
  submit button + permalink capture (live only).
- **2026-07-28, run 3 (dry-run):** doubled comment (1078 chars). Root cause: the
  expanded box is a **Lexical rich editor** (ignores value/textContent writes),
  and the reused AdsPower tab kept the prior run's text. Fixes: always load the
  thread fresh, clear (select-all + Backspace), insert exact text via CDP
  `Input.insertText` (Lexical-safe, drop-free), submit = enabled "Comment" button
  by text. STILL NEED: account-button markup (logged-in-user check returns
  nothing); submit + permalink capture are live-only, unvalidated.
- **2026-07-28, run 4 — hard wall, then diagnosed and fixed.** The run wedged with
  six identical `focus try N: no usable boundingBox (null)` lines and aborted.
  **Root cause (confirmed by dumping the live DOM, not guessed): the thread page
  carries TWO "Join the conversation" textareas** — a 0x0 decoy under a stray
  `faceplate-tracker` chain, and the real one under `comment-composer-host`. The
  BFS deep query returned the decoy (it comes first), so `boundingBox()` was null
  on every attempt and the click loop never fired a single click. Compounding it:
  the code measured `shreddit-composer`, which is *also* 0x0 until expanded.
  Fixes shipped:
  - `deepQueryHandle` is **visible-only by default** (rect > 4px, not
    hidden/display:none/transparent) — the decoy can never be selected again.
    New `waitForDeepVisible` polls for a component that only gains a box on
    interaction.
  - Geometry is measured **in-page via `getBoundingClientRect()`**
    (`elementRect`/`humanClickHandle`), never Puppeteer's `boundingBox()`, whose
    CDP box model returns null for slotted/shadow-hosted nodes.
  - Focus checks pierce shadow roots (`deepActiveElement`) — with the caret in the
    collapsed textarea `document.activeElement` is only the
    `faceplate-textarea-input` host, which the old check read as "not focused".
  - Explicit collapsed → expanded flow, then type into the Lexical div.
  - Newlines are keystrokes now, not characters: blank line = `Enter` (new block),
    single newline = `Shift+Enter` (soft break).
  - Post-typing **letter-perfect verification**; on mismatch it clears and
    re-inserts exactly via CDP `Input.insertText`, and a still-mismatched box
    hard-aborts rather than posting corrupted text.
  - Step timeout 150s → 300s (typing 1006 chars at human speed takes ~100s).
  - Submit button query is visibility-filtered too (it is 0x0 while collapsed) and
    clicked with real measured-coordinate mouse events.
  **Verified live (dry-run, full primitive through `runPlan`):** logged-in user
  read `Derek-Coker` ✅, collapsed box clicked at (515,478) ✅, caret landed in the
  Lexical div ✅, **1006/1006 chars, exact match** ✅, no repair pass needed, 104s.
  STILL LIVE-ONLY / UNVALIDATED: the submit click and permalink capture. The
  button is confirmed present, enabled and clickable once expanded
  (`#comment-composer-submit-button`, 77x32 at the composer's bottom-right); what
  remains untested is the create-comment response shape the permalink regex scans.
- **2026-07-28, run 5 (dry-run) — Phase 2 approach flow, all arrival paths green.**
  Plan: `open_subreddit → scroll_feed → find_target → read_post → skim_comments →
  post_comment`. Validated separately:
  - **browse-find → click:** landed on `/r/povertyfinance/new/`, scrolled, found
    `t3_1v8pap2` at feedindex 19 after 3 scrolls, clicked the title, arrived on the
    thread, read, skimmed comments, scrolled back up, typed 682/682 exact. ✅
  - **budget spent with the card in reach:** clicks anyway rather than pointlessly
    re-navigating to a page it can already see. ✅
  - **not found → direct-nav fallback:** r/budget `/new/` with a 3-scroll budget on
    an older thread → fell back and landed on the thread in 13s. ✅
  - **search-box variant:** first attempt fell back (the selector assumed light
    DOM again — the box is `textarea[name="q"]` inside a shadow root); fixed, now
    lands on the subreddit in ~38s. ✅
  Two things this run taught us, both now handled in code:
  1. **Reddit persists the composer draft across reloads.** A later run logged
     `clearing 682 leftover chars` — the clear-before-typing guard caught the
     previous run's text and still produced an exact match. This is the
     doubled-comment failure mode from run 3, caught in the wild.
  2. **Rendered ≠ reached.** The first build clicked the card the moment it existed
     in the DOM (feedindex 19, "after 0 scrolls"), skipping the entire feed. The
     proximity gate now forces genuine scrolling first.
  `ensureOnThread` no longer reloads when we're already on the thread — reloading
  would have thrown away the browsing footprint the whole phase exists to build.
  `STALE_POSTING_MS` raised 10m → 20m: a humanized job legitimately runs 4-7
  minutes, and reclaiming a live job would mark a real post failed.
  **Measured wall-clock, full plan with default randomness: 229s (~3.8 min)** —
  open 8s, browse 11s, hunt 7s, read 76s, skim ~45s, type 69s (682 chars), plus
  inter-step gaps. Plan distribution over 400 samples: 23% arrive via search, 65%
  skim comments, sort 61% hot / 20% new / 20% top, read dwell 25-94s.
  STILL LIVE-ONLY: submit + permalink capture (unchanged from run 4). *(Superseded
  by run 6: `open_subreddit` is no longer the entry step.)*
- **2026-07-28, run 6 (dry-run) — home-feed-first flow + operator pacing knob.**
  Operator feedback on run 5: every session began by landing on the subreddit,
  which reads as teleporting; and the pauses needed to be randomized on one
  configurable range. Both shipped — `open_home` + `search_subreddit` replaced the
  direct-visit default, and `HUMAN_PAUSE_MAX_SEC` (0-13s) now drives every
  inter-step and inter-burst pause. Full live dry-run, all seven steps green:
  home feed 47s (3 bursts) → search landed on r/povertyfinance via the results
  page 50s → feed browse 28s → found `t3_1v8pap2` at feedindex 22 after 4 scrolls
  37s → read 58s → skim 44s → typed **682/682 exact** 71s. **Total 361s (~6 min)**,
  up from 229s — the pacing knob is the whole difference, and it is the intended
  trade. `find_target` gained a 120s clock alongside its scroll budget, because
  with pauses up to 13s a scroll count no longer bounds the hunt's duration.
  STILL LIVE-ONLY: submit + permalink capture (unchanged from run 4).
- **2026-07-28, run 7 (dry-run) — upvoting.** `upvote_post` + `upvote_comment`
  added (~20% each). Full nine-step run green in **329s**: home feed → search →
  feed browse → found the post at feedindex 21 after 4 scrolls → read 85s → skim
  19s → upvote_post (detected, dry-run held the click) → upvote_comment (chose
  `t1_p07tsm2`, score 4, from 3 well-upvoted candidates, top was 12 — correctly
  ignored the score-1 comments) → typed **380/380 exact**.
  Three bugs this run caught, all fixed:
  1. **`deepQueryWithin` missed a host's OWN shadow root** — it seeded the walk
     with the element and only enqueued *descendants'* shadow roots. The post's
     vote button lives directly in `shreddit-post`'s own shadow root, so
     `upvote_post` reported "no upvote button found" for a button that provably
     existed. (`upvote_comment` worked by luck: its button is one level deeper.)
  2. **`find_target` could "find" the post without a feed.** Its loose
     `a[href*="/comments/<id>/"]` fallback also matched permalinks on the thread
     page itself. Now scoped to `shreddit-post[id=…]` only.
  3. **`||` defaults ate legitimate zeros** — `maxScrolls: 0` silently became 12,
     and `bursts: 0` became random. Six params switched to `??`.
- **2026-07-29, run 8 — 🎉 FIRST LIVE POST. Phase 1 closed.** Real job, live (not
  dry-run), r/budget. Plan rolled `open_home → search_subreddit → scroll_feed →
  find_target → read_post → post_comment` (no optional steps — a ~24% shape).
  Found the target at feedindex 2 with 0 scrolls, typed **930/930 exact**,
  `submitting…` → **POSTED** 7s later, permalink captured:
  `https://www.reddit.com/r/budget/comments/1v9nmng/comment/p0fl386/`.
  Total 325s. **Both previously-unvalidated pieces — the submit click and the
  permalink capture — worked on the first attempt.**
  Note: no upvote appeared because the plan didn't roll one (20%/20%), not because
  anything failed; `skim_comments` didn't roll either (65%).
- **2026-07-29 — pacing retuned to the skewed distribution** (operator: "sometimes
  0, sometimes 3, sometimes 13 — it takes too long every time"). The uniform draw
  was doing exactly what it said, but its mean was 6.5s across ~21 pause sites.
  Now 55/30/15 weighted toward short — mean 3.14s, median 1.8s. Expected run
  ~4.3 min, down from ~5.4. Step gaps in a composed plan now read like
  `8.8s / 1.5s / 3.9s / 8.3s / 1.8s / 0.2s` instead of clustering near 6.
  NOT changed (separate knobs, still the largest single blocks): `read_post`
  `rand(25,95)` then ±25% jitter in `humanDwell`, and `skim_comments` `rand(15,55)`.
- **2026-07-29, run 9 — second live post, with both upvotes.** `FORCE_UPVOTES=1`
  (one-shot test switch, since removed) forced both vote steps. Nine steps,
  r/personalfinance: home feed → search → feed → **11 scrolls to reach feedindex
  32** → read 91s → skim 45s → `upvote_post: upvoted.` → `upvote_comment: chose
  t1_p0dzub7 (score 4, from 3 candidates, top was 5)` → `upvoted.` → typed
  **807/807 exact** → POSTED `…/comment/p0fna8z/`. Both votes verified by
  `aria-pressed` flipping to `true`. Total 402s.
- **2026-07-29, run 10 (dry-run) — three operator findings fixed.**
  1. **Search took only one path.** It always picked the community out of the post
     results, ignoring the typeahead suggestion and the Communities tab (and a
     small sub may appear in neither). Now three routes rolled in the plan, each
     falling through to the others then to a direct visit. All three verified live:
     typeahead **17s**, Communities tab **47s**, posts results **37s**, each
     landing on `/r/personalfinance/`.
  2. **Comment reading was unbounded.** `skim_comments` scrolled for N seconds
     regardless of thread size. Now it reads a plan-rolled **1-13 comments**,
     clamped to what exists — verified: asked 13 on a 7-comment thread → read 7;
     asked 2 → read 2.
  3. **It rode to the very bottom every time**, parking in the empty footer below
     the last comment. Fixed with `readableScrollLimit` + `maxY` bounds on
     `humanDwell`/`humanScroll` — reading 2 of 7 comments now ends **2089px**
     short of the bottom, all 7 ends 76px short. Deliberately NOT applied to feeds
     (it would break infinite-scroll loading during the hunt).
- **2026-07-29, run 11 (dry-run) — Phase 3 end-to-end: web-composed plan, agent
  execution.** A plan generated by `apps/web/src/modules/reddit/approach.ts` (the
  exact JSON that now gets stored on the job) was handed to the agent's `runPlan`
  verbatim. Every param was honoured: `via:"communities"` took the Communities-tab
  route, `maxScrolls:11` found the post at feedindex 34 after 9 scrolls,
  `seconds:38` read for 38s, `comments:4` read 4 of the 7 available, and
  `post_comment` with EMPTY params correctly fell back to the job's own body
  (194/194 exact). **Actual 262s against the display's 268s estimate.**
  Confirms the two halves agree on the contract with no adapter in between.
