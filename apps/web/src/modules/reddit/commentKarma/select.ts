// Which posts are worth commenting on — the arithmetic half of the decision.
//
// PURE. No 'server-only', no Firestore, no fetch, no clock — `nowMs` is passed
// in. Same discipline as accountGate.ts and llm/select.ts, and for the same
// reason: this decides where an account spends its reputation, it is the part
// most likely to be got subtly wrong, and it must be testable directly rather
// than through a network.
//
// It answers "will this comment be SEEN", which is a different question from
// "is this worth saying" — that one needs a model and lives in ./gaps.ts.
// Expected upvotes are roughly:
//
//     reach(post) x slot(position) x quality(comment)
//
// Everything here is the first two terms. Most people optimise only the third,
// which is why an excellent comment in position 40 of a dead thread earns two
// points and a mediocre one in position 2 of a rising thread earns two hundred.
//
// NOTE ON THE NUMBERS: every threshold below is an informed PRIOR, not a
// measurement. They are collected in DEFAULT_LIMITS so the learning loop can
// replace them with fitted values per subreddit. Do not read them as facts.

import type { PostSummary, ThreadComment } from '../reader/types';

export type RejectReason =
  /** Image, video, gallery — or a type the reader could not determine. */
  | 'media'
  /** A link post we would be commenting on without having read the target. */
  | 'link-post'
  /** Text post with no body and a title that asks nothing. Nothing to answer. */
  | 'nothing-to-answer'
  | 'locked'
  | 'archived'
  | 'stickied'
  | 'nsfw'
  /** Too new to tell whether it is rising, and too few readers so far. */
  | 'too-young'
  /** Comment ranking has settled; the visible slots are taken. */
  | 'too-old'
  /** So many comments that a new one is invisible. */
  | 'crowded'
  /** Top comment is out of reach. */
  | 'unbeatable'
  /** Upvote ratio says the room is already fighting. */
  | 'contested'
  /** Below the subreddit's own median pace — not going anywhere. */
  | 'not-rising'
  /** Randomised comment order: there is no position to compete for. */
  | 'contest-mode'
  | 'quarantined'
  /** Already removed by a moderator or automod. */
  | 'removed'
  /** Score suppressed, so velocity and slot signals are meaningless. */
  | 'score-hidden';

export interface SelectLimits {
  minAgeMinutes: number;
  maxAgeHours: number;
  maxComments: number;
  maxTopCommentScore: number;
  /** Below this the thread is an argument, not a discussion. */
  minUpvoteRatio: number;
  /** A comment at or above this counts as occupying a visible slot. */
  visibleCommentScore: number;
}

/**
 * Priors, not measurements.
 *
 * The age window is the single highest-leverage rule here. Early enough that the
 * top slots are still contestable, late enough that velocity means something —
 * and it matters more than it looks, because Reddit sorts comments by a
 * CONFIDENCE sort rather than raw score. Early votes compound, so arriving in
 * the first hours of a rising thread beats writing a better comment later.
 */
export const DEFAULT_LIMITS: SelectLimits = {
  minAgeMinutes: 30,
  maxAgeHours: 6,
  maxComments: 60,
  maxTopCommentScore: 150,
  minUpvoteRatio: 0.75,
  visibleCommentScore: 10,
};

/** What "normal pace" looks like in one subreddit.
 *
 *  Raw velocity is meaningless across subs — 80 upvotes/hour is dead in a
 *  default sub and explosive in a 20k niche one — so every post is judged
 *  against its own room. Computed from the account's own listing history by the
 *  caller; null means "no baseline yet", which must NOT be treated as failing. */
export interface SubBaseline {
  subreddit: string;
  medianVelocity: number;
  /** Median absolute deviation. Floored at 1 by the caller of `velocityZ`. */
  madVelocity: number;
}

export interface CandidateInput {
  post: PostSummary;
  /** Top-level comments. Empty array is a legitimate, GOOD case — an uncrowded
   *  thread — and must not be confused with "not fetched". */
  comments: ThreadComment[];
  baseline: SubBaseline | null;
  nowMs: number;
  limits?: SelectLimits;
}

