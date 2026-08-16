// What the outcomes say, and the few knobs they are allowed to turn.
//
// PURE. No I/O, no clock.
//
// THE HONEST VERSION OF A LEARNING LOOP. Everything here refuses to conclude
// anything from a small sample, and every knob it turns has a floor. Both of
// those are the same guard: this system posts a few comments a day, so a naive
// aggregate would be reacting to three data points, and a knob without a floor
// would drive a community's weight to zero after two bad comments and then
// never collect another sample from it — the ledger would freeze on its first
// impression. Same deadlock the "no baseline must not reject everything" rule in
// select.ts exists to prevent.
//
// WHY EXPLORATION IS PART OF THE LOOP AND NOT A NICETY: without it we only ever
// see outcomes for threads the system already liked, which means the selection
// rules can never be discovered to be WRONG — only refined within whatever they
// already believe. So a small share of scans deliberately takes a thread the
// scorer rejected, and those samples are the only unbiased ones we have.

import type { CommentDraftRecord } from './drafts';
import type { GapState, PosterWant } from './gaps';
import { finalCheck } from './outcomes';

export interface OutcomeSample {
  subreddit: string;
  gapState: GapState;
  posterWant: PosterWant;
  words: number;
  /** UTC hour the comment went up. */
  hour: number;
  /** This one was taken against the scorer's advice. */
  exploratory: boolean;
  score: number;
  rank: number;
  totalTopLevel: number;
  replies: number;
  removed: boolean;
}

/**
 * Turn the records into samples.
 *
 * Only comments that WENT UP and have been measured at least once. A record
 * with no checks yet is not a zero — it is a comment nobody has looked at, and
 * counting it as a failure would make every fresh comment drag the numbers
 * down and the knobs move on nothing.
 */
export function toSamples(records: CommentDraftRecord[]): OutcomeSample[] {
  const out: OutcomeSample[] = [];
  for (const r of records) {
    if (r.status !== 'posted' || !r.thread || !r.gap) continue;
    const last = finalCheck(r.outcome);
    // Removed is a measurement — arguably the most important one — so it counts
    // even though there is no check to read a score from.
    if (!last && !r.outcome.removed) continue;
    const postedAtMs = r.postedAtMs ?? r.createdAtMs;
    out.push({
      subreddit: r.thread.subreddit,
      gapState: r.gap.gapState,
      posterWant: r.gap.posterWant,
      words: r.words,
      hour: new Date(postedAtMs).getUTCHours(),
      exploratory: r.exploratory,
      score: last?.score ?? 0,
      rank: last?.rank ?? 0,
      totalTopLevel: last?.totalTopLevel ?? 0,
      replies: last?.replies ?? 0,
      removed: r.outcome.removed,
    });
  }
  return out;
}

/** Below this a bucket is anecdote. Deliberately high for a system posting a
 *  handful a day: it means a knob does not move for the first week or so, which
 *  is correct — nothing is known yet. */
export const MIN_BUCKET = 8;
/** Below this, nothing at all is fitted. */
export const MIN_TOTAL = 20;

/** Weight floor. A community that has done badly is tried LESS, never never —
 *  a zero would stop the sampling that could show it had a bad week. */
export const MIN_WEIGHT = 0.2;

/** Share of scans that deliberately ignore the scorer. Small, because the price
 *  of exploration is a comment placed somewhere we predicted would not pay. */
export const DEFAULT_EXPLORE_RATE = 0.15;

export interface Bucket {
  key: string;
  n: number;
  medianScore: number;
  /** Comments that reached the visible half of the thread. */
  topHalfRate: number;
  replyRate: number;
  removedRate: number;
}

