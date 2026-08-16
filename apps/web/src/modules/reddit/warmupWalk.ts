// Warm-up browsing LOOP — a stochastic walk that composes a different, plausible
// Reddit session every time it runs.
//
// Companion to warmup.ts, not a replacement. warmup.ts builds a DAY TIMELINE out
// of fixed packages, for an operator to hand-author. This file models a SESSION
// as a walk over a graph of Reddit surfaces, where the outcome of each step
// decides the next — which is how a person actually browses, and what makes 100
// runs look like 100 different people rather than 100 copies.
//
// PURE and side-effect free (no 'server-only', no Firestore, no fetch), same rule
// as warmup.ts and approach.ts. That is what lets the simulator run it in the
// browser and the server compose with it for real.
//
// ════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THAT SHAPE THIS FILE
//
// 1. CAPABILITY-GATED. The composer may only emit actions the agent can actually
//    perform — see RUNNABLE below. This is the flaw in the package designer: it
//    can emit save_post / follow_post / join_subreddit / view_profile /
//    expand_comments / idle, none of which have a primitive, so the executor
//    silently skips them and the run still reports success. A plan from this file
//    is executable by construction. When a primitive ships, add it to RUNNABLE
//    and the walk starts using it — no other change.
//
// 2. COMPOSE-TIME, NOT RUN-TIME. runPlan() is a flat for-loop with no branching,
//    and a single mega-step would blow STEP_TIMEOUT_MS and collapse the per-step
//    trace. So the walk happens HERE and unrolls into a flat step list. That is
//    not a compromise: "the next step depends on this step" is about the walk's
//    own state (surface, depth, boredom, interest, budget), none of which needs
//    to read the live DOM.
//
// 3. ANCHORED SEGMENTS. Every segment starts with an ANCHOR — an absolute
//    navigation whose target is fully known now. A relative step that silently
//    skips can therefore derail at most the rest of its own segment, because the
//    next anchor re-establishes ground truth with a goto. Dead-end recovery is a
//    STATE IN THE GRAPH, pre-baked into the itinerary, not a run-time reaction.
// ════════════════════════════════════════════════════════════════════════════

import { PAUSE_MAX_SEC } from './approach';

// ---------------------------------------------------------------------------
// Vocabulary — the runnable subset
// ---------------------------------------------------------------------------

/** Actions this loop may emit. Every one has a registered primitive in
 *  apps/poster-agent/reddit/actions.mjs. Deliberately EXCLUDES:
 *   - find_target / post_comment — posting-only; must never leak into a warm-up
 *     whose whole point is that it posts nothing.
 *   - save_post, follow_post, join_subreddit, view_profile, expand_comments,
 *     idle — in warmup.ts's vocabulary but with no primitive behind them.
 *   - duckduckgo_search — designed, not yet built. */
export type WarmupLoopActionType =
  | 'open_feed'
  | 'open_subreddit'
  | 'search_subreddit'
  | 'search_keyword'
  | 'scroll_feed'
  | 'open_feed_post'
  | 'open_post_subreddit'
  | 'read_post'
  | 'skim_comments'
  | 'upvote_post'
  | 'upvote_comment'
  | 'join_subreddit';

/** The nav rail down the left of new reddit. `news` and `explore` are TOPIC
 *  FEEDS (/news/, /explore/), not subreddits — the earlier version faked them as
 *  r/news, which is a different page entirely. */
export type FeedTab = 'home' | 'popular' | 'news' | 'explore' | 'all';

/** ANCHOR steps are absolutely located — they navigate to a known URL and so
 *  re-establish where the browser is regardless of what came before. RELATIVE
 *  steps only mean something on the right surface. A plan is a sequence of
 *  segments and every segment opens with an anchor; that is what bounds the
 *  blast radius of a step that silently skipped. */
export const ANCHOR_TYPES: ReadonlySet<WarmupLoopActionType> = new Set([
  'open_feed',
  'open_subreddit',
  'search_subreddit',
  'search_keyword',
]);

export const WARMUP_LOOP_LABELS: Record<WarmupLoopActionType, string> = {
  open_feed: 'Open a feed',
  open_subreddit: 'Open a subreddit',
  search_subreddit: 'Search for a community',
  search_keyword: 'Search a topic',
  scroll_feed: 'Scroll the feed',
  open_feed_post: 'Open a post from the feed',
  open_post_subreddit: 'Follow the post to its community',
  read_post: 'Read the post',
  skim_comments: 'Skim the comments',
  upvote_post: 'Upvote the post',
  upvote_comment: 'Upvote a comment',
  join_subreddit: 'Join the community',
};

/** One step, in the exact shape apps/poster-agent/reddit/executor.mjs consumes.
 *  `params` must stay flat scalars — they are JSON-logged and stored on a job. */
export interface WarmupLoopStep {
  type: WarmupLoopActionType;
  params: Record<string, string | number | boolean>;
  /** Pause AFTER this step, seconds. Already randomised here. */
  gapAfterSec: number;
  /** Always 0 — the values above are already random and re-jittering at run time
   *  would push them outside the chosen range. Mirrors approach.ts. */
  jitterPct: number;
}

export type WarmupLoopPlan = WarmupLoopStep[];

// ---------------------------------------------------------------------------
// Policy — everything tunable, and the only thing an LLM may produce
// ---------------------------------------------------------------------------

export interface UpvoteCurve {
  /** Chance a day-1 session contains an upvote. */
  pMin: number;
  /** Chance a final-day session contains one. */
  pMax: number;
  /** Length of the ramp in days. The curve stretches to fit any value. */
  days: number;
  /** Logistic steepness. ~0 → linear, 6 → a gentle S, 12 → nearly a step. */
  steepness: number;
  /** Where the S-curve's midpoint sits, 0..1 across the ramp. */
  midpoint: number;
  /** Chance a session that votes at all casts a second one. */
  secondUpvoteChance: number;
  /** Share of votes that land on a COMMENT rather than the post.
   *
   *  Needs to be a deliberate split rather than a side effect of ordering. The
   *  first version voted on the post 70% of the time before comments were even
   *  considered, which produced an 87/13 skew — far more post-voting than a
   *  reader who actually goes into threads. Comment votes still only ever land on
   *  an already-well-upvoted comment (minScore/topN); being the lone upvoter on a
   *  dead comment is the pattern that avoids. */
  commentVoteShare: number;
}

/**
 * How this account accumulates communities.
 *
 * A DIFFERENT SHAPE FROM THE UPVOTE CURVE, deliberately. Votes are unlimited and
 * the question is "how bold"; joins are EXHAUSTIBLE and the question is "how fast
 * do I accumulate, out of a finite pool". So this is a rate against a pool, not a
 * probability ramp — self-limiting, needs no scheduler, and converges on its own
 * as long as sessions keep running.
 */
export interface FollowPolicy {
  /** The one number an operator reasons about. Converted to a per-session chance
   *  against SESSIONS_PER_DAY, so it rides the EXPERIENCE clock: joins accrue
   *  with sessions actually run, never with idle calendar days. */
  joinsPerWeek: number;
  /** Hard ceiling per session. Two is the cap by operator decision. */
  maxPerSession: number;
  /** An UNRELATED second join elsewhere in the session. Deliberately low — two
   *  unconnected joins in one sitting is not very human. */
  secondJoinChance: number;
  /** A second join from the SAME search results. Much higher, because finding two
   *  relevant communities in one search and joining both is coherent behaviour —
   *  it is roughly what Reddit's own onboarding produces. */
  sameSearchSecondChance: number;
  /** Returning to the results page rather than retyping the query. Retyping an
   *  identical search is the least natural way back; people hit back. The results
   *  URL is absolute, so this stays an anchor either way. */
  returnToResultsChance: number;
  /** Steps that must pass between two joins. Back-to-back joins are a pattern. */
  minStepsBetweenJoins: number;
  /** A genuinely NEW account joining several subs quickly is normal — Reddit's
   *  signup flow pushes you to pick interests. For an aged account being
   *  repurposed it is not. Off by default: it is the conservative direction and
   *  one toggle to flip per account. */
  onboardingBurst: boolean;
  burstDays: number;
  burstMultiplier: number;
  /** How the walk ARRIVES at a community it means to join. `lateral` is not here:
   *  following a post through to its community cannot be aimed at a chosen
   *  target, so it happens opportunistically rather than being planned. */
  routeWeights: { keyword_search: number; name_search: number };
  /** Which surface of a keyword search the community is reached from. */
  keywordSurfaceWeights: { typeahead: number; communities_tab: number; post_result: number };
  /** Arriving is not joining. Both must be satisfied, in THIS community, in THIS
   *  session, before the join may be emitted. */
  minDwellSec: number;
  minStepsInCommunity: number;
  /** Chance the walk reads a post from the community before committing. */
  readPostFirstChance: number;
  /** Where the Join click happens. New reddit puts a Join button in the post
   *  header too, and "read a good post, join right there" is probably the most
   *  human version of this. */
  joinFromWeights: { community: number; post: number };
  /** Chance of carrying on in the community after joining rather than leaving
   *  immediately. Not a rule — truncation is still allowed, since a tidy
   *  wind-down is the one thing a real session never has. */
  afterJoinDwellChance: number;
  /** A join suppresses the quit hazard a little, decaying per step. You just
   *  found something you liked, so you are marginally more likely to keep going. */
  engagementBonus: number;
  engagementDecay: number;
}

