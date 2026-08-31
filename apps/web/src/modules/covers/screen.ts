// The free rejections.
//
// PURE, and arithmetic only. Every check here runs BEFORE a model is called,
// because each one can end an opportunity on facts we already hold. The Reddit
// funnel is built the same way and for the same reason: timing screens before
// any model call, and nothing generated that could not have been posted.
//
// ════════════════════════════════════════════════════════════════════════════
// A REJECTION HERE IS NOT A LOW SCORE
//
// These are not weak opportunities. A thread that ended in March is not a
// slightly worse thread; a section we may only watch is not a section we may
// reply to carefully. Everything in this file is a boolean about the world, and
// none of it is negotiable by a model that would like to post something.
//
// The ones that ARE judgements — is this the same subject, does the client
// actually know anything useful, would naming them help — cost money and happen
// later, on the posts that survive this.
// ════════════════════════════════════════════════════════════════════════════

import type { CoversPost } from './parse';
import type { CoversSection } from './sections';
import { normaliseSection } from './sections';

export type ScreenReason =
  /** The section's roles do not include `reply`. Watch-only means watch. */
  | 'section-watch-only'
  /** The section is not in this project's configuration at all. */
  | 'section-unknown'
  /** Nothing has been said in this thread for long enough that a reply arrives
   *  after everyone has left. Measured against the SECTION's own pace. */
  | 'thread-cold'
  /** This specific post is old even if the thread is not. */
  | 'post-stale'
  /** Too little text to be answering anything. */
  | 'post-thin'
  /** Our own account wrote it. */
  | 'our-own-post'
  /** We have already replied in this thread. */
  | 'already-engaged'
  /** Our footprint in this section is at its ceiling for the period. */
  | 'section-saturated'
  /** The event this thread is about has started. */
  | 'event-started';

export const SCREEN_REASON_LABEL: Record<ScreenReason, string> = {
  'section-watch-only': 'This section is watch-only',
  'section-unknown': 'This section is not configured',
  'thread-cold': 'The thread has gone quiet',
  'post-stale': 'The post is too old to answer',
  'post-thin': 'Too little text to answer',
  'our-own-post': 'We wrote this',
  'already-engaged': 'We have already replied in this thread',
  'section-saturated': 'Our footprint in this section is at its ceiling',
  'event-started': 'The event has already started',
};

/**
 * What we have posted, and where.
 *
 * ⚠️ SUPPLIED BY THE CALLER, AND ZERO IS A MEASUREMENT HERE, NOT A DEFAULT.
 *
 * Through phases 2 to 5 there is no posting code for Covers at all, so a zero
 * footprint is a true statement about the world rather than an unread value.
 * When phase 6 gives this module something to count, the counts arrive through
 * this interface and the checks below start firing on their own. What must never
 * happen is a `?? 0` somewhere upstream turning "we did not look" into "we have
 * never posted" — hence a required field rather than an optional one.
 */
export interface Footprint {
  /** Posts of ours in THIS thread. */
  inThread: number;
  /** Posts of ours in this section within the ceiling's window. */
  inSection: number;
  /** Usernames the project posts as, so our own posts are recognisable. */
  ourAuthors: string[];
}

export const EMPTY_FOOTPRINT: Footprint = { inThread: 0, inSection: 0, ourAuthors: [] };

export interface ScreenLimits {
  /** Our own posts allowed in one section per window. */
  maxPerSection: number;
  /** A post shorter than this has nothing in it to answer. */
  minPostChars: number;
  /** How long a thread may be quiet before a reply arrives after everyone has
   *  left, as a multiple of the section's own pace. */
  coldThreadMultiple: number;
  /** How old a post may be inside a thread that is STILL ALIVE. Deliberately
   *  far more permissive — see below. */
  staleMultiple: number;
}

export const DEFAULT_LIMITS: ScreenLimits = {
  maxPerSection: 3,
  // Two words and an emoticon. Measured from real threads: "[peace_5]" and
  // "Dallas 1000 bet ." are both real posts and neither is answerable.
  minPostChars: 40,
  coldThreadMultiple: 6,
  // ⚠️ FOUR TIMES AS PERMISSIVE AS THE COLD-THREAD WINDOW, ON PURPOSE.
  //
  // These answer different questions and the first live run showed what happens
  // when they share a number: `post-stale` fired on 72 of 103 posts, including
  // posts inside threads that were still being replied to that hour.
  //
  // What decides whether a reply is SEEN is the thread being alive — that is
  // `thread-cold`, and it is the check that matters. A post's own age only
  // matters when it is ancient relative to everything around it, which on a
  // long-running thread is a much longer window. The plan's own screen list
  // says "dead thread"; it never said "old post".
  staleMultiple: 24,
};

