// Layer A (agent-side) — the FALLBACK approach-plan composer.
//
// ⚠️  NOT THE SOURCE OF TRUTH. Since Phase 3, plans are composed by the web app at
// enqueue time and stored on the job:
//
//        apps/web/src/modules/reddit/approach.ts   ← edit THAT for behaviour changes
//
// The agent uses this file only when a job arrives with no `approachPlan` — jobs
// queued before Phase 3, or written by some other path. Keep the two in rough
// sync, but if they disagree, the web app wins for anything queued normally.
//
// A plan is a plain JSON itinerary: [{ type, params, gapAfterSec, jitterPct }].
// The executor walks it; the primitives in actions.mjs perform it. Nothing here
// touches the browser, so it stays pure and testable. Keep it
// deterministic-once-generated: every timing is concretely randomized HERE, not
// left as a range for the primitives to reinterpret.

import { rand, pauseSec } from './helpers.mjs';
import { subredditFromUrl } from './browse.mjs';

const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** The gap between two steps — drawn from the SAME skewed human pause used inside
 *  the primitives, so pacing is consistent everywhere and one knob retunes all of
 *  it. jitterPct is 0 on these: the value is already random, and letting the
 *  executor jitter it again would push gaps outside the configured range.
 *  Rounded to 0.1s so a stored plan reads cleanly (Phase 3 displays these). */
const gap = () => Math.round(pauseSec() * 10) / 10;

/**
 * The humanized approach to a single comment:
 *   land on the HOME FEED → browse it → search out the subreddit → browse that
 *   → hunt for the post by scrolling (bounded; direct-nav fallback) → read it
 *   → usually skim the comments → scroll back up → comment.
 *
 * The session always starts on the feed like a real visit; the subreddit is
 * reached through search, never by teleporting to its URL. A direct visit only
 * happens automatically if search fails.
 */
export function composeApproachPlan(job) {
  const subreddit = job.subreddit || subredditFromUrl(job.threadUrl);
  // Mostly Hot (what search lands you on), sometimes New/Top — a person varies.
  const sort = pick(['hot', 'hot', 'hot', 'new', 'top']);

  const plan = [
    {
      type: 'open_home',
      params: { bursts: rand(2, 5) }, // time on the feed before searching
      gapAfterSec: gap(),
      jitterPct: 0,
    },
    {
      type: 'search_subreddit',
      // Which route through search this session takes. Not one fixed path: a real
      // account sometimes picks the community out of the typeahead, sometimes
      // searches and switches to the Communities tab, sometimes spots it in the
      // post results. The primitive falls back through the others if this one
      // doesn't land (small subs surface in some places and not others).
      params: { subreddit, sort, via: pick(['typeahead', 'typeahead', 'communities', 'communities', 'posts']) },
      gapAfterSec: gap(),
      jitterPct: 0,
    },
    {
      type: 'scroll_feed',
      params: { bursts: rand(1, 3) },
      gapAfterSec: gap(),
      jitterPct: 0,
    },
    {
      type: 'find_target',
      params: {
        subreddit,
        redditPostId: job.redditPostId,
        threadUrl: job.threadUrl,
        // Queued drafts are often days old, so this frequently ends in the
        // direct-nav fallback — that is expected, not a failure.
        maxScrolls: rand(8, 14),
        maxSeconds: 120, // hard bound on the hunt, whatever the pauses roll
      },
      gapAfterSec: gap(),
      jitterPct: 0,
    },
    {
      type: 'read_post',
      params: { seconds: rand(25, 95) }, // humanDwell hard-caps at 120s
      gapAfterSec: gap(),
      jitterPct: 0,
    },
  ];

  // What happens between finishing the post and starting to type varies:
  //  - ~65% of the time you skim the comments first
  //  - ~20% you upvote the post — landing either side of that skim, so the vote
  //    isn't always in the same place in the sequence
  //  - ~20% you upvote a comment (always after the skim, since that's when you'd
  //    have read one worth upvoting)
  const skims = chance(0.65);
  const upvotesPost = chance(0.2);
  const upvotesComment = chance(0.2);
  const upvoteBeforeSkim = upvotesPost && chance(0.5);

  if (upvoteBeforeSkim) {
    plan.push({ type: 'upvote_post', params: {}, gapAfterSec: gap(), jitterPct: 0 });
  }
  if (skims) {
    // HOW MANY comments get read, decided here so the itinerary states it up
    // front. Without a count the skim just scrolled until time ran out, which on a
    // thousand-comment thread meant scrolling forever and ending up parked in the
    // page footer. A thread with fewer comments than this is simply read in full.
    plan.push({ type: 'skim_comments', params: { seconds: rand(15, 55), comments: rand(1, 13) }, gapAfterSec: gap(), jitterPct: 0 });
  }
  if (upvotesPost && !upvoteBeforeSkim) {
    plan.push({ type: 'upvote_post', params: {}, gapAfterSec: gap(), jitterPct: 0 });
  }
  if (upvotesComment) {
    // Only ever upvotes an already-well-upvoted comment — see upvoteComment().
    plan.push({ type: 'upvote_comment', params: { minScore: 2, topN: 3 }, gapAfterSec: gap(), jitterPct: 0 });
  }

  plan.push({ type: 'post_comment', params: { body: job.body }, gapAfterSec: 0, jitterPct: 0 });
  return plan;
}

/** One-line human summary of a plan, for the agent log. */
export function describePlan(plan) {
  return plan.map((s) => s.type).join(' → ');
}