export interface WarmupPolicy {
  version: 1;
  upvoteCurve: UpvoteCurve;
  follow: FollowPolicy;
  /** Follow-tagged communities NOT already known to be joined. The composer aims
   *  discovery at these. */
  joinTargets: string[];
  /** Topics this account plausibly searches. The global pool. */
  keywords: string[];
  /** keyword -> the target communities it is expected to surface.
   *
   *  THIS IS WHAT MAKES THE MULTI-TARGET FLOW COMPOSABLE. The composer runs with
   *  no access to the live page, so it cannot know what a search will return; the
   *  pairing is how it knows that one query can plausibly reach two targets and
   *  can therefore plan the second leg. The primitive reports what it ACTUALLY
   *  saw, which is how the pairing improves over sessions. */
  keywordsByCommunity: Record<string, string[]>;
  /** Weights for how a session STARTS. Renormalised, so relative size is all
   *  that matters. `sub` is zero-weighted automatically when the account has no
   *  subreddits to open. */
  /** Weights for RE-ANCHORING mid-session. Not for the entry — a session always
   *  opens on Home, because that is where reddit.com puts you. */
  entryMix: { home: number; sub: number; search: number };
  /** Chance a WHOLE SESSION includes one visit to r/popular. Deliberately tiny:
   *  regularly browsing Popular is not what an ordinary account does, and doing
   *  it every session is a signature. ~5 sessions in 100. */
  popularSessionChance: number;
  /** Same, for the News tab. Rarer still — ~1 session in 100. */
  newsSessionChance: number;
  /** Weights on the graph edges. Keys are `FROM>TO`; unknown keys are dropped by
   *  normalizeWarmupPolicy so an LLM can never invent an edge. */
  transitionWeights: Record<string, number>;
  /** Session length. Both are bounds, both are enforced. */
  sessionLength: { stepMin: number; stepMax: number; wallMinSec: number; wallMaxSec: number };
  /** Subreddits this account already follows — safe to open directly. */
  subreddits: string[];
  /** Communities it might search out. */
  searchTargets: string[];
}

/** Every edge the walk may use. This is the allow-list an LLM policy is filtered
 *  against — it can reweight these, never add one. */
export const EDGES: readonly string[] = [
  'FEED>POST',
  'FEED>SCROLL',
  'FEED>ANCHOR',
  'FEED>STOP',
  'POST>COMMENTS',
  // The LATERAL move — follow the post through to the community it came from,
  // then browse there. Without it the only exit from a post is a jump back to a
  // top-level feed, which is what made every session read home -> post -> home.
  'POST>SUB',
  'POST>ANCHOR',
  'POST>STOP',
  'COMMENTS>COMMENTS',
  'COMMENTS>SUB',
  'COMMENTS>ANCHOR',
  'COMMENTS>STOP',
];

export const DEFAULT_FOLLOW_POLICY: FollowPolicy = {
  joinsPerWeek: 3,
  maxPerSession: 2,
  secondJoinChance: 0.08,
  sameSearchSecondChance: 0.35,
  returnToResultsChance: 0.8,
  minStepsBetweenJoins: 6,
  onboardingBurst: false,
  burstDays: 3,
  burstMultiplier: 2.5,
  // DISCOVERY DOMINATES. A real person rarely knows the name of a community
  // before they find it — they search a topic and something turns up. Searching
  // a subreddit by its exact name assumes prior knowledge the account has no
  // business having, so it is the minority route rather than an even split.
  //
  // Note this is only the INTENT. A target with no keywords attached, and no
  // global pool to fall back on, has nothing to type and degrades to a name
  // search — which is why the Communities tab warns when follow targets have no
  // keyword coverage. That degrade is the usual reason a run looks like it is
  // "always searching by name".
  routeWeights: { keyword_search: 80, name_search: 20 },
  keywordSurfaceWeights: { typeahead: 45, communities_tab: 35, post_result: 20 },
  minDwellSec: 25,
  minStepsInCommunity: 2,
  readPostFirstChance: 0.65,
  joinFromWeights: { community: 55, post: 45 },
  afterJoinDwellChance: 0.7,
  engagementBonus: 0.15,
  engagementDecay: 0.5,
};

export const DEFAULT_POLICY: WarmupPolicy = {
  version: 1,
  upvoteCurve: { pMin: 0.1, pMax: 0.9, days: 5, steepness: 6, midpoint: 0.5, secondUpvoteChance: 0.15, commentVoteShare: 0.4 },
  follow: DEFAULT_FOLLOW_POLICY,
  joinTargets: [],
  keywords: [],
  keywordsByCommunity: {},
  entryMix: { home: 58, sub: 27, search: 15 },
  // Calibrated to REALISED rates, not draw rates. Roughly half of sessions never
  // re-anchor, so a flagged session can end without spending its detour — these
  // are set high enough that ~5 in 100 sessions actually contain a Popular visit
  // and ~1 in 100 a News visit. Verified empirically over 20k sessions; re-check
  // if the transition weights change.
  popularSessionChance: 0.094,
  newsSessionChance: 0.019,
  transitionWeights: {
    'FEED>POST': 55,
    'FEED>SCROLL': 24,
    'FEED>ANCHOR': 9,
    'FEED>STOP': 12,
    'POST>COMMENTS': 42,
    'POST>SUB': 20,
    'POST>ANCHOR': 20,
    'POST>STOP': 18,
    'COMMENTS>COMMENTS': 28,
    'COMMENTS>SUB': 18,
    'COMMENTS>ANCHOR': 32,
    'COMMENTS>STOP': 22,
  },
  sessionLength: { stepMin: 4, stepMax: 26, wallMinSec: 150, wallMaxSec: 600 },
  subreddits: [],
  searchTargets: [],
};

/** Hard ceilings. A bad policy must not be able to emit a two-hour session.
 *
 *  MAX_WALL_SEC IS TIED TO THE AGENT, not to taste. The agent reclaims any job
 *  stuck in `posting` for longer than STALE_POSTING_MS (default 20 min) and marks
 *  it FAILED — a window sized for 4–7 minute posting jobs. A warm-up session that
 *  ran longer would be shot mid-browse and recorded as a failure it never had.
 *
 *  estimateWarmupSeconds also errs LOW on purpose (it cannot know page loads or
 *  the agent's own in-step pauses, up to 13s each), so the ceiling needs real
 *  headroom under 20 min rather than to sit near it. 12 minutes barely binds —
 *  the p90 session is ~8 — while removing the tail risk entirely.
 *
 *  The proper fix is a kind-aware stale window in the agent; until that exists,
 *  this is the side of the contract we control. */
export const MAX_STEPS = 60;
export const MAX_WALL_SEC = 12 * 60;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strList = (v: unknown, cap: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().slice(0, 60)))].slice(0, cap)
    : [];

/**
 * Coerce anything (an LLM's JSON, a stale saved policy) into a safe policy.
 *
 * Returns null when the input is unusable so the caller falls back to
 * DEFAULT_POLICY — the same containment shape as expandAiDays in
 * server/warmup.ts. The model may shape the walk; it may never invent an edge,
 * an action type, or an unbounded number.
 */
