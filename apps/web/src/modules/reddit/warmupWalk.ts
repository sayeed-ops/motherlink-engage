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
  | 'scroll_feed'
  | 'open_feed_post'
  | 'open_post_subreddit'
  | 'read_post'
  | 'skim_comments'
  | 'upvote_post'
  | 'upvote_comment';

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
]);

export const WARMUP_LOOP_LABELS: Record<WarmupLoopActionType, string> = {
  open_feed: 'Open a feed',
  open_subreddit: 'Open a subreddit',
  search_subreddit: 'Search for a community',
  scroll_feed: 'Scroll the feed',
  open_feed_post: 'Open a post from the feed',
  open_post_subreddit: 'Follow the post to its community',
  read_post: 'Read the post',
  skim_comments: 'Skim the comments',
  upvote_post: 'Upvote the post',
  upvote_comment: 'Upvote a comment',
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

export interface WarmupPolicy {
  version: 1;
  upvoteCurve: UpvoteCurve;
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

export const DEFAULT_POLICY: WarmupPolicy = {
  version: 1,
  upvoteCurve: { pMin: 0.1, pMax: 0.9, days: 5, steepness: 6, midpoint: 0.5, secondUpvoteChance: 0.15, commentVoteShare: 0.4 },
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

  return {
    version: 1,
    upvoteCurve,
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

/** Wall-clock day of the warm-up. Derived, never stored — the ramp models "how
 *  long has this account existed", which does not pause when the Mac is off. */
export function warmupDayFor(startedAtMs: number, nowMs: number): number {
  if (!startedAtMs) return 1;
  return Math.max(1, Math.floor((nowMs - startedAtMs) / 86_400_000) + 1);
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
}

export type WarmupStopReason = 'lost-interest' | 'step-budget' | 'time-budget' | 'cap';

export interface WarmupLoopSession {
  plan: WarmupLoopPlan;
  /** The day this was composed for, and the chance that applied. */
  day: number;
  upvoteChance: number;
  /** How many votes the walk was ALLOWED. Drawn before the walk. */
  upvoteBudget: number;
  /** How many it actually placed. Equal to the budget except in rare forced cases. */
  upvotesPlanned: number;
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

  // Rejection sampling. `p` means "this session contains an upvote", but a vote
  // can only happen if the walk REACHES a post — a property of the transition
  // weights, not of the coin. Without this, a low FEED>POST weight silently
  // drags the realised rate below spec and nothing surfaces it.
  let best: WarmupLoopSession | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const s = walkOnce(policy, day, upvoteChance, upvoteBudget, baseSeed + attempt * 7919, attempt >= 5);
    if (s.upvotesPlanned === s.upvoteBudget) return s;
    best = s;
  }
  return best!;
}

function walkOnce(
  policy: WarmupPolicy,
  day: number,
  upvoteChance: number,
  upvoteBudget: number,
  seed: number,
  forceReachPost: boolean,
): WarmupLoopSession {
  const rng = makeRng(seed);
  const { sessionLength: len, transitionWeights: W } = policy;

  const stepBudget = randInt(rng, len.stepMin, len.stepMax);
  const wallBudget = randInt(rng, len.wallMinSec, len.wallMaxSec);

  const plan: WarmupLoopPlan = [];
  let estimatedSec = 0;
  let upvotesPlanned = 0;
  let stoppedBy: WarmupStopReason = 'lost-interest';

  const push = (type: WarmupLoopActionType, params: Record<string, string | number | boolean>, dwellSec: number) => {
    const gap = pauseSec(rng);
    plan.push({ type, params, gapAfterSec: gap, jitterPct: 0 });
    estimatedSec += dwellSec + gap;
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

  const emitAnchor = (isEntry = false) => {
    // The session always opens on Home. Not a weight — a rule.
    if (isEntry) {
      const bursts = randInt(rng, 2, 5);
      push('open_feed', { feed: 'home', bursts }, 6 + bursts * 8);
      lastAnchor = 'home';
      return;
    }

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
    if (lastAnchor && mix[lastAnchor] !== undefined) mix[lastAnchor] *= 0.15;

    const kind = weightedPick(rng, mix, ['home', 'sub', 'search'] as const);
    lastAnchor = kind;
    if (kind === 'home') {
      const bursts = randInt(rng, 1, 4);
      push('open_feed', { feed: 'home', bursts }, 6 + bursts * 8);
    } else if (kind === 'sub') {
      const sub = subs[randInt(rng, 0, subs.length - 1)];
      const sort = weightedPick(rng, { hot: 6, new: 2, top: 1 }, ['hot', 'new', 'top'] as const);
      push('open_subreddit', { subreddit: sub, sort }, 6);
    } else {
      const sub = targets[randInt(rng, 0, targets.length - 1)];
      const via = weightedPick(rng, { typeahead: 2, communities: 2, posts: 1 }, ['typeahead', 'communities', 'posts'] as const);
      push('search_subreddit', { subreddit: sub, sort: 'hot', via }, 12);
    }
  };

  /** The lateral move: follow this post through to the community it came from,
   *  then browse there. Relative, not an anchor — if the link is missing the step
   *  skips and the next anchor recovers. */
  const emitLateral = () => {
    push('open_post_subreddit', {}, 8);
    const bursts = randInt(rng, 1, 3);
    push('scroll_feed', { bursts }, bursts * 9);
    lastAnchor = 'sub'; // arriving in a community counts as having just been in one
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
  const hazard = (step: number) => clamp(0.02 + 0.5 * Math.pow(step / stepBudget, 2.6) + boredom * 0.05, 0, 0.9);

  for (let step = 0; step < MAX_STEPS; step++) {
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
      // Force the last rejection-sampling attempt to actually reach a post, so a
      // pathological weight set still honours the upvote draw.
      const mustOpen = forceReachPost && upvoteBudget > 0 && !reachedPost && step >= stepBudget - 2;
      const next = mustOpen
        ? 'FEED>POST'
        : weightedPick(rng, W, ['FEED>POST', 'FEED>SCROLL', 'FEED>ANCHOR', 'FEED>STOP'] as const);

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
      // Only if this vote was assigned to the post. If it was assigned to a
      // comment it waits until the thread, and the sweep below catches it if the
      // walk never gets there.
      spendVote('post');
      surface = 'POST';
      continue;
    }

    if (surface === 'POST') {
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
      const w = {
        'POST>COMMENTS': (W['POST>COMMENTS'] ?? 0) * (0.4 + 1.2 * interest) * (wantsComment ? 2.6 : 1),
        // Curiosity about WHERE something came from tracks how much you liked it.
        'POST>SUB': (W['POST>SUB'] ?? 0) * (0.5 + 1.0 * interest),
        'POST>ANCHOR': (W['POST>ANCHOR'] ?? 0) * (1.4 - 0.6 * interest),
        'POST>STOP': (W['POST>STOP'] ?? 0) * (1.3 - 0.5 * interest),
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
    const next = weightedPick(rng, W, ['COMMENTS>COMMENTS', 'COMMENTS>SUB', 'COMMENTS>ANCHOR', 'COMMENTS>STOP'] as const);
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
