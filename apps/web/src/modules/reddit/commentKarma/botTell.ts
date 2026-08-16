// Does the ACCOUNT look like a bot?
//
// PURE. No I/O; `nowMs` and the history are passed in.
//
// THIS IS THE ONE MOST PEOPLE GET WRONG, and it is the reason this file exists
// separately from ./validate.ts and ./conflict.ts, which both judge a comment.
//
//     Bot detection happens across an account, not on one comment.
//     One perfect comment is fine. Fifty perfect comments with the same
//     rhythm is a bot.
//
// Everything upstream of here optimises a single comment, and every one of those
// optimisations pushes toward the same comment every time: the measured length,
// the measured register, the considered answer, the best hour to post. Run that
// fifty times and the account's profile page — which is what a suspicious human
// actually opens — is fifty comments of the same length, the same shape and the
// same time of day. So this gate is the counterweight, and it does two things:
//
//   1. REFUSES a comment that would extend a pattern.
//   2. STEERS the next one, through botTellPressure(), which is fed into
//      generation. Steering before the model writes is cheaper than rejecting
//      after, and it is the only mechanism that makes the account occasionally
//      unimpressive on purpose — "same", a short laugh, three words. Real people
//      do that constantly, and an account where every comment is considered is
//      not a real account.
//
// A NEW ACCOUNT MUST NOT BE BLOCKED. Below MIN_HISTORY there is no pattern to
// detect, and refusing on no evidence would deadlock exactly like an unknown
// subreddit in select.ts: the account could never build the history the gate
// needs to judge it. Same rule, written down twice on purpose.

import { countWords } from './roomProfile';

export interface CommentHistoryEntry {
  postedAtMs: number;
  /** Counted with countWords, like everything else. */
  words: number;
  subreddit: string;
  /** First few words, normalised. See openingOf. */
  opening: string;
}

export interface CommentProposal {
  words: number;
  opening: string;
  subreddit: string;
}

export type BotTellCode =
  /** This account has opened a comment this way recently. */
  | 'opening-repeat'
  /** Every comment is the same size, and so is this one. */
  | 'length-uniform'
  /** Every comment is a considered one. Real people post rubbish sometimes. */
  | 'all-considered'
  /** The gaps between comments are too even to be a person. */
  | 'cadence-regular'
  /** Every comment lands inside the same few hours of the clock. */
  | 'clock-narrow'
  /** Everything in one subreddit. */
  | 'sub-monotony';

export interface BotTellFailure {
  code: BotTellCode;
  detail: string;
}

export interface BotTellPressure {
  /** Write something short and unremarkable this time. */
  wantsBrief: boolean;
  /** Openings to avoid, passed into the generation prompt. */
  avoidOpenings: string[];
  /** A hard word ceiling when the recent lengths are too alike, or null. */
  lengthCeiling: number | null;
}

/** Below this there is no pattern, only a short history. */
export const MIN_HISTORY = 5;
/** A comment this short or shorter is the unimpressive kind. */
export const BRIEF_MAX_WORDS = 8;
/** How far back the text-level checks look. Beyond this nobody scrolling a
 *  profile is still reading. */
export const RECENT_WINDOW = 10;

/** The first three words, lowercased and stripped.
 *
 *  Three because that is what a person scrolling a profile actually sees
 *  repeating. This is THE function for building history entries too, so a
 *  comparison is never between two different notions of "opening". */
export function openingOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

/** Build a history entry from a comment we posted. */
export function historyEntryOf(
  text: string,
  subreddit: string,
  postedAtMs: number,
): CommentHistoryEntry {
  return { postedAtMs, words: countWords(text), subreddit, opening: openingOf(text) };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Coefficient of variation — spread relative to size, so it compares a room of
 *  one-liners with a room of essays without being told which is which. */
function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  if (!m) return 0;
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(variance) / m;
}

/** How wide a span of the 24h clock these comments cover, in hours.
 *
 *  Circular: comments at 23:00 and 01:00 are two hours apart, not twenty-two.
 *  Computed as 24 minus the largest empty gap.
 *
 *  UTC deliberately, and it does not need to be the account's local time: a
 *  constant offset moves every hour by the same amount and cannot change the
 *  span. What is being measured is the WIDTH of the window, never where on the
 *  clock it sits — an account that only ever posts at breakfast is a person,
 *  and an account that only ever posts inside the same 90 minutes is a cron. */
export function clockSpanHours(timesMs: number[]): number {
  if (timesMs.length < 2) return 24;
  const hours = timesMs.map((t) => new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60).sort((a, b) => a - b);
  let biggestGap = hours[0] + 24 - hours[hours.length - 1];
  for (let i = 1; i < hours.length; i++) {
    biggestGap = Math.max(biggestGap, hours[i] - hours[i - 1]);
  }
  return 24 - biggestGap;
}

/** Thresholds. Priors, not measurements — collected so the learning loop can
 *  replace them with values fitted to accounts that did and did not survive. */
export const BOT_TELL_LIMITS = {
  /** Below this, the recent lengths are suspiciously alike. */
  minLengthCV: 0.35,
  /** Below this, the gaps between comments are suspiciously even. */
  minCadenceCV: 0.4,
  /** Fewer than this many gaps and cadence means nothing. */
  minGapsForCadence: 5,
  /** A clock span narrower than this, across enough comments, is a schedule. */
  minClockSpanHours: 6,
  /** How many comments in a row in one subreddit before it is the only room the
   *  account has ever been in. */
  maxSameSubStreak: 8,
  /** Considered comments in a row before one has to be throwaway. */
  maxConsideredStreak: 12,
};