export function normalizeWarmupPolicy(raw: unknown): WarmupPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_POLICY;

  const curveIn = (r.upvoteCurve ?? {}) as Record<string, unknown>;
  const upvoteCurve: UpvoteCurve = {
    pMin: clamp(isNum(curveIn.pMin) ? curveIn.pMin : d.upvoteCurve.pMin, 0, 1),
    pMax: clamp(isNum(curveIn.pMax) ? curveIn.pMax : d.upvoteCurve.pMax, 0, 1),
    days: clamp(Math.round(isNum(curveIn.days) ? curveIn.days : d.upvoteCurve.days), 1, 60),
    steepness: clamp(isNum(curveIn.steepness) ? curveIn.steepness : d.upvoteCurve.steepness, 0.1, 12),
    midpoint: clamp(isNum(curveIn.midpoint) ? curveIn.midpoint : d.upvoteCurve.midpoint, 0.05, 0.95),
    secondUpvoteChance: clamp(
      isNum(curveIn.secondUpvoteChance) ? curveIn.secondUpvoteChance : d.upvoteCurve.secondUpvoteChance,
      0,
      0.5,
    ),
    commentVoteShare: clamp(
      isNum(curveIn.commentVoteShare) ? curveIn.commentVoteShare : d.upvoteCurve.commentVoteShare,
      0,
      1,
    ),
  };
  // A curve that runs backwards is a bug, not a preference.
  if (upvoteCurve.pMax < upvoteCurve.pMin) upvoteCurve.pMax = upvoteCurve.pMin;

  const mixIn = (r.entryMix ?? {}) as Record<string, unknown>;
  const entryMix = {
    home: clamp(isNum(mixIn.home) ? mixIn.home : d.entryMix.home, 0, 100),
    sub: clamp(isNum(mixIn.sub) ? mixIn.sub : d.entryMix.sub, 0, 100),
    search: clamp(isNum(mixIn.search) ? mixIn.search : d.entryMix.search, 0, 100),
  };
  if (Object.values(entryMix).every((w) => w <= 0)) return null; // no way in at all

  // UNKNOWN KEYS ARE DROPPED. This is the line that stops an LLM inventing edges.
  const wIn = (r.transitionWeights ?? {}) as Record<string, unknown>;
  const transitionWeights: Record<string, number> = {};
  for (const edge of EDGES) {
    const v = wIn[edge];
    transitionWeights[edge] = clamp(isNum(v) ? v : d.transitionWeights[edge], 0, 100);
  }

  const lenIn = (r.sessionLength ?? {}) as Record<string, unknown>;
  const stepMin = clamp(Math.round(isNum(lenIn.stepMin) ? lenIn.stepMin : d.sessionLength.stepMin), 2, MAX_STEPS);
  const stepMax = clamp(Math.round(isNum(lenIn.stepMax) ? lenIn.stepMax : d.sessionLength.stepMax), stepMin, MAX_STEPS);
  const wallMinSec = clamp(Math.round(isNum(lenIn.wallMinSec) ? lenIn.wallMinSec : d.sessionLength.wallMinSec), 30, MAX_WALL_SEC);
  const wallMaxSec = clamp(
    Math.round(isNum(lenIn.wallMaxSec) ? lenIn.wallMaxSec : d.sessionLength.wallMaxSec),
    wallMinSec,
    MAX_WALL_SEC,
  );

  // FOLLOW POLICY. Same containment rule as the transition weights: every number
  // clamped, every unknown key dropped. The two that matter most are joinsPerWeek
  // (an unbounded value would empty the target pool in one session, which is the
  // most account-destroying thing in this file) and maxPerSession, capped at the
  // operator's decision of 2 regardless of what any policy asks for.
  const fIn = (r.follow ?? {}) as Record<string, unknown>;
  const df = d.follow;
  const fNum = (key: keyof FollowPolicy, lo: number, hi: number): number =>
    clamp(isNum(fIn[key]) ? (fIn[key] as number) : (df[key] as number), lo, hi);
  const routeIn = (fIn.routeWeights ?? {}) as Record<string, unknown>;
  const surfIn = (fIn.keywordSurfaceWeights ?? {}) as Record<string, unknown>;
  const fromIn = (fIn.joinFromWeights ?? {}) as Record<string, unknown>;
  const w100 = (v: unknown, fallback: number) => clamp(isNum(v) ? v : fallback, 0, 100);

  const follow: FollowPolicy = {
    joinsPerWeek: fNum('joinsPerWeek', 0, 25),
    maxPerSession: clamp(Math.round(isNum(fIn.maxPerSession) ? fIn.maxPerSession : df.maxPerSession), 0, 2),
    secondJoinChance: fNum('secondJoinChance', 0, 0.5),
    sameSearchSecondChance: fNum('sameSearchSecondChance', 0, 0.8),
    returnToResultsChance: fNum('returnToResultsChance', 0, 1),
    minStepsBetweenJoins: clamp(
      Math.round(isNum(fIn.minStepsBetweenJoins) ? fIn.minStepsBetweenJoins : df.minStepsBetweenJoins),
      0,
      MAX_STEPS,
    ),
    onboardingBurst: typeof fIn.onboardingBurst === 'boolean' ? fIn.onboardingBurst : df.onboardingBurst,
    burstDays: clamp(Math.round(isNum(fIn.burstDays) ? fIn.burstDays : df.burstDays), 1, 30),
    burstMultiplier: fNum('burstMultiplier', 1, 5),
    routeWeights: {
      keyword_search: w100(routeIn.keyword_search, df.routeWeights.keyword_search),
      name_search: w100(routeIn.name_search, df.routeWeights.name_search),
    },
    keywordSurfaceWeights: {
      typeahead: w100(surfIn.typeahead, df.keywordSurfaceWeights.typeahead),
      communities_tab: w100(surfIn.communities_tab, df.keywordSurfaceWeights.communities_tab),
      post_result: w100(surfIn.post_result, df.keywordSurfaceWeights.post_result),
    },
    // Bounded well above the defaults but not unbounded: a zero-dwell join is
    // exactly the "teleport in and click" behaviour this whole design exists to
    // avoid, and a 10-minute dwell would eat the session's wall budget.
    minDwellSec: fNum('minDwellSec', 5, 180),
    minStepsInCommunity: clamp(
      Math.round(isNum(fIn.minStepsInCommunity) ? fIn.minStepsInCommunity : df.minStepsInCommunity),
      1,
      10,
    ),
    readPostFirstChance: fNum('readPostFirstChance', 0, 1),
    joinFromWeights: {
      community: w100(fromIn.community, df.joinFromWeights.community),
      post: w100(fromIn.post, df.joinFromWeights.post),
    },
    afterJoinDwellChance: fNum('afterJoinDwellChance', 0, 1),
    engagementBonus: fNum('engagementBonus', 0, 0.5),
    engagementDecay: fNum('engagementDecay', 0.1, 1),
  };
  // A route set that adds to nothing would make discovery impossible while
  // leaving a join budget drawn — the walk would spin without ever arriving.
  if (follow.routeWeights.keyword_search + follow.routeWeights.name_search <= 0) {
    follow.routeWeights = { ...df.routeWeights };
  }

  const keywords = strList(r.keywords, 40);
  const joinTargets = strList(r.joinTargets, MAX_STEPS);

  // A PER-COMMUNITY KEYWORD IS A QUERY IN ITS OWN RIGHT.
  //
  // This used to filter each row's keywords against the global pool — on the
  // reasoning that a stale mapping should not be able to plan a search we have
  // no query for. That reasoning was simply wrong, and the effect was severe: an
  // operator who attached keywords to each community and left the topic pool
  // empty had EVERY pairing silently discarded, so every follow leg found
  // nothing to type and degraded to searching the community by its exact name.
  // Which looks, from outside, like topic discovery being ignored entirely.
  //
  // The pool is a FALLBACK for rows that carry no keywords of their own, not a
  // registry they have to be members of.
  const pairIn = (r.keywordsByCommunity ?? {}) as Record<string, unknown>;
  const keywordsByCommunity: Record<string, string[]> = {};
  for (const [sub, list] of Object.entries(pairIn)) {
    const name = String(sub).trim().toLowerCase();
    if (!name) continue;
    const paired = strList(list, 10);
    if (paired.length) keywordsByCommunity[name] = paired;
  }

  return {
    version: 1,
    upvoteCurve,
    follow,
    joinTargets,
    keywords,
    keywordsByCommunity,
    entryMix,
    // Capped hard. These are the two knobs where a generous value is actively
    // harmful, so an LLM policy may lower them but never raise them much.
    popularSessionChance: clamp(isNum(r.popularSessionChance) ? (r.popularSessionChance as number) : d.popularSessionChance, 0, 0.2),
    newsSessionChance: clamp(isNum(r.newsSessionChance) ? (r.newsSessionChance as number) : d.newsSessionChance, 0, 0.1),
    transitionWeights,
    sessionLength: { stepMin, stepMax, wallMinSec, wallMaxSec },
    subreddits: strList(r.subreddits, 40),
    searchTargets: strList(r.searchTargets, 40),
  };
}

// ---------------------------------------------------------------------------
// The ramp
// ---------------------------------------------------------------------------

/**
 * Chance that a session on `day` contains at least one upvote.
 *
 * PER SESSION, not per step and not per post. "10% on day 1" means one session in
 * ten casts a vote; a session essentially never casts more than one or two. At
 * ~4 sessions/day that is 0–1 votes on day 1 and 3–4 on day 5 — a lurker.
 *
 * A normalised LOGISTIC, so it hits pMin on day 1 and pMax on the last day
 * exactly, for any ramp length. Linear would need a clamp beyond the final day,
 * producing a hard kink; this saturates smoothly. `steepness` and `midpoint` are
 * the two knobs an operator actually reasons about — "how fast" and "when is it
 * a coin flip".
 *
 * Clamped to 0.95: an account that upvotes in literally every session is its own
 * kind of tell.
 */
export function upvoteChanceForDay(day: number, curve: UpvoteCurve = DEFAULT_POLICY.upvoteCurve): number {
  const { pMin, pMax, days, steepness: k, midpoint } = curve;
  if (days <= 1) return clamp(pMax, 0.02, 0.95);
  const t = clamp((clamp(Math.round(day), 1, days) - 1) / (days - 1), 0, 1);
  const logistic = (x: number) => 1 / (1 + Math.exp(-k * (x - midpoint)));
  const lo = logistic(0);
  const hi = logistic(1);
  const s = hi - lo < 1e-9 ? t : (logistic(t) - lo) / (hi - lo);
  return clamp(pMin + (pMax - pMin) * s, 0.02, 0.95);
}

/** Wall-clock day of the warm-up. Derived, never stored — this models "how long
 *  has this account existed", which does not pause when the Mac is off.
 *
 *  This is the AGE clock. On its own it is not what should drive the ramp — see
 *  warmupBoldnessDay. */
export function warmupDayFor(startedAtMs: number, nowMs: number): number {
  if (!startedAtMs) return 1;
  return Math.max(1, Math.floor((nowMs - startedAtMs) / 86_400_000) + 1);
}

/** Sessions a fully-active day is worth.
 *
 *  The ramp was calibrated against this: "day 5 at 90% is ~1 vote per session,
 *  3–4 per day" only holds at roughly four sessions a day. It is the conversion
 *  rate between work done and experience earned, so it belongs next to the
 *  curve rather than in the scheduler that will eventually produce the sessions. */
export const SESSIONS_PER_DAY = 4;

/** The EXPERIENCE clock — how many days' worth of warm-up has actually been
 *  performed, from completed sessions. Starts at day 1 (an account that has run
 *  nothing is a day-1 account, not a day-0 one). */
