# New-Reddit posting + humanized approach flow — design & build plan

> Living design doc. Update the phase checklist as we build. For the "why", this
> supersedes the handoff's "Posting drives old.reddit.com" section **only once
> Phase 1 is validated live** — until then old.reddit stays the default.

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
- [~] **Phase 1 (spike) — Post ONE comment on new reddit.** `typeAndSubmitComment`
      primitive: navigate/verify thread, verify logged-in user, open the
      contenteditable composer (shadow-DOM pierce), type, submit, confirm +
      capture permalink via GraphQL-response intercept. Wired so `POST_SURFACE=new`
      posts via `runPlan([post_comment])`. **CODE COMPLETE — needs live validation
      on the Mac (dry-run → one live warming reply).** If it can't post reliably,
      STOP and reassess before Phase 2.
- [ ] **Phase 2 — Browse primitives.** searchKeyword, openSubreddit(+sort),
      scrollFeed, openPost, readDwell (≤120s), expandComments,
      findOrNavigateTarget (browse-find → direct-nav). Registered in `actions.mjs`.
- [ ] **Phase 3 — Approach plan + display.** `approach-action` type extends the
      warm-up vocabulary with `post_comment`/`find_target` (kept OUT of the
      warm-up vocabulary itself). `composeApproachPlan()` (deterministic, concrete
      randomized timings, optional-chance steps). Generate at `enqueuePostJob`,
      store `approachPlan` on the job, render read-only on Opportunities. Posting
      flow builds the plan → runPlan.
- [ ] **Phase 4 (later) — Warm-up execution** reuses Layer B/C as-is.

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