export interface OutcomeSummary {
  n: number;
  medianScore: number;
  removed: number;
  exploratory: number;
  bySubreddit: Bucket[];
  byGapState: Bucket[];
  byPosterWant: Bucket[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function bucket(key: string, samples: OutcomeSample[]): Bucket {
  const n = samples.length;
  const rate = (test: (s: OutcomeSample) => boolean) => (n ? samples.filter(test).length / n : 0);
  return {
    key,
    n,
    // Removed comments count as their score, which is 0 or negative — they were
    // still an outcome, and excluding them would flatter every bucket that has
    // them.
    medianScore: median(samples.map((s) => s.score)),
    topHalfRate: rate((s) => !s.removed && s.totalTopLevel > 0 && s.rank <= Math.ceil(s.totalTopLevel / 2)),
    replyRate: rate((s) => s.replies > 0),
    removedRate: rate((s) => s.removed),
  };
}

function group<K extends string>(samples: OutcomeSample[], keyOf: (s: OutcomeSample) => K): Bucket[] {
  const map = new Map<string, OutcomeSample[]>();
  for (const s of samples) {
    const k = keyOf(s);
    map.set(k, [...(map.get(k) ?? []), s]);
  }
  return [...map.entries()]
    .map(([k, list]) => bucket(k, list))
    .sort((a, b) => b.n - a.n);
}

export function summarise(samples: OutcomeSample[]): OutcomeSummary {
  return {
    n: samples.length,
    medianScore: median(samples.map((s) => s.score)),
    removed: samples.filter((s) => s.removed).length,
    exploratory: samples.filter((s) => s.exploratory).length,
    bySubreddit: group(samples, (s) => s.subreddit),
    byGapState: group(samples, (s) => s.gapState),
    byPosterWant: group(samples, (s) => s.posterWant),
  };
}

export interface LearnedKnobs {
  /** subreddit → 0.2..2. Multiplies its chance of being the one scanned. */
  communityWeights: Record<string, number>;
  /** Extra confidence demanded of a gap state that has not been paying off. */
  gapConfidenceFloor: Partial<Record<GapState, number>>;
  exploreRate: number;
  /** Plain-English notes for the panel. Nothing acts on these — they exist so
   *  an operator can see WHY a knob moved, rather than watching behaviour
   *  change for reasons the UI never explains. */
  notes: string[];
}

export const NO_KNOBS: LearnedKnobs = {
  communityWeights: {},
  gapConfidenceFloor: {},
  exploreRate: DEFAULT_EXPLORE_RATE,
  notes: [],
};

/**
 * Fit the knobs.
 *
 * Three rules, all of them about not over-reacting:
 *   - nothing at all below MIN_TOTAL samples;
 *   - no bucket is used below MIN_BUCKET;
 *   - every adjustment is relative to the account's OWN median, never an
 *     absolute score. Twelve points is a triumph in a small sub and invisible in
 *     a default one, and this file must work for an account living in either.
 */
export function fitKnobs(samples: OutcomeSample[]): LearnedKnobs {
  if (samples.length < MIN_TOTAL) {
    return { ...NO_KNOBS, notes: [`Only ${samples.length} measured comment(s) — nothing is fitted yet.`] };
  }

  const summary = summarise(samples);
  const overall = summary.medianScore || 1;
  const notes: string[] = [];

  const communityWeights: Record<string, number> = {};
  for (const b of summary.bySubreddit) {
    if (b.n < MIN_BUCKET) continue;
    // Ratio against the account's own median, clamped. A sub doing twice as
    // well is scanned twice as often; one doing badly is scanned less, and
    // never not at all.
    const ratio = (b.medianScore || 0) / overall;
    const weight = Math.min(2, Math.max(MIN_WEIGHT, ratio));
    communityWeights[b.key] = Math.round(weight * 100) / 100;
    if (weight <= MIN_WEIGHT) notes.push(`r/${b.key} is paying off poorly (median ${b.medianScore} vs ${overall}) — scanned less often, not dropped.`);
    // Removal is not a yield signal, it is a rejection signal, and it deserves
    // to be louder than the score ratio.
    if (b.removedRate >= 0.25) {
      communityWeights[b.key] = MIN_WEIGHT;
      notes.push(`r/${b.key} removed ${Math.round(b.removedRate * 100)}% of our comments — that room does not want us.`);
    }
  }

  const gapConfidenceFloor: Partial<Record<GapState, number>> = {};
  for (const b of summary.byGapState) {
    if (b.n < MIN_BUCKET) continue;
    if ((b.medianScore || 0) < overall * 0.5) {
      // Demand more certainty rather than banning the move: "said badly" paying
      // off less than average means we are picking bad targets, not that saying
      // something better is a bad idea.
      gapConfidenceFloor[b.key as GapState] = 0.75;
      notes.push(`"${b.key}" comments score below half the account's median — a higher confidence bar now applies to that move.`);
    }
  }

  return { communityWeights, gapConfidenceFloor, exploreRate: DEFAULT_EXPLORE_RATE, notes };
}

/** Weighted choice without replacement — the scan's community order.
 *
 *  Weight is a multiplier on the chance of being FIRST, not a filter: every
 *  community stays in the list, so a bad week never removes a room from the
 *  rotation. */
export function weightedOrder<T>(
  items: T[],
  weightOf: (item: T) => number,
  random: () => number,
): T[] {
  // One exponential draw per item, ordered ascending — the standard weighted
  // sampling trick, and it needs no renormalising as items are removed.
  return [...items]
    .map((item) => {
      const w = Math.max(MIN_WEIGHT, weightOf(item));
      const u = Math.max(random(), Number.EPSILON);
      return { item, key: -Math.log(u) / w };
    })
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

/** Should this scan ignore the scorer? */
export function shouldExplore(rate: number, random: () => number): boolean {
  return random() < Math.min(0.5, Math.max(0, rate));
}