export function warmupExperienceDay(sessionsCompleted: number, sessionsPerDay = SESSIONS_PER_DAY): number {
  const done = Math.max(0, Math.floor(sessionsCompleted) || 0);
  const per = Math.max(1, Math.round(sessionsPerDay) || SESSIONS_PER_DAY);
  return Math.max(1, Math.floor(done / per) + 1);
}

/**
 * How bold this session is allowed to be — the LOWER of the two clocks.
 *
 * THE BUG THIS FIXES. The ramp used to read the age clock alone, which runs on
 * the calendar whether or not anything happened. Nothing schedules warm-up
 * sessions — every one is a button press — so an account started and then left
 * alone for a week was handed day-8 confidence (upvoting in nearly every
 * session) having genuinely completed three sessions in its life. An account
 * with almost no history behaving like an established one is precisely the
 * profile the ramp exists to prevent, and nothing surfaced it.
 *
 * Age still bounds it from above, because boldness must never outrun how old the
 * account actually looks: a burst of forty sessions in one day does not make a
 * one-day-old account a day-ten account. Experience bounds it from below,
 * because confidence has to be earned rather than waited out.
 *
 * Turning 18 does not make you ready for the motorway if you have had two
 * driving lessons; the previous version only checked the birthday.
 */
export function warmupBoldnessDay(
  ageDay: number,
  sessionsCompleted: number,
  sessionsPerDay = SESSIONS_PER_DAY,
): number {
  const age = Math.max(1, Math.round(ageDay) || 1);
  return Math.min(age, warmupExperienceDay(sessionsCompleted, sessionsPerDay));
}

// ---------------------------------------------------------------------------
// RNG — seeded so a simulated session is reproducible and shareable
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const randInt = (rng: Rng, lo: number, hi: number) => Math.floor(lo + rng() * (hi - lo + 1));
const roll = (rng: Rng, p: number) => rng() < p;

