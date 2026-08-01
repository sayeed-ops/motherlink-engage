// Approach plans — the humanized itinerary an account follows to post one reply.
//
// A plan is a plain JSON list of steps: land on the home feed, search out the
// subreddit, browse it, hunt for the post, read it, maybe skim the comments, maybe
// upvote, then comment. The local poster agent walks this list; every step maps to
// an interaction primitive in `apps/poster-agent/reddit/browse.mjs`.
//
// THIS FILE IS THE SOURCE OF TRUTH for what a plan looks like. It is deliberately
// PURE and side-effect free (no 'server-only', no Firestore, no fetch) so it runs
// on the server at enqueue time AND in the browser for display — the same rule
// warmup.ts follows.
//
// Relationship to warm-up (see ./warmup.ts): both are itineraries over the same
// interaction primitives, and Phase 4 will run warm-up through the same executor.
// But the vocabularies are kept SEPARATE on purpose — `find_target` and
// `post_comment` mean "we are here to post a specific reply", which must never
// leak into a warm-up plan whose whole point is that it posts nothing.
//
// Determinism matters: every random choice is resolved HERE, once, into a concrete
// param. That is what lets the plan be stored on the job and shown read-only
// before it runs — the agent re-rolls nothing.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ApproachActionType =
  | 'open_home' // land on reddit.com and browse the feed
  | 'search_subreddit' // reach the subreddit through search
  | 'open_subreddit' // direct visit (fallback route; agent may use it)
  | 'scroll_feed' // browse the subreddit feed
  | 'find_target' // hunt the target post, then open it
  | 'read_post' // dwell on the post as if reading
  | 'skim_comments' // read N comments
  | 'upvote_post' // upvote the post
  | 'upvote_comment' // upvote an already-popular comment
  | 'post_comment'; // type and submit the reply (terminal)

/** How the account gets from search to the subreddit. */
export type SearchRoute = 'typeahead' | 'communities' | 'posts';

export type FeedSort = 'hot' | 'new' | 'top';

export interface ApproachStep {
  type: ApproachActionType;
  /** Concrete, already-randomised parameters for this step. */
  params: Record<string, string | number | boolean>;
  /** Pause AFTER this step before the next, seconds. Already randomised. */
  gapAfterSec: number;
  /** Extra ± randomisation at run time (0–100). Zero here: the values above are
   *  already random, and re-jittering would push them outside the chosen range. */
  jitterPct: number;
}

export type ApproachPlan = ApproachStep[];

/** Steps that actually publish something. The agent treats these as terminal. */
export const TERMINAL_APPROACH_TYPES: readonly ApproachActionType[] = ['post_comment'];

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
const chance = (p: number) => Math.random() < p;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Upper bound for a "how long before the next thing" pause, seconds. Mirrors the
 *  agent's HUMAN_PAUSE_MAX_SEC default; the agent applies the same skewed shape to
 *  its own in-step pauses. */
export const PAUSE_MAX_SEC = 13;

/** The hesitation before the next step. SKEWED toward short on purpose: a flat
 *  0..13 draw makes the typical pause a middling ~6.5s, which drags across the
 *  ~20 pauses in a run and is its own kind of regularity. Mostly brief, with the
 *  occasional real distraction. */
function pauseSec(): number {
  const r = Math.random();
  const s =
    r < 0.55
      ? Math.random() * PAUSE_MAX_SEC * 0.15
      : r < 0.85
        ? PAUSE_MAX_SEC * 0.15 + Math.random() * PAUSE_MAX_SEC * 0.31
        : PAUSE_MAX_SEC * 0.46 + Math.random() * PAUSE_MAX_SEC * 0.54;
  return Math.round(s * 10) / 10;
}

export interface ComposeApproachInput {
  subreddit: string;
  redditPostId: string;
  threadUrl: string;
}

/**
 * Build the itinerary for one reply.
 *
 * The shape varies run to run — which search route, how long it reads, how many
 * comments it skims, whether it upvotes and where in the sequence — so no two
 * approaches look alike. Roughly 1 in 4 plans is the bare
 * `…→ read_post → post_comment`, which is also what a hurried person does.
 */