export interface Signals {
  ageHours: number;
  velocity: number;
  velocityZ: number | null;
  saturation: number;
  slotAvailability: number;
  visibleCompetitors: number;
  topCommentScore: number;
  questionShaped: boolean;
  opActive: boolean;
}

export interface Verdict {
  ok: boolean;
  reason: RejectReason | null;
  /** Higher is better. Only meaningful when `ok`. */
  score: number;
  signals: Signals;
}

const QUESTION_OPENERS =
  /^(how|what|why|when|where|which|should|is|are|do|does|did|can|could|would|has|have|anyone|has anyone|does anyone|am i|looking for|need help|help)\b/i;

const QUESTION_FLAIR = /(question|help|advice|discussion|support|seeking)/i;

/** Does this post invite an answer?
 *
 *  Load-bearing for AskReddit-shaped posts, which are the bread and butter here:
 *  they are text posts with an EMPTY body and the entire content in the title.
 *  A naive "needs a body" rule would reject the highest-yield category in the
 *  product. */
export function isQuestionShaped(post: PostSummary): boolean {
  const t = post.title.trim();
  if (t.endsWith('?')) return true;
  if (QUESTION_OPENERS.test(t)) return true;
  return !!post.flair && QUESTION_FLAIR.test(post.flair);
}

/** How far above or below its subreddit's normal pace this post is running.
 *  Null when there is no baseline yet. */
export function velocityZ(velocity: number, baseline: SubBaseline | null): number | null {
  if (!baseline) return null;
  return (velocity - baseline.medianVelocity) / Math.max(baseline.madVelocity, 1);
}

function computeSignals(input: CandidateInput): Signals {
  const { post, comments, baseline, nowMs } = input;

  const ageHours = Math.max((nowMs - post.createdAtMs) / 3_600_000, 0);
  // Floor the divisor rather than the age: a 5-minute-old post with 20 points
  // is not running at 240/hour in any meaningful sense.
  const velocity = post.score / Math.max(ageHours, 0.25);

  const visibleScore = (input.limits ?? DEFAULT_LIMITS).visibleCommentScore;
  const visibleCompetitors = comments.filter((c) => c.score >= visibleScore).length;
  const topCommentScore = comments.reduce((m, c) => Math.max(m, c.score), 0);

  return {
    ageHours,
    velocity,
    velocityZ: velocityZ(velocity, baseline),
    saturation: post.numComments / Math.max(post.score, 1),
    slotAvailability: 1 / (1 + visibleCompetitors),
    visibleCompetitors,
    topCommentScore,
    questionShaped: isQuestionShaped(post),
    opActive: comments.some((c) => c.isOp),
  };
}

/**
 * Stage one: everything decidable from a SEARCH RESULT, with no comment tree.
 *
 * This split is about money, not tidiness. Crawlzo bills per call, its search
 * results carry no comments (`comments: null`), and the comment-dependent
 * signals therefore cost one extra billable request PER POST. Screening here
 * first means the bill scales with survivors instead of candidates. Folding this
 * back into judgeCandidate would work and would quietly multiply the cost by the
 * rejection rate — which is high by design, since skipping is the normal
 * outcome. See docs/CRAWLZO-API.md.
 *
 * Pass the same `nowMs` you will pass to judgeCandidate.
 */