export interface ScreenInput {
  post: CoversPost;
  /** Epoch ms of the newest post in the thread. */
  threadLastPostAtMs: number | null;
  section: string;
  sections: readonly CoversSection[];
  /** The section's own rhythm — see `sectionPace`. */
  paceMs: number | null;
  footprint: Footprint;
  /** Kickoff for this thread's fixture, when a calendar supplied one. NULL IS
   *  THE NORMAL CASE IN V1 and means unknown, never "has not started". */
  kickoffMs: number | null;
  nowMs: number;
  limits?: ScreenLimits;
}

export interface ScreenVerdict {
  pass: boolean;
  /** EVERY reason, not the first. A post rejected for three things should show
   *  three, or fixing one looks like it should have worked. */
  reasons: ScreenReason[];
  /** What the timing checks actually measured, for the screen and the log. */
  measured: { postAgeMs: number | null; threadQuietMs: number | null; paceMs: number | null };
}

/**
 * The rhythm of one section, measured rather than configured.
 *
 * THE LESSON THE REDDIT PATH LEARNED THE HARD WAY: one age window cannot serve
 * a section whose whole front page turns over in twenty minutes and one whose
 * median thread is three days old. An NFL board on a Sunday and a tennis board
 * in February are the same disagreement.
 *
 * So the window is derived from what the section is actually doing: the median
 * gap between consecutive posts across the threads we hold. Returns null when
 * there is not enough to measure from — and null must be read as "no opinion",
 * which is why the cold-thread check is skipped entirely rather than falling
 * back to a number somebody guessed.
 */
export function sectionPace(threadTimes: readonly (number | null)[]): number | null {
  const times = threadTimes.filter((t): t is number => typeof t === 'number').sort((a, b) => a - b);
  // ⚠️ MEASURE FROM THE LISTING, NOT FROM THE HANDFUL OF THREADS WE OPENED.
  // A harvest reads sixty rows and opens four of them; a median taken from four
  // points is not a measurement of anything, and the first live run took its
  // whole staleness window from exactly that. Ten is the floor at which this is
  // worth believing.
  if (times.length < 10) return null;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];

  // A section where three threads were posted in the same second would
  // otherwise produce a pace of zero and reject everything.
  return median > 0 ? median : null;
}

/** Every free rejection, in one pass. */
export function screen(input: ScreenInput): ScreenVerdict {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const reasons: ScreenReason[] = [];

  // --- the section, which decides whether a reply is permitted at all -------
  const slug = normaliseSection(input.section);
  const section = input.sections.find((s) => s.slug === slug);
  if (!section) {
    reasons.push('section-unknown');
  } else if (!section.roles.includes('reply') && !section.roles.includes('promote')) {
    reasons.push('section-watch-only');
  }

  // --- ours, and whether we have already spoken ----------------------------
  const author = input.post.author.toLowerCase();
  if (author && input.footprint.ourAuthors.some((a) => a.toLowerCase() === author)) {
    reasons.push('our-own-post');
  }
  if (input.footprint.inThread > 0) reasons.push('already-engaged');
  if (input.footprint.inSection >= limits.maxPerSection) reasons.push('section-saturated');

  // --- the post itself ------------------------------------------------------
  if (input.post.body.trim().length < limits.minPostChars) reasons.push('post-thin');

  // --- timing ---------------------------------------------------------------
  const postAgeMs = input.post.createdAtMs === null ? null : input.nowMs - input.post.createdAtMs;
  const threadQuietMs =
    input.threadLastPostAtMs === null ? null : input.nowMs - input.threadLastPostAtMs;

  // No pace means no opinion about age. A guessed window would reject the whole
  // of a slow section or none of a fast one, and both look like the feature
  // working.
  if (input.paceMs !== null) {
    if (threadQuietMs !== null && threadQuietMs > input.paceMs * limits.coldThreadMultiple) {
      reasons.push('thread-cold');
    }
    if (postAgeMs !== null && postAgeMs > input.paceMs * limits.staleMultiple) {
      reasons.push('post-stale');
    }
  }

  // ⚠️ NULL KICKOFF IS "UNKNOWN", NOT "NOT YET". V1 has no schedule feed, so
  // this check does not fire — and it must not fire, because treating unknown as
  // "has not started" and treating it as "has started" are both fabrications.
  // The seam is FixtureCalendar in entities.ts.
  if (input.kickoffMs !== null && input.nowMs >= input.kickoffMs) reasons.push('event-started');

  return {
    pass: reasons.length === 0,
    reasons,
    measured: { postAgeMs, threadQuietMs, paceMs: input.paceMs },
  };
}