function weightedPick<T extends string>(rng: Rng, weights: Record<string, number>, keys: readonly T[]): T {
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
  if (total <= 0) return keys[0];
  let r = rng() * total;
  for (const k of keys) {
    r -= Math.max(0, weights[k] ?? 0);
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

/** The hesitation before the next step. Deliberately skewed short — mirrors
 *  pauseSec() in approach.ts, which mirrors the agent's own in-step pauses. One
 *  pacing shape for the whole system. */
function pauseSec(rng: Rng): number {
  const r = rng();
  const s =
    r < 0.55
      ? rng() * PAUSE_MAX_SEC * 0.15
      : r < 0.85
        ? PAUSE_MAX_SEC * 0.15 + rng() * PAUSE_MAX_SEC * 0.31
        : PAUSE_MAX_SEC * 0.46 + rng() * PAUSE_MAX_SEC * 0.54;
  return Math.round(s * 10) / 10;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export interface WarmupWalkContext {
  /** 1-based warm-up day. Drives the ramp. */
  day: number;
  policy?: WarmupPolicy;
  /** Omit for a genuinely random walk; pass one to reproduce a session exactly. */
  seed?: number;
  /** What this session is for. Defaults to `browse` — the kind that can do the
   *  least, so an un-migrated caller cannot accidentally join anything. */
  kind?: WarmupSessionKind;
}

export type WarmupStopReason = 'lost-interest' | 'step-budget' | 'time-budget' | 'cap';

/**
 * What a session is FOR. One kind per run, chosen by the operator (and later by
 * the package designer, which composes a day out of several rolls).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO SEPARATE QUESTIONS, AND AN EARLIER VERSION CONFLATED THEM.
 *
 *   1. MECHANICS — a join has to happen inside a browsing walk: arrive, dwell,
 *      actually look at the community, then click. That is what keeps it
 *      natural, and it is still true of every follow session.
 *
 *   2. CONTROL — whether ANY session may decide to join. That is a completely
 *      separate choice, and it belongs to the operator.
 *
 * The first version answered (1) correctly and then silently assumed (2), so a
 * session composed on the browsing tab could join a community the operator was
 * not expecting to touch. It did, on a live run.
 *
 * Now the kind decides. A `browse` roll can NEVER join. A `follow` roll always
 * tries to. Reddit cannot see these labels — a follow session is still an
 * ordinary walk that opens on Home and browses — so nothing about the footprint
 * changes. What changes is that the operator knows what they are pressing.
 * ════════════════════════════════════════════════════════════════════════════
 */
export type WarmupSessionKind = 'browse' | 'follow' | 'comment' | 'post';

export const SESSION_KIND_LABEL: Record<WarmupSessionKind, string> = {
  browse: 'Browsing',
  follow: 'Following',
  comment: 'Comment karma',
  post: 'Post karma',
};

/** Why a session cannot do what its kind asks. '' when it can.
 *
 *  Surfaced rather than degraded. A follow roll with nothing left to join used
 *  to be indistinguishable from a browse, which is how you end up believing an
 *  account is still accumulating communities a week after it stopped. */
export type WarmupBlockedReason = '' | 'no-join-targets' | 'not-built';

/**
 * What SHARE of a day's sessions should be follow rolls.
 *
 * NOT a per-session coin flip any more. Since a `follow` roll always attempts a
 * join and a `browse` roll never can, the question is no longer "does this
 * session join" but "how much of the mix is following" — which is an input to
 * the package designer, not to the composer.
 *
 * Kept here because it is derived from `joinsPerWeek` and SESSIONS_PER_DAY, the
 * same constant the EXPERIENCE clock uses, so the designer's pacing stays tied
 * to sessions actually run rather than to calendar days.
 */
export function joinChanceForSession(
  follow: FollowPolicy,
  day: number,
  sessionsPerDay = SESSIONS_PER_DAY,
): number {
  const sessionsPerWeek = Math.max(1, Math.round(sessionsPerDay) * 7);
  let p = Math.max(0, follow.joinsPerWeek) / sessionsPerWeek;
  if (follow.onboardingBurst && day <= follow.burstDays) p *= follow.burstMultiplier;
  return clamp(p, 0, 0.6);
}

/** What a session intends to join, decided BEFORE the walk.
 *
 *  Resolved up front for the same reason the vote budget is: it must survive
 *  rejection sampling unchanged, or a retry could "succeed" by quietly deciding
 *  to want less. It also has to be a compose-time decision because the route
 *  determines the keyword, and the keyword determines whether a second target is
 *  even reachable from the same search. */
export interface JoinLeg {
  target: string;
  route: 'keyword_search' | 'name_search';
  /** '' for name_search. */
  keyword: string;
  /** Where the click lands. */
  joinFrom: 'community' | 'post';
  /** Whether a post must be read in that community before committing. */
  readPostFirst: boolean;
  /** Go back to the previous results rather than searching afresh. Only ever set
   *  on a second leg that reuses the FIRST leg's query — going "back" to results
   *  produced by a different search is not a thing. */
  returning: boolean;
}

export interface JoinIntent {
  legs: JoinLeg[];
}

/** Draw the session's join intent. Returns null when it will not join.
 *
 *  ROUTE IS PER LEG, not per session. An earlier version hoisted it, which meant
 *  an unrelated second target inherited the first one's query — searching
 *  "budget tips" to find r/cooking, and then "returning to those results" to look
 *  for a community that was never in them. */
function drawJoinIntent(policy: WarmupPolicy, kind: WarmupSessionKind, rng: Rng): JoinIntent | null {
  // ONLY a follow roll may join. A browsing session cannot, however many
  // unjoined targets are sitting on the list.
  if (kind !== 'follow') return null;

  const F = policy.follow;
  const pool = policy.joinTargets.filter(Boolean);
  if (!pool.length || F.maxPerSession < 1) return null;

  // NO PACE ROLL. A follow roll's whole purpose is to join, so it always draws
  // an intent. How OFTEN follow rolls happen is the package designer's decision
  // — `joinsPerWeek` is guidance for it, not a coin flipped here.

  /** Pick a route and query for one community. Prefers a keyword actually paired
   *  with it, falls back to the global pool, and degrades to a name search when
   *  there is no query at all — a keyword step with nothing to type is not
   *  composable. */
  const legFor = (target: string, returning = false): JoinLeg => {
    let route = weightedPick(rng, F.routeWeights, ['keyword_search', 'name_search'] as const);
    let keyword = '';
    if (route === 'keyword_search') {
      const paired = policy.keywordsByCommunity[target] ?? [];
      const usable = paired.length ? paired : policy.keywords;
      if (usable.length) keyword = usable[randInt(rng, 0, usable.length - 1)];
      else route = 'name_search';
    }
    return {
      target,
      route,
      keyword,
      joinFrom: weightedPick(rng, F.joinFromWeights, ['community', 'post'] as const),
      readPostFirst: roll(rng, F.readPostFirstChance),
      returning,
    };
  };

  const first = legFor(pool[randInt(rng, 0, pool.length - 1)]);
  const legs: JoinLeg[] = [first];

  if (F.maxPerSession >= 2 && pool.length > 1) {
    // THE MULTI-TARGET FLOW. Other unjoined targets the SAME query is expected to
    // surface — knowable only because of the keyword pairing, since the composer
    // cannot see what a search will return. Higher chance than an unrelated
    // second join, because finding two relevant communities in one search and
    // joining both is coherent behaviour.
    const alsoSurfaced = first.keyword
      ? pool.filter((s) => s !== first.target && (policy.keywordsByCommunity[s] ?? []).includes(first.keyword))
      : [];

    if (alsoSurfaced.length && roll(rng, F.sameSearchSecondChance)) {
      const target = alsoSurfaced[randInt(rng, 0, alsoSurfaced.length - 1)];
      legs.push({
        ...legFor(target, roll(rng, F.returnToResultsChance)),
        // Same query as the first leg, by construction — that is the whole point
        // of this branch.
        route: 'keyword_search',
        keyword: first.keyword,
      });
    } else if (roll(rng, F.secondJoinChance)) {
      // An unrelated second join, anywhere in the session. Deliberately rare, and
      // it gets its OWN route and query.
      const rest = pool.filter((s) => s !== first.target);
      legs.push(legFor(rest[randInt(rng, 0, rest.length - 1)]));
    }
  }

  return { legs };
}

export interface WarmupLoopSession {
  plan: WarmupLoopPlan;
  /** The day this was composed for, and the chance that applied. */
  day: number;
  upvoteChance: number;
  /** How many votes the walk was ALLOWED. Drawn before the walk. */
  upvoteBudget: number;
  /** How many it actually placed. Equal to the budget except in rare forced cases. */
  upvotesPlanned: number;
  /** What this session is for. */
  kind: WarmupSessionKind;
  /** Why it cannot do what its kind asks — '' when it can. Never degraded
   *  silently into a different kind of session. */
  blocked: WarmupBlockedReason;
  /** What the session set out to join, or null. */
  joinIntent: JoinIntent | null;
  /** Communities this plan actually joins, in order. */
  joinsPlanned: string[];
  stoppedBy: WarmupStopReason;
  estimatedSec: number;
  seed: number;
}

type Surface = 'FEED' | 'POST' | 'COMMENTS';

/**
 * Compose ONE session.
 *
 * Randomness is resolved entirely here, exactly once — the agent re-rolls
 * nothing. The returned plan is a flat list the executor can run as-is.
 */
export function composeWarmupSession(ctx: WarmupWalkContext): WarmupLoopSession {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const day = Math.max(1, Math.round(ctx.day) || 1);
  const upvoteChance = upvoteChanceForDay(day, policy.upvoteCurve);

  // THE BUDGET IS DRAWN ONCE, HERE — outside the retry loop.
  //
  // Drawing it inside walkOnce was a real bug: a retry could "succeed" by
  // redrawing a budget of 0, so sessions that failed to place a vote were
  // quietly replaced by sessions that never wanted one. That biased the realised
  // rate down by up to 13pp against the curve, which the ramp test caught.
  const baseSeed = ctx.seed ?? Math.floor(Math.random() * 2 ** 32);
  const draw = makeRng(baseSeed);
  const upvoteBudget = roll(draw, upvoteChance)
    ? 1 + (roll(draw, policy.upvoteCurve.secondUpvoteChance) ? 1 : 0)
    : 0;

  // The join intent is drawn from the SAME pre-retry stream, for the same reason
  // the vote budget is: a retry that redrew it could "succeed" by deciding to
  // want nothing, which is exactly the bias that dragged the realised vote rate
  // 13pp under spec before the budget was hoisted out of the loop.
  const kind = ctx.kind ?? 'browse';
  const joinIntent = drawJoinIntent(policy, kind, draw);

  // A follow roll with nothing left to join is REPORTED, never quietly run as a
  // browse. A silent degrade is how an operator ends up believing an account is
  // still accumulating communities a week after the list ran dry.
  const blocked: WarmupBlockedReason =
    kind === 'follow' && !joinIntent ? 'no-join-targets' : kind === 'comment' || kind === 'post' ? 'not-built' : '';

  // Rejection sampling. `p` means "this session contains an upvote", but a vote
  // can only happen if the walk REACHES a post — a property of the transition
  // weights, not of the coin. Without this, a low FEED>POST weight silently
  // drags the realised rate below spec and nothing surfaces it.
  //
  // NOTE the returned `seed` is always baseSeed, never the attempt seed.
  // walkOnce is handed baseSeed + attempt*7919, but the vote budget above is
  // drawn from baseSeed's stream BEFORE any retry — so replaying an attempt seed
  // redraws a different budget and produces a different walk. Returning the
  // attempt seed made composeWarmupSession non-reproducible for every session
  // that needed a retry, which is exactly what let an 8-step preview run as a
  // 7-step session.
  // A session satisfies its draw only if it spent BOTH budgets. A walk that drew
  // a join but wandered off without reaching the community is exactly the silent
  // undershoot rejection sampling exists to catch — the realised join rate would
  // sit under the configured pace with nothing surfacing it.
  // KEEP THE BEST FAILING ATTEMPT, not the last one. The original loop assigned
  // `best = s` unconditionally, so a run that exhausted its attempts returned
  // attempt 7 regardless of whether attempt 2 had done better — throwing away
  // good walks and biasing every realised rate downward for no reason. Scored by
  // how much of the draw was actually spent.
  let best: WarmupLoopSession | null = null;
  let bestScore = -1;
  const wanted = joinIntent?.legs.length ?? 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const s = walkOnce(policy, day, upvoteChance, upvoteBudget, joinIntent, baseSeed + attempt * 7919, attempt >= 3);
    const votesOk = s.upvotesPlanned === s.upvoteBudget;
    const joinsOk = s.joinsPlanned.length === wanted;
    if (votesOk && joinsOk) return { ...s, seed: baseSeed, kind, blocked };
    // Joins are weighted above votes: a missed join costs the configured pace a
    // whole community, while a missed vote is one interaction.
    const score = s.joinsPlanned.length * 2 + s.upvotesPlanned;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { ...best!, seed: baseSeed, kind, blocked };
}

function walkOnce(
  policy: WarmupPolicy,
  day: number,
  upvoteChance: number,
  upvoteBudget: number,
  joinIntent: JoinIntent | null,
  seed: number,
  forceReach: boolean,
): WarmupLoopSession {
  const rng = makeRng(seed);
  const { sessionLength: len, transitionWeights: W, follow: F } = policy;

  // A FOLLOW ROLL NEEDS ROOM TO EARN THE JOIN. Anchor home, re-anchor into a
  // search, arrive, dwell 25s across two steps, often read a post, then click —
  // a 4-step session cannot do that, and 14% of follow rolls were ending before
  // they got there. Since the operator pressed a button whose entire purpose is
  // to join, that is a wasted roll rather than pleasing variety.
  //
  // Behaviourally justified rather than a knob: somebody who opens Reddit
  // meaning to find and join a community does not put the phone down after four
  // steps. Browsing sessions keep the full short-session range.
  const wantsJoin = !!joinIntent;
  const stepBudget = Math.max(randInt(rng, len.stepMin, len.stepMax), wantsJoin ? 9 : 0);
  const wallBudget = Math.max(randInt(rng, len.wallMinSec, len.wallMaxSec), wantsJoin ? 210 : 0);

  const plan: WarmupLoopPlan = [];
  let estimatedSec = 0;
  let upvotesPlanned = 0;
  let stoppedBy: WarmupStopReason = 'lost-interest';

  // --- community presence -------------------------------------------------
  // ARRIVING IS NOT JOINING. These three track what the walk has actually done
  // in the community it is standing in, this session, so a join can be gated on
  // real presence rather than on having navigated there. Reset on every arrival.
  let currentCommunity = '';
  let communitySteps = 0;
  let communityDwell = 0;
  let readPostHere = false;

  const joinsPlanned: string[] = [];
  let lastJoinAt = -999;
  /** Decaying suppression of the quit hazard after a join — you just found
   *  something you liked. NOT a rule against stopping: truncation is still the
   *  behaviour, this only tilts it. */
  let engagement = 0;

  const push = (type: WarmupLoopActionType, params: Record<string, string | number | boolean>, dwellSec: number) => {
    const gap = pauseSec(rng);
    plan.push({ type, params, gapAfterSec: gap, jitterPct: 0 });
    estimatedSec += dwellSec + gap;
    if (currentCommunity) {
      communitySteps++;
      communityDwell += dwellSec;
    }
  };

  // --- anchors ------------------------------------------------------------
  const subs = policy.subreddits.length ? policy.subreddits : [];
  const targets = policy.searchTargets.length ? policy.searchTargets : [];

  let lastAnchor = '';

  // POPULAR AND NEWS ARE DECIDED ONCE, FOR THE WHOLE SESSION.
  //
  // Never as the entry: opening reddit.com puts you on Home, so a session that
  // BEGINS on r/popular is already something a person did not do. And they are
  // rare even mid-session — regularly browsing Popular is not ordinary account
  // behaviour, and doing it every session is a signature all by itself.
  // Drawing per session rather than weighting per anchor is what makes "about 5
  // in 100" mean exactly that, however many times a given walk re-anchors.
  const mayVisitPopular = roll(rng, policy.popularSessionChance ?? 0.05);
  const mayVisitNews = roll(rng, policy.newsSessionChance ?? 0.01);
  let usedPopular = false;
  let usedNews = false;

  /** Where the walk is in its step loop — needed by emitAnchor to know whether
   *  discovery is running out of runway. */
  let stepNow = 0;

  /** Arrive at a NAMED target community, by a route a person would take.
   *
   *  `search_keyword` is the one that matters: search a topic, then reach the
   *  community from the results — via the typeahead dropdown, the Communities
   *  tab, or a post from it in the results. All three land on the community feed,
   *  the same way search_subreddit's three routes all land on the subreddit, so
   *  the composer's surface model stays simple.
   *
   *  `returning` means go back to the results page rather than retype the query.
   *  Retyping an identical search is the least human way back; people hit back.
   *  The results URL is absolute either way, so this is still an anchor. */
  const emitDiscovery = (leg: JoinLeg) => {
    if (leg.route === 'keyword_search' && leg.keyword) {
      const via = weightedPick(rng, F.keywordSurfaceWeights, [
        'typeahead',
        'communities_tab',
        'post_result',
      ] as const);
      push(
        'search_keyword',
        { keyword: leg.keyword, subreddit: leg.target, via, returning: leg.returning },
        leg.returning ? 8 : 14,
      );
    } else {
      const via = weightedPick(rng, { typeahead: 2, communities: 2, posts: 1 }, [
        'typeahead',
        'communities',
        'posts',
      ] as const);
      push('search_subreddit', { subreddit: leg.target, sort: 'hot', via }, 12);
    }
    // Arrival resets presence. The counters that gate the join measure what
    // happens FROM HERE, not what happened on the way.
    currentCommunity = leg.target;
    communitySteps = 0;
    communityDwell = 0;
    readPostHere = false;
    lastAnchor = 'sub';
  };

  /** The leg still to be spent, if any. */
  const pendingLeg = (): JoinLeg | null => joinIntent?.legs[joinsPlanned.length] ?? null;

  /** A leg we still have to travel TO — we are not standing in it yet. */
  const legToReach = (): JoinLeg | null => {
    const leg = pendingLeg();
    return leg && leg.target !== currentCommunity ? leg : null;
  };

  /** Discovery still owed. Used to bias the walk toward re-anchoring: a session
   *  that means to look something up has to actually change direction, and
   *  roughly half of walks never re-anchor on their own — the same property that
   *  makes popularSessionChance need calibrating against REALISED rates. Without
   *  this bias the realised join pace sat at less than half the configured one. */
  const discoveryPending = () => legToReach() !== null;

  const emitAnchor = (isEntry = false) => {
    // The session always opens on Home. Not a weight — a rule. Discovery is
    // therefore always mid-session: a session that OPENS by searching out a
    // community to join is not something a person does.
    if (isEntry) {
      const bursts = randInt(rng, 2, 5);
      push('open_feed', { feed: 'home', bursts }, 6 + bursts * 8);
      lastAnchor = 'home';
      currentCommunity = '';
      return;
    }

    // Discovery. Likely but not immediate — someone who means to look something
    // up does, but not necessarily the first time they change direction. Forced
    // when the session is nearly out of steps, mirroring forceReachPost: without
    // it a pathological weight set silently undershoots the configured pace.
    // Once the walk has DECIDED to re-anchor and a discovery is owed, the
    // discovery is almost always what that re-anchor is.
    //
    // This used to roll 0.7, which stacked badly against the 6x anchor bias that
    // gets us here: the walk would re-anchor eagerly and then keep emitting
    // ordinary anchors instead of the search, producing home -> home chains — the
    // single most mechanical thing a session can do, and exactly what the
    // anti-repetition penalty exists to prevent. Seen live: two consecutive
    // `open_feed home` steps before the search.
    //
    // The delay before discovery should come from the walk still being able to
    // choose POST or SCROLL instead of anchoring at all, not from rolling twice.
    const leg = legToReach();
    if (leg) {
      const runningOut = stepNow >= stepBudget - 4;
      if (runningOut || forceReach || roll(rng, 0.85)) {
        emitDiscovery(leg);
        return;
      }
    }

    // Leaving for a top-level feed means we are no longer in any community.
    currentCommunity = '';

    // The rare detours, at most once each per session.
    if (mayVisitNews && !usedNews) {
      usedNews = true;
      lastAnchor = 'news';
      push('open_feed', { feed: 'news', bursts: randInt(rng, 1, 3) }, 14);
      return;
    }
    if (mayVisitPopular && !usedPopular) {
      usedPopular = true;
      lastAnchor = 'popular';
      push('open_feed', { feed: 'popular', bursts: randInt(rng, 1, 3) }, 14);
      return;
    }

    const mix: Record<string, number> = {
      home: policy.entryMix.home,
      sub: subs.length ? policy.entryMix.sub : 0,
      search: targets.length ? policy.entryMix.search : 0,
    };
    // ANTI-REPETITION. Home carries the largest weight and nothing stopped it
    // winning three times in a row — the first live run read
    // home -> post -> home -> post -> home, the single most mechanical thing a
    // session can do. Somebody who just came from the front page does not go
    // straight back to it.
    //
    // Zeroed rather than merely damped when the PREVIOUS STEP was that same
    // anchor. A 0.15 penalty still let home follow home immediately, which reads
    // as a page refresh rather than a decision; the damping is the right shape
    // for "recently" but not for "just now".
    if (lastAnchor && mix[lastAnchor] !== undefined) {
      const prev = plan[plan.length - 1];
      const justCameFromHere =
        prev && prev.type === 'open_feed' && lastAnchor === 'home' && prev.params?.feed === 'home';
      mix[lastAnchor] *= justCameFromHere ? 0 : 0.15;
    }
    // ...unless that leaves nothing at all to pick.
    if (Object.values(mix).every((w) => w <= 0)) mix.home = 1;

    const kind = weightedPick(rng, mix, ['home', 'sub', 'search'] as const);
    lastAnchor = kind;
    if (kind === 'home') {
      const bursts = randInt(rng, 1, 4);
      push('open_feed', { feed: 'home', bursts }, 6 + bursts * 8);
    } else if (kind === 'sub') {
      const sub = subs[randInt(rng, 0, subs.length - 1)];
      const sort = weightedPick(rng, { hot: 6, new: 2, top: 1 }, ['hot', 'new', 'top'] as const);
      push('open_subreddit', { subreddit: sub, sort }, 6);
      // Named community — presence starts accruing. If this happens to be a
      // target and the gate is later satisfied, the join happens here without
      // any discovery leg at all, which is the most organic version of it.
      currentCommunity = sub;
      communitySteps = 0;
      communityDwell = 0;
      readPostHere = false;
    } else {
      const sub = targets[randInt(rng, 0, targets.length - 1)];
      const via = weightedPick(rng, { typeahead: 2, communities: 2, posts: 1 }, ['typeahead', 'communities', 'posts'] as const);
      push('search_subreddit', { subreddit: sub, sort: 'hot', via }, 12);
      currentCommunity = sub;
      communitySteps = 0;
      communityDwell = 0;
      readPostHere = false;
    }
  };

  /**
   * Spend one unit of the join intent, if this position has earned it.
   *
   * EVERY CONDITION HERE IS AN INVARIANT, not a preference — they are what make
   * "8 joins and 1 browse" unrepresentable rather than merely unlikely:
   *   - we must be standing in the community being joined;
   *   - real presence in it, this session, by both dwell and step count;
   *   - a post read first, when this target rolled that way;
   *   - spacing from the previous join, because back-to-back joins are a pattern;
   *   - the click lands where this target rolled it (community feed or post).
   */
  const trySpendJoin = (where: 'community' | 'post'): boolean => {
    const leg = pendingLeg();
    if (!leg || leg.target !== currentCommunity) return false;
    if (leg.joinFrom !== where) return false;
    if (communitySteps < F.minStepsInCommunity) return false;
    if (communityDwell < F.minDwellSec) return false;
    if (leg.readPostFirst && !readPostHere) return false;
    if (plan.length - lastJoinAt < F.minStepsBetweenJoins) return false;

    push('join_subreddit', { subreddit: leg.target, from: where }, 3);
    joinsPlanned.push(leg.target);
    lastJoinAt = plan.length;
    engagement = F.engagementBonus;
    return true;
  };

  /** The lateral move: follow this post through to the community it came from,
   *  then browse there. Relative, not an anchor — if the link is missing the step
   *  skips and the next anchor recovers. */
  const emitLateral = () => {
    push('open_post_subreddit', {}, 8);
    const bursts = randInt(rng, 1, 3);
    push('scroll_feed', { bursts }, bursts * 9);
    lastAnchor = 'sub'; // arriving in a community counts as having just been in one
    // WHICH community this lands in depends on where the post came from. A post
    // opened inside community X belongs to X, so following it through returns
    // there and presence carries on. A post opened from a top-level feed belongs
    // to a community the composer cannot name, so presence is unknown and no
    // join can be planned there — the run-time button check is what would stop
    // one anyway, but planning a join for a community we cannot name is
    // meaningless.
    if (!currentCommunity) {
      communitySteps = 0;
      communityDwell = 0;
      readPostHere = false;
    }
  };

  // --- state ---------------------------------------------------------------
  emitAnchor(true); // always Home
  let surface: Surface = 'FEED';
  let interest = rng();
  let boredom = 0;
  let reachedPost = false;
  let votedThisPost = false;

  // WHERE each vote goes, decided up front.
  //
  // The first version let ordering decide: it voted on the post 70% of the time
  // before comments were even reached, giving an 87/13 post/comment skew. A
  // reader who actually opens threads votes on comments far more than that. Now
  // the split is a policy number and the walk honours it.
  const voteTargets: Array<'post' | 'comment'> = [];
  for (let i = 0; i < upvoteBudget; i++) {
    voteTargets.push(roll(rng, policy.upvoteCurve.commentVoteShare ?? 0.4) ? 'comment' : 'post');
  }

  /** Spend one unit of the vote budget on the current thread.
   *
   *  The budget decides IF a session votes, voteTargets decides WHERE, and
   *  `force` is the sweep that runs before leaving a thread so a drawn vote is
   *  never silently dropped. Never votes twice on the same post — Reddit would
   *  just toggle it back off. Comment votes carry minScore/topN, so they only
   *  ever land on an ALREADY well-upvoted comment; being the lone upvoter on a
   *  dead comment is the pattern that avoids. */
  const spendVote = (where: 'post' | 'comment', force = false) => {
    if (upvotesPlanned >= upvoteBudget) return;
    if (!force && voteTargets[upvotesPlanned] !== where) return;
    if (where === 'post') {
      if (votedThisPost) return; // carry it to the next post instead
      push('upvote_post', {}, 2);
      votedThisPost = true;
    } else {
      push('upvote_comment', { minScore: 2, topN: 3 }, 3);
    }
    upvotesPlanned++;
  };

  /** Quit hazard. Rises with how long we have been here and with boredom, so a
   *  session that is going nowhere ends sooner. Kept low early — people rarely
   *  open Reddit and immediately close it. */
  //
  //  `engagement` tilts it down briefly after a join. A session that joins a
  //  community and closes in the same breath, every time, is its own pattern —
  //  but forbidding it outright would contradict the truncation principle, so
  //  this only makes carrying on more likely.
  //
  //  While a join is still OWED the hazard is damped hard: the session has a
  //  purpose it has not discharged yet, and people finish what they opened the
  //  app to do far more often than they abandon it halfway. Lifted the moment
  //  the join lands, so a follow roll can still end mid-scroll afterwards.
  const hazard = (step: number) => {
    const owed = !!joinIntent && joinsPlanned.length < joinIntent.legs.length;
    const base = 0.02 + 0.5 * Math.pow(step / stepBudget, 2.6) + boredom * 0.05 - engagement;
    return clamp(owed ? base * 0.3 : base, 0, 0.9);
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    stepNow = step;
    engagement *= F.engagementDecay;
    if (plan.length >= MAX_STEPS) {
      stoppedBy = 'cap';
      break;
    }
    if (estimatedSec >= Math.min(wallBudget, MAX_WALL_SEC)) {
      stoppedBy = 'time-budget';
      break;
    }
    if (step >= stepBudget) {
      stoppedBy = 'step-budget';
      break;
    }
    // Checked BETWEEN steps, so a session can die mid-thread. That truncation IS
    // the human behaviour — there is deliberately no tidy wind-down step.
    if (step > 0 && roll(rng, hazard(step))) {
      stoppedBy = 'lost-interest';
      break;
    }

    if (surface === 'FEED') {
      // Standing in a community we mean to join: the join fires as soon as
      // presence has been earned. Checked FIRST, so the click happens while we
      // are demonstrably still there rather than on the way out.
      if (trySpendJoin('community')) {
        // Usually keep browsing afterwards rather than vanishing.
        if (roll(rng, F.afterJoinDwellChance)) {
          const bursts = randInt(rng, 1, 3);
          push('scroll_feed', { bursts }, bursts * 9);
        }
        continue;
      }

      // Force the last rejection-sampling attempt to actually reach a post, so a
      // pathological weight set still honours the upvote draw.
      const mustOpen = forceReach && upvoteBudget > 0 && !reachedPost && step >= stepBudget - 2;
      // Earning the join means staying put: while a target is pending in THIS
      // community, leaving for another feed is heavily discouraged and reading a
      // post is encouraged. Without this the walk regularly arrived at a target
      // and immediately anchored away, so the realised join rate sat well under
      // the configured pace and rejection sampling burned every attempt.
      const leg = pendingLeg();
      const earning = !!leg && leg.target === currentCommunity;
      const needsRead = earning && leg!.readPostFirst && !readPostHere;
      const feedW = earning
        ? {
            'FEED>POST': (W['FEED>POST'] ?? 0) * (needsRead ? 3.5 : 1.6),
            'FEED>SCROLL': (W['FEED>SCROLL'] ?? 0) * 1.8,
            'FEED>ANCHOR': (W['FEED>ANCHOR'] ?? 0) * 0.1,
            'FEED>STOP': (W['FEED>STOP'] ?? 0) * 0.25,
          }
        : discoveryPending()
          ? {
              // Owed a discovery. Re-anchoring IS the search, so lean toward it
              // and away from stopping — someone who opened Reddit meaning to
              // look something up generally gets round to it.
              //
              // 3.5x, not the 6x this started at. The larger value was
              // compensating for a discovery roll that then wasted most of those
              // anchors on ordinary navigation; with discovery near-certain once
              // we get here, that much push just produces restless runs of
              // back-to-back navigations with no browsing between them.
              'FEED>POST': (W['FEED>POST'] ?? 0) * 0.6,
              'FEED>SCROLL': (W['FEED>SCROLL'] ?? 0) * 0.8,
              'FEED>ANCHOR': (W['FEED>ANCHOR'] ?? 0) * 3.5,
              'FEED>STOP': (W['FEED>STOP'] ?? 0) * 0.2,
            }
          : W;
      const next = mustOpen
        ? 'FEED>POST'
        : weightedPick(rng, feedW, ['FEED>POST', 'FEED>SCROLL', 'FEED>ANCHOR', 'FEED>STOP'] as const);

      if (next === 'FEED>STOP') {
        stoppedBy = 'lost-interest';
        break;
      }
      if (next === 'FEED>SCROLL') {
        const bursts = randInt(rng, 1, 3);
        push('scroll_feed', { bursts }, bursts * 9);
        boredom++;
        continue;
      }
      if (next === 'FEED>ANCHOR') {
        // A dead end, or simply a change of mind. Re-anchor absolutely.
        emitAnchor();
        boredom = 0;
        continue;
      }
      // FEED>POST
      push('open_feed_post', { minIndex: randInt(rng, 0, 3), maxIndex: randInt(rng, 4, 9), maxScrolls: randInt(rng, 2, 6), maxSeconds: 70 }, 14);
      interest = rng();
      boredom = 0;
      reachedPost = true;
      votedThisPost = false;
      const seconds = Math.round(20 + 120 * interest);
      push('read_post', { seconds }, seconds);
      // Reading something from the community is what "earned it" means for the
      // targets that rolled readPostFirst — you liked a post, so you joined.
      if (currentCommunity) readPostHere = true;
      // Only if this vote was assigned to the post. If it was assigned to a
      // comment it waits until the thread, and the sweep below catches it if the
      // walk never gets there.
      spendVote('post');
      surface = 'POST';
      continue;
    }

    if (surface === 'POST') {
      // New reddit puts a Join button in the post header, so "read a good post,
      // join right there" is a real and common path — and probably the most
      // human version of joining anything. Only fires for targets that rolled
      // `post` as their join position.
      if (trySpendJoin('post')) {
        if (roll(rng, F.afterJoinDwellChance)) {
          const secs = randInt(rng, 10, 40);
          push('skim_comments', { seconds: secs, comments: randInt(rng, 1, 6) }, secs);
          surface = 'COMMENTS';
        }
        continue;
      }

      // An interesting post pulls you into the thread; a dull one bounces you
      // back out. Interest is redrawn per post, which is the main source of
      // run-to-run variety.
      // If the vote still to be placed is meant for a COMMENT, lean into the
      // thread. Without this the split is only ever an intention: the sweep
      // forces a post-vote whenever the walk leaves without going in, which
      // dragged a configured 40% comment share down to a realised 19%. It is
      // also simply how people behave — someone minded to engage opens the
      // comments.
      const wantsComment = upvotesPlanned < upvoteBudget && voteTargets[upvotesPlanned] === 'comment';
      // Owed a discovery: leaving for an anchor IS the search, so lean that way.
      const owed = discoveryPending() ? 4 : 1;
      const w = {
        'POST>COMMENTS': (W['POST>COMMENTS'] ?? 0) * (0.4 + 1.2 * interest) * (wantsComment ? 2.6 : 1),
        // Curiosity about WHERE something came from tracks how much you liked it.
        'POST>SUB': (W['POST>SUB'] ?? 0) * (0.5 + 1.0 * interest),
        'POST>ANCHOR': (W['POST>ANCHOR'] ?? 0) * (1.4 - 0.6 * interest) * owed,
        'POST>STOP': (W['POST>STOP'] ?? 0) * (1.3 - 0.5 * interest) * (owed > 1 ? 0.25 : 1),
      };
      const next = weightedPick(rng, w, ['POST>COMMENTS', 'POST>SUB', 'POST>ANCHOR', 'POST>STOP'] as const);
      // Last chance while still on this thread. Without this sweep a session
      // that drew a budget can wander off without ever spending it.
      if (next !== 'POST>COMMENTS') spendVote('post', true);
      if (next === 'POST>STOP') {
        stoppedBy = 'lost-interest';
        break;
      }
      if (next === 'POST>SUB') {
        emitLateral();
        surface = 'FEED';
        continue;
      }
      if (next === 'POST>ANCHOR') {
        emitAnchor();
        surface = 'FEED';
        continue;
      }
      const seconds = Math.round(15 + 55 * interest);
      push('skim_comments', { seconds, comments: randInt(rng, 1, 12) }, seconds);
      surface = 'COMMENTS';
      continue;
    }

    // COMMENTS — in a thread, so this is where a comment vote belongs.
    spendVote('comment');
    const owedC = discoveryPending() ? 4 : 1;
    const commentsW = {
      'COMMENTS>COMMENTS': (W['COMMENTS>COMMENTS'] ?? 0) * (owedC > 1 ? 0.5 : 1),
      'COMMENTS>SUB': W['COMMENTS>SUB'] ?? 0,
      'COMMENTS>ANCHOR': (W['COMMENTS>ANCHOR'] ?? 0) * owedC,
      'COMMENTS>STOP': (W['COMMENTS>STOP'] ?? 0) * (owedC > 1 ? 0.25 : 1),
    };
    const next = weightedPick(rng, commentsW, ['COMMENTS>COMMENTS', 'COMMENTS>SUB', 'COMMENTS>ANCHOR', 'COMMENTS>STOP'] as const);
    if (next !== 'COMMENTS>COMMENTS') {
      // Leaving the thread — spend whatever is left. Post first if it has not
      // been voted, otherwise a comment (both are reachable from here).
      spendVote(votedThisPost ? 'comment' : 'post', true);
    }
    if (next === 'COMMENTS>STOP') {
      stoppedBy = 'lost-interest';
      break;
    }
    if (next === 'COMMENTS>SUB') {
      emitLateral();
      surface = 'FEED';
      continue;
    }
    if (next === 'COMMENTS>ANCHOR') {
      emitAnchor();
      surface = 'FEED';
      continue;
    }
    const seconds = randInt(rng, 12, 45);
    push('skim_comments', { seconds, comments: randInt(rng, 1, 8) }, seconds);
  }

  // No closing step, by design. The plan simply ends — mid-scroll, mid-thread.
  // A tidy "and then they went home" is the one thing a real session never has.
  if (plan.length) plan[plan.length - 1].gapAfterSec = 0;

  return {
    plan,
    day,
    upvoteChance,
    upvoteBudget,
    upvotesPlanned,
    // Overwritten by composeWarmupSession, which owns both — walkOnce is one
    // attempt and has no view of the session's purpose.
    kind: 'browse',
    blocked: '',
    joinIntent,
    joinsPlanned,
    stoppedBy,
    estimatedSec: Math.round(estimatedSec),
    seed,
  };
}

// ---------------------------------------------------------------------------
// Display helpers — mirrors describeApproachStep / approachStepCaveat
// ---------------------------------------------------------------------------

export function describeWarmupStep(step: WarmupLoopStep): string {
  const p = step.params ?? {};
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (step.type) {
    case 'open_feed': {
      const b = n(p.bursts);
      const where =
        p.feed === 'home' ? 'Home' : p.feed === 'popular' ? 'Popular' : p.feed === 'news' ? 'News'
        : p.feed === 'explore' ? 'Explore' : p.feed === 'all' ? 'All' : 'Home';
      return b ? `${where}, ${b} scroll burst${b === 1 ? '' : 's'}` : where;
    }
    case 'open_post_subreddit':
      return 'Click through to the community this post is in';
    case 'open_subreddit': {
      const sort = p.sort && p.sort !== 'hot' ? `, sorted by ${p.sort}` : '';
      return `r/${p.subreddit}${sort}`;
    }
    case 'search_subreddit':
      return `“${p.subreddit}” — via the header search`;
    case 'search_keyword': {
      const where =
        p.via === 'typeahead'
          ? 'from the suggestions'
          : p.via === 'communities_tab'
            ? 'from the Communities tab'
            : 'via a post in the results';
      const back = p.returning ? 'Back to the results for' : 'Search';
      return `${back} “${p.keyword}” → r/${p.subreddit} ${where}`;
    }
    case 'join_subreddit':
      return `r/${p.subreddit}${p.from === 'post' ? ' — from the post you were reading' : ''}`;
    case 'scroll_feed': {
      const b = n(p.bursts);
      return b ? `${b} scroll burst${b === 1 ? '' : 's'}` : '';
    }
    case 'open_feed_post': {
      const lo = n(p.minIndex);
      const hi = n(p.maxIndex);
      return lo !== null && hi !== null ? `Whatever is sitting around position ${lo + 1}–${hi + 1}` : 'A post from the feed';
    }
    case 'read_post': {
      const s = n(p.seconds);
      return s ? `About ${s}s` : '';
    }
    case 'skim_comments': {
      const c = n(p.comments);
      const s = n(p.seconds);
      return [c ? `up to ${c} comment${c === 1 ? '' : 's'}` : '', s ? `about ${s}s` : ''].filter(Boolean).join(', ');
    }
    case 'upvote_post':
      return '';
    case 'upvote_comment': {
      const m = n(p.minScore);
      return `Only one that is already well-upvoted${m ? ` (${m}+ score)` : ''}`;
    }
    default:
      return '';
  }
}

/** Why a step might not go exactly as written — '' when it will. The plan is an
 *  intention; the trace afterwards records what actually happened. */
export function warmupStepCaveat(step: WarmupLoopStep): string {
  switch (step.type) {
    case 'search_subreddit':
      return 'If this route doesn’t surface the community, it tries the others, then goes directly.';
    case 'search_keyword':
      return 'A topic search may not surface this community at all — it then falls back to searching for it by name, and skips the rest of this leg if that fails too.';
    case 'join_subreddit':
      return 'Reads the button first and skips if the account already follows it — clicking Joined would leave the community.';
    case 'open_feed_post':
      return 'Takes whichever post is actually there; skips the rest of this leg if the feed has none.';
    case 'open_post_subreddit':
      return 'Skipped if the post has no community link — the next feed re-establishes position.';
    case 'open_feed':
      return 'Falls back to the home feed if that tab does not load.';
    case 'skim_comments':
      return 'Reads fewer if the thread has fewer — a short thread is read in full.';
    case 'upvote_post':
      return 'Skipped if this account has already upvoted it, or if the click never landed on a post.';
    case 'upvote_comment':
      return 'Picks an already-well-upvoted comment at run time; skipped if none qualify.';
    default:
      return '';
  }
}

/** Rough wall-clock for a whole plan, seconds. Indicative — the agent's in-step
 *  pauses and page loads are not knowable here, so this errs low. */
export function estimateWarmupSeconds(plan: WarmupLoopPlan): number {
  let total = 0;
  for (const step of plan) {
    const p = step.params ?? {};
    total += step.gapAfterSec || 0;
    const secs = typeof p.seconds === 'number' ? p.seconds : 0;
    const bursts = typeof p.bursts === 'number' ? p.bursts : 0;
    switch (step.type) {
      case 'open_feed':
        total += 6 + bursts * 8;
        break;
      case 'open_post_subreddit':
        total += 8;
        break;
      case 'open_subreddit':
        total += 6;
        break;
      case 'search_subreddit':
        total += 12;
        break;
      case 'search_keyword':
        total += p.returning ? 8 : 14;
        break;
      case 'join_subreddit':
        total += 3;
        break;
      case 'scroll_feed':
        total += bursts * 9;
        break;
      case 'open_feed_post':
        total += 14;
        break;
      case 'read_post':
      case 'skim_comments':
        total += secs;
        break;
      case 'upvote_post':
      case 'upvote_comment':
        total += 2;
        break;
    }
  }
  return Math.round(total);
}

export const STOP_REASON_LABEL: Record<WarmupStopReason, string> = {
  'lost-interest': 'Lost interest',
  'step-budget': 'Ran out of attention',
  'time-budget': 'Been here long enough',
  cap: 'Hit the safety ceiling',
};

// ---------------------------------------------------------------------------
// Trace — what the agent writes back. Mirrors ApproachTraceStep.
// ---------------------------------------------------------------------------

export interface WarmupTraceStep {
  type: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  elapsedSec?: number;
  via?: string;
  /** The route the plan aimed at, set ONLY when a different one actually landed.
   *  Its absence means the step went the way it intended. */
  plannedVia?: string;
  seconds?: number;
  read?: number;
  available?: number;
  upvoted?: boolean;
  scrolls?: number;
  bursts?: number;
  dryRun?: boolean;
}

export type WarmupTrace = WarmupTraceStep[];

/** Defensive parse of whatever came back from the agent. `ok` missing reads as
 *  success, matching normalizeApproachTrace. */
export function normalizeWarmupTrace(raw: unknown): WarmupTrace {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    if (typeof o.type !== 'string') return [];
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : undefined);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    return [
      {
        type: o.type,
        ok: o.ok !== false,
        skipped: bool(o.skipped),
        reason: str(o.reason),
        elapsedSec: num(o.elapsedSec),
        via: str(o.via),
        plannedVia: str(o.plannedVia),
        seconds: num(o.seconds),
        read: num(o.read),
        available: num(o.available),
        upvoted: bool(o.upvoted),
        scrolls: num(o.scrolls),
        bursts: num(o.bursts),
        dryRun: bool(o.dryRun),
      },
    ];
  });
}

/** Did the session do what it set out to do? Used by the UI summary and, later,
 *  by stuck-detection. */
export function summarizeWarmupRun(plan: WarmupLoopPlan, trace: WarmupTrace) {
  const ran = trace.length;
  const skipped = trace.filter((t) => t.skipped).length;
  const failed = trace.filter((t) => !t.ok).length;
  const upvoted = trace.filter((t) => t.upvoted === true).length;
  return {
    ran,
    planned: plan.length,
    skipped,
    failed,
    upvoted,
    completion: plan.length ? ran / plan.length : 0,
    skipRate: ran ? skipped / ran : 0,
  };
}