export function screenListing(
  post: PostSummary,
  nowMs: number,
  baseline: SubBaseline | null = null,
  limits: SelectLimits = DEFAULT_LIMITS,
): RejectReason | null {
  // Content type first — cheapest, and the most consequential. `unknown` rejects
  // deliberately: a reader that cannot tell us what the post is must not have
  // that read as "text", or we comment on images we cannot see. Crawlzo's
  // `crosspost` maps to `unknown` for the same reason — the real content is one
  // level down and we have not looked at it.
  if (post.media === 'image' || post.media === 'video' || post.media === 'gallery') return 'media';
  if (post.media === 'unknown' || post.media === 'poll') return 'media';
  if (post.media === 'link') return 'link-post';

  if (post.isRemoved) return 'removed';
  if (post.isQuarantined) return 'quarantined';
  if (post.isLocked) return 'locked';
  if (post.isArchived) return 'archived';
  // Usually a moderator announcement or a megathread — a rules post, or a crowd
  // nobody reads to the bottom of.
  if (post.isStickied) return 'stickied';
  if (post.isNsfw) return 'nsfw';
  // No position to compete for, so every ranking signal below is void.
  if (post.isContestMode) return 'contest-mode';
  // `score` is not the real number here, so velocity and slot are not merely
  // noisy — they are meaningless.
  if (post.isScoreHidden) return 'score-hidden';

  const questionShaped = isQuestionShaped(post);
  if (!post.body.trim() && !questionShaped) return 'nothing-to-answer';

  const ageHours = Math.max((nowMs - post.createdAtMs) / 3_600_000, 0);
  if (ageHours * 60 < limits.minAgeMinutes) return 'too-young';
  if (ageHours > limits.maxAgeHours) return 'too-old';

  if (post.numComments > limits.maxComments) return 'crowded';

  // Only when the reader supplied a ratio. Null means unknown, and unknown is
  // not evidence of a fight.
  if (post.upvoteRatio !== null && post.upvoteRatio < limits.minUpvoteRatio) return 'contested';

  // Last, because it is the only one needing a baseline. A subreddit with no
  // history must NOT have everything rejected — that would deadlock, since the
  // system could then never build the history it needs to judge that subreddit.
  const z = velocityZ(post.score / Math.max(ageHours, 0.25), baseline);
  if (z !== null && z < 0) return 'not-rising';

  return null;
}

/** Stage two: the checks that need the comment tree, and therefore a paid call. */
function reject(input: CandidateInput, s: Signals): RejectReason | null {
  const lim = input.limits ?? DEFAULT_LIMITS;

  const listingReason = screenListing(input.post, input.nowMs, input.baseline, lim);
  if (listingReason) return listingReason;

  if (s.topCommentScore > lim.maxTopCommentScore) return 'unbeatable';

  return null;
}

/** Squash an unbounded signal into 0..1 so the weights below mean something. */
function norm(x: number): number {
  return x <= 0 ? 0 : x / (1 + x);
}

/**
 * Rank a surviving candidate. Higher is better.
 *
 * Weights are priors. `velocityZ` leads because reach dominates the other two
 * terms, and slot availability follows because being visible is worth more than
 * the thread being a perfect fit.
 */
export function opportunityScore(s: Signals): number {
  return (
    1.0 * norm(s.velocityZ ?? 0) +
    0.8 * s.slotAvailability +
    0.6 * (s.questionShaped ? 1 : 0) +
    0.5 * (s.opActive ? 1 : 0) +
    0.4 * (1 - norm(s.saturation))
  );
}

/** Judge one post. Never throws; an unusable post is a verdict, not an error. */
export function judgeCandidate(input: CandidateInput): Verdict {
  const signals = computeSignals(input);
  const reason = reject(input, signals);
  return {
    ok: reason === null,
    reason,
    score: reason === null ? opportunityScore(signals) : 0,
    signals,
  };
}

/** Judge many, keep the survivors, best first. */
export function rankCandidates(inputs: CandidateInput[]): { input: CandidateInput; verdict: Verdict }[] {
  return inputs
    .map((input) => ({ input, verdict: judgeCandidate(input) }))
    .filter((r) => r.verdict.ok)
    .sort((a, b) => b.verdict.score - a.verdict.score);
}

/** Build a subreddit's pace baseline from posts already seen there.
 *
 *  Median and MAD rather than mean and standard deviation: one post reaching the
 *  front page would drag a mean so far that everything else in the sub reads as
 *  "not rising". */
export function computeBaseline(subreddit: string, posts: PostSummary[], nowMs: number): SubBaseline | null {
  const velocities = posts
    .map((p) => {
      const ageHours = Math.max((nowMs - p.createdAtMs) / 3_600_000, 0);
      return p.score / Math.max(ageHours, 0.25);
    })
    .sort((a, b) => a - b);

  // Too few points and the "median" is just one post's luck.
  if (velocities.length < 5) return null;

  const median = middle(velocities);
  const deviations = velocities.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { subreddit, medianVelocity: median, madVelocity: middle(deviations) };
}

function middle(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