export function composeApproachPlan(input: ComposeApproachInput): ApproachPlan {
  const { subreddit, redditPostId, threadUrl } = input;

  const plan: ApproachPlan = [
    {
      type: 'open_home',
      params: { bursts: rand(2, 5) },
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    },
    {
      type: 'search_subreddit',
      params: {
        subreddit,
        // Mostly Hot (what search lands you on), sometimes New/Top.
        sort: pick<FeedSort>(['hot', 'hot', 'hot', 'new', 'top']),
        // Not one fixed path: sometimes the community comes out of the search
        // suggestions, sometimes from the Communities tab, sometimes spotted in
        // the post results. The agent falls through the others if this one misses
        // — a small sub surfaces in some places and not others.
        via: pick<SearchRoute>(['typeahead', 'typeahead', 'communities', 'communities', 'posts']),
      },
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    },
    {
      type: 'scroll_feed',
      params: { bursts: rand(1, 3) },
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    },
    {
      type: 'find_target',
      params: {
        subreddit,
        redditPostId,
        threadUrl,
        // Queued drafts are often days old, so the hunt frequently ends in the
        // direct-navigation fallback. That is expected, not a failure.
        maxScrolls: rand(8, 14),
        maxSeconds: 120,
      },
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    },
    {
      type: 'read_post',
      params: { seconds: rand(25, 95) }, // the agent hard-caps dwell at 120s
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    },
  ];

  // What happens between finishing the post and starting to type varies:
  //  - ~65% skim the comments first
  //  - ~20% upvote the post, landing either side of that skim
  //  - ~20% upvote a comment (always after the skim — that's when you'd have read
  //    one worth upvoting). The agent only ever upvotes an ALREADY-popular one.
  const skims = chance(0.65);
  const upvotesPost = chance(0.2);
  const upvotesComment = chance(0.2);
  const upvoteBeforeSkim = upvotesPost && chance(0.5);

  if (upvoteBeforeSkim) {
    plan.push({ type: 'upvote_post', params: {}, gapAfterSec: pauseSec(), jitterPct: 0 });
  }
  if (skims) {
    plan.push({
      type: 'skim_comments',
      // HOW MANY comments, not "scroll for N seconds" — otherwise a thread with
      // thousands of comments scrolls forever. Clamped to what the thread has.
      params: { seconds: rand(15, 55), comments: rand(1, 13) },
      gapAfterSec: pauseSec(),
      jitterPct: 0,
    });
  }
  if (upvotesPost && !upvoteBeforeSkim) {
    plan.push({ type: 'upvote_post', params: {}, gapAfterSec: pauseSec(), jitterPct: 0 });
  }
  if (upvotesComment) {
    plan.push({ type: 'upvote_comment', params: { minScore: 2, topN: 3 }, gapAfterSec: pauseSec(), jitterPct: 0 });
  }

  // No body param: the agent falls back to the job's own `body`, so the reply text
  // isn't duplicated into the plan (it would double the job document and put the
  // whole comment into the read-only display).
  plan.push({ type: 'post_comment', params: {}, gapAfterSec: 0, jitterPct: 0 });
  return plan;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const APPROACH_LABELS: Record<ApproachActionType, string> = {
  open_home: 'Browse the home feed',
  search_subreddit: 'Search for the subreddit',
  open_subreddit: 'Open the subreddit',
  scroll_feed: 'Scroll the subreddit',
  find_target: 'Look for the post',
  read_post: 'Read the post',
  skim_comments: 'Read comments',
  upvote_post: 'Upvote the post',
  upvote_comment: 'Upvote a comment',
  post_comment: 'Write and post the reply',
};

const SEARCH_ROUTE_DETAIL: Record<SearchRoute, string> = {
  typeahead: 'pick it from the search suggestions',
  communities: 'search, then the Communities tab',
  posts: 'search, then spot it in the results',
};

/** The concrete detail under a step's label — the numbers this particular run
 *  rolled. Returns '' when the label already says everything (an upvote is just an
 *  upvote), so the display never prints a line that repeats its own heading.
 *  Missing params are omitted rather than rendered as '?'. */
export function describeApproachStep(step: ApproachStep): string {
  const p = step.params ?? {};
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (step.type) {
    case 'open_home': {
      const b = n(p.bursts);
      return b ? `reddit.com, ${b} scroll burst${b === 1 ? '' : 's'}` : 'reddit.com';
    }
    case 'search_subreddit': {
      const route = SEARCH_ROUTE_DETAIL[p.via as SearchRoute] ?? 'via search';
      const sort = p.sort && p.sort !== 'hot' ? `, sorted by ${p.sort}` : '';
      return `“${p.subreddit}” — ${route}${sort}`;
    }
    case 'open_subreddit':
      return `r/${p.subreddit}, directly`;
    case 'scroll_feed': {
      const b = n(p.bursts);
      return b ? `${b} scroll burst${b === 1 ? '' : 's'}` : '';
    }
    case 'find_target': {
      const s = n(p.maxScrolls);
      const t = n(p.maxSeconds);
      const budget = [s ? `${s} scrolls` : '', t ? `${t}s` : ''].filter(Boolean).join(' or ');
      return budget ? `Scroll the feed for up to ${budget}, then open it directly` : 'Scroll the feed, then open it directly';
    }
    case 'read_post': {
      const s = n(p.seconds);
      return s ? `About ${s}s` : '';
    }
    case 'skim_comments': {
      const c = n(p.comments);
      const s = n(p.seconds);
      const parts = [c ? `up to ${c} comment${c === 1 ? '' : 's'}` : '', s ? `about ${s}s` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') : '';
    }
    case 'upvote_post':
      return ''; // the label says it
    case 'upvote_comment': {
      const m = n(p.minScore);
      return `Only one that is already well-upvoted${m ? ` (${m}+ score)` : ''}`;
    }
    case 'post_comment':
      return ''; // the label says it
    default:
      return '';
  }
}

/** Why a step might not go exactly as written — '' when it will.
 *
 *  Some of the plan is a decision (how long to read, how many bursts to scroll)
 *  and some is an INTENTION that reality can overrule: a search route can miss and
 *  recover via another, a post can be absent from the feed and get reached
 *  directly, a thread can have fewer comments than we meant to read, a vote can
 *  already be in place. Saying so up front is more honest than a plan that reads
 *  like a guarantee — and the trace afterwards records what actually happened. */
export function approachStepCaveat(step: ApproachStep): string {
  switch (step.type) {
    case 'search_subreddit':
      return 'If this route doesn’t surface the community, it tries the other two, then goes directly.';
    case 'find_target':
      return 'If the post isn’t found by scrolling within the budget, it opens the thread directly.';
    case 'skim_comments':
      return 'Reads fewer if the thread has fewer — a short thread is read in full.';
    case 'upvote_post':
      return 'Skipped if this account has already upvoted the post.';
    case 'upvote_comment':
      return 'Picks an already-well-upvoted comment at run time; skipped if none qualify or it’s already upvoted.';
    default:
      return '';
  }
}

/** Rough wall-clock estimate for a whole plan, seconds. Indicative only — the
 *  agent's own in-step pauses, typing speed and page loads are not knowable here,
 *  so this deliberately errs low and is shown as "about". */
export function estimateApproachSeconds(plan: ApproachPlan): number {
  let total = 0;
  for (const step of plan) {
    const p = step.params ?? {};
    total += step.gapAfterSec || 0;
    switch (step.type) {
      case 'open_home':
        total += Number(p.bursts ?? 3) * 8;
        break;
      case 'search_subreddit':
        total += 30;
        break;
      case 'scroll_feed':
        total += Number(p.bursts ?? 2) * 8;
        break;
      case 'find_target':
        total += 30;
        break;
      case 'read_post':
        total += Number(p.seconds ?? 40);
        break;
      case 'skim_comments':
        total += Number(p.seconds ?? 30);
        break;
      case 'upvote_post':
      case 'upvote_comment':
        total += 4;
        break;
      case 'post_comment':
        total += 75; // typing a normal-length reply at human speed
        break;
      default:
        break;
    }
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// What actually happened
// ---------------------------------------------------------------------------
//
// The plan says what was INTENDED. The agent writes back a trace saying what the
// account really did — which search route landed, whether the post was found by
// browsing or reached directly, how many comments were actually there to read,
// whether an upvote was skipped because it was already upvoted. It is stored on
// the job next to the plan, on success AND on failure, so a posted reply keeps
// its full history and a failed one shows how far it got.

export interface ApproachTraceStep {
  type: ApproachActionType;
  ok: boolean;
  elapsedSec?: number;
  /** Route/means actually taken, e.g. 'browse' vs 'direct', or the search route. */
  via?: string;
  scrolls?: number;
  bursts?: number;
  read?: number;
  available?: number;
  upvoted?: boolean;
  skipped?: boolean;
  reason?: string;
  seconds?: number;
  landed?: number;
  exact?: boolean;
  dryRun?: boolean;
}

export type ApproachTrace = ApproachTraceStep[];

const VIA_DETAIL: Record<string, string> = {
  browse: 'found it in the feed',
  direct: 'went straight to it',
  search: 'reached via search',
  typeahead: 'from the search suggestions',
  communities: 'from the Communities tab',
  posts: 'from the post results',
  'direct-fallback': 'search missed — went directly',
};

/** One line of plain English for what a step actually did. Returns '' when there
 *  is nothing worth saying beyond "it ran". */
export function describeApproachOutcome(t: ApproachTraceStep): string {
  if (!t.ok) return t.reason ? `Failed — ${t.reason}` : 'Failed';
  if (t.skipped) return t.reason ? `Skipped — ${t.reason}` : 'Skipped';
  switch (t.type) {
    case 'search_subreddit':
      return VIA_DETAIL[t.via ?? ''] ?? 'Reached the subreddit';
    case 'find_target': {
      const how = VIA_DETAIL[t.via ?? ''] ?? '';
      const scrolls = typeof t.scrolls === 'number' ? ` after ${t.scrolls} scroll${t.scrolls === 1 ? '' : 's'}` : '';
      return how ? `${how[0].toUpperCase()}${how.slice(1)}${t.via === 'browse' ? scrolls : ''}` : '';
    }
    case 'skim_comments':
      return typeof t.read === 'number'
        ? `Read ${t.read} of ${t.available ?? t.read} comment${t.available === 1 ? '' : 's'} on the thread`
        : '';
    case 'upvote_post':
    case 'upvote_comment':
      if (t.dryRun) return 'Dry run — not clicked';
      return t.upvoted ? 'Upvoted' : 'Not upvoted';
    case 'post_comment':
      if (t.dryRun) return `Dry run — typed ${t.landed ?? 0} characters, not submitted`;
      return typeof t.landed === 'number'
        ? `Typed ${t.landed} characters${t.exact === false ? ' (did not match the draft)' : ''} and submitted`
        : 'Posted';
    case 'read_post':
      return typeof t.seconds === 'number' ? `Read for ${t.seconds}s` : '';
    default:
      return '';
  }
}

/** Defensive parse for a trace read back from Firestore. */
export function normalizeApproachTrace(raw: unknown): ApproachTrace {
  if (!Array.isArray(raw)) return [];
  const out: ApproachTrace = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.type !== 'string') continue;
    out.push({
      type: r.type as ApproachActionType,
      ok: r.ok !== false,
      elapsedSec: typeof r.elapsedSec === 'number' ? r.elapsedSec : undefined,
      via: typeof r.via === 'string' ? r.via : undefined,
      scrolls: typeof r.scrolls === 'number' ? r.scrolls : undefined,
      bursts: typeof r.bursts === 'number' ? r.bursts : undefined,
      read: typeof r.read === 'number' ? r.read : undefined,
      available: typeof r.available === 'number' ? r.available : undefined,
      upvoted: typeof r.upvoted === 'boolean' ? r.upvoted : undefined,
      skipped: typeof r.skipped === 'boolean' ? r.skipped : undefined,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
      seconds: typeof r.seconds === 'number' ? r.seconds : undefined,
      landed: typeof r.landed === 'number' ? r.landed : undefined,
      exact: typeof r.exact === 'boolean' ? r.exact : undefined,
      dryRun: typeof r.dryRun === 'boolean' ? r.dryRun : undefined,
    });
  }
  return out;
}

/** Defensive parse for a plan read back from Firestore — the display must never
 *  crash on an old or hand-edited job document. */
export function normalizeApproachPlan(raw: unknown): ApproachPlan {
  if (!Array.isArray(raw)) return [];
  const out: ApproachPlan = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.type !== 'string') continue;
    out.push({
      type: r.type as ApproachActionType,
      params: (r.params && typeof r.params === 'object' ? r.params : {}) as ApproachStep['params'],
      gapAfterSec: Number(r.gapAfterSec ?? 0),
      jitterPct: Number(r.jitterPct ?? 0),
    });
  }
  return out;
}