function recent(history: CommentHistoryEntry[], n = RECENT_WINDOW): CommentHistoryEntry[] {
  return [...history].sort((a, b) => b.postedAtMs - a.postedAtMs).slice(0, n);
}

/**
 * What the next comment should do differently. Read BEFORE generating.
 *
 * Returns nothing to act on when the history is too short — a new account is
 * unconstrained, which is also what a new account looks like.
 */
export function botTellPressure(history: CommentHistoryEntry[]): BotTellPressure {
  const none: BotTellPressure = { wantsBrief: false, avoidOpenings: [], lengthCeiling: null };
  if (history.length < MIN_HISTORY) return none;

  const last = recent(history);
  const lengths = last.map((e) => e.words);
  const allConsidered = last.every((e) => e.words > BRIEF_MAX_WORDS);

  return {
    // Only once there is a real streak of them. Asking for a throwaway comment
    // after four considered ones would make throwaway comments the pattern.
    wantsBrief:
      allConsidered && history.length >= BOT_TELL_LIMITS.maxConsideredStreak,
    avoidOpenings: [...new Set(last.map((e) => e.opening).filter(Boolean))],
    lengthCeiling:
      coefficientOfVariation(lengths) < BOT_TELL_LIMITS.minLengthCV
        ? Math.max(BRIEF_MAX_WORDS, Math.round(Math.min(...lengths) * 0.8))
        : null,
  };
}

/**
 * The timing half of the gate — TEXT-INDEPENDENT, so it runs first.
 *
 * Separated because these failures cannot be fixed by writing a different
 * comment; the fix is to wait, or to go somewhere else. Running it before
 * generation means a run that was never going to be allowed costs no model
 * calls at all, which is the same cost discipline as the two-stage selection in
 * ./select.ts.
 */
export function screenAccountTiming(
  history: CommentHistoryEntry[],
  subreddit: string,
  nowMs: number,
): { ok: boolean; failures: BotTellFailure[] } {
  const failures: BotTellFailure[] = [];
  if (history.length < MIN_HISTORY) return { ok: true, failures };

  const sorted = [...history].sort((a, b) => a.postedAtMs - b.postedAtMs);

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].postedAtMs - sorted[i - 1].postedAtMs);
  gaps.push(Math.max(0, nowMs - sorted[sorted.length - 1].postedAtMs));

  if (gaps.length >= BOT_TELL_LIMITS.minGapsForCadence) {
    const cv = coefficientOfVariation(gaps);
    if (cv < BOT_TELL_LIMITS.minCadenceCV) {
      failures.push({
        code: 'cadence-regular',
        detail: `gaps between comments vary by only ${Math.round(cv * 100)}% — a person is lumpier than that`,
      });
    }
  }

  const span = clockSpanHours([...sorted.map((e) => e.postedAtMs), nowMs]);
  if (span < BOT_TELL_LIMITS.minClockSpanHours) {
    failures.push({
      code: 'clock-narrow',
      detail: `every comment falls inside the same ${Math.round(span)}h of the day`,
    });
  }

  // Counted from the most recent backwards: a streak that ENDS now is the one
  // visible on the profile, and an account that used to only post in one sub has
  // already fixed the problem.
  const newestFirst = [...sorted].reverse();
  let streak = 0;
  for (const e of newestFirst) {
    if (e.subreddit.toLowerCase() !== subreddit.toLowerCase()) break;
    streak++;
  }
  if (streak >= BOT_TELL_LIMITS.maxSameSubStreak) {
    failures.push({
      code: 'sub-monotony',
      detail: `the last ${streak} comments were all in r/${subreddit}`,
    });
  }

  return { ok: failures.length === 0, failures };
}

/**
 * The text half — would THIS comment extend a pattern?
 *
 * Note the asymmetry that makes this a gate rather than a statistic: a uniform
 * history does not fail on its own. It fails only when the proposed comment
 * lands inside the same band, because a comment that breaks the pattern is the
 * fix, not the offence.
 */
export function screenBotTell(
  proposal: CommentProposal,
  history: CommentHistoryEntry[],
): { ok: boolean; failures: BotTellFailure[] } {
  const failures: BotTellFailure[] = [];
  if (history.length < MIN_HISTORY) return { ok: true, failures };

  const last = recent(history);

  if (proposal.opening && last.some((e) => e.opening === proposal.opening)) {
    failures.push({
      code: 'opening-repeat',
      detail: `this account already opened a comment with "${proposal.opening}"`,
    });
  }

  const lengths = last.map((e) => e.words);
  const m = mean(lengths);
  if (coefficientOfVariation(lengths) < BOT_TELL_LIMITS.minLengthCV && m > 0) {
    const drift = Math.abs(proposal.words - m) / m;
    if (drift < 0.15) {
      failures.push({
        code: 'length-uniform',
        detail: `the last ${lengths.length} comments average ${Math.round(m)} words and this one is ${proposal.words}`,
      });
    }
  }

  if (
    history.length >= BOT_TELL_LIMITS.maxConsideredStreak &&
    last.every((e) => e.words > BRIEF_MAX_WORDS) &&
    proposal.words > BRIEF_MAX_WORDS
  ) {
    failures.push({
      code: 'all-considered',
      detail: 'every recent comment is a considered one; this account never just says "same"',
    });
  }

  return { ok: failures.length === 0, failures };
}
