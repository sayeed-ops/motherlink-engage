// What actually happened to a comment after it went up.
//
// PURE. No I/O, no clock — the reader and `nowMs` are the caller's problem.
//
// WITHOUT THIS EVERY NUMBER IN THE SYSTEM IS A GUESS. Selection thresholds, the
// gap confidence bars, the bot-tell limits, the weights in opportunityScore —
// all of them are informed priors written down by someone who had never seen an
// outcome. This file is how they stop being priors.
//
// ONE BILLED CALL PER CHECK, and the schedule is deliberately short. A comment's
// score is mostly settled within a day; checking hourly for a week would cost
// more than the comment is worth and tell us almost nothing the 1h/1d/3d
// samples do not.
//
// A COMMENT THAT VANISHED IS THE MOST INFORMATIVE OUTCOME THERE IS. Removed by a
// moderator or by automod is not "score 0" — it is the room rejecting the
// account, which is the failure this whole system is built to avoid. It is
// recorded as its own fact and it stops the schedule: there is nothing left to
// measure.

import type { ThreadSnapshot } from '../reader/types';

export interface OutcomeCheck {
  atMs: number;
  /** Hours after the comment went up. Stored rather than derived, so a record
   *  read months later does not depend on knowing when it was posted. */
  ageHours: number;
  score: number;
  replies: number;
  /** Position among top-level comments, 1-based, by score. THE number the
   *  design cares about — a comment at rank 2 of 40 was read, and the same
   *  score at rank 30 was not. */
  rank: number;
  totalTopLevel: number;
}

export interface CommentOutcome {
  checks: OutcomeCheck[];
  /** The comment is no longer in the thread: removed, or deleted. */
  removed: boolean;
  /** Set when the record is finished — all checks done, or removed. */
  done: boolean;
}

export const EMPTY_OUTCOME: CommentOutcome = { checks: [], removed: false, done: false };

/**
 * When to look, as offsets from the moment the comment went up.
 *
 * 1h catches whether it was seen at all (Reddit's confidence sort decides most
 * of a comment's fate in the first hour), 1d is effectively the final score,
 * and 3d catches the slow burn and any late replies.
 */
export const CHECK_SCHEDULE_MS = [60 * 60_000, 24 * 60 * 60_000, 72 * 60 * 60_000] as const;

/**
 * Our comment's id, out of the permalink the agent captured.
 *
 * The agent reads the permalink from the create-comment network response, which
 * is the only place the id exists — we never chose it. Reddit's shape is
 * /r/{sub}/comments/{postId}/{slug}/{commentId}/, so it is the last segment.
 */
export function commentIdFromPermalink(permalink: string): string | null {
  if (!permalink) return null;
  const path = permalink.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // A permalink to the POST rather than to a comment ends in the slug, which is
  // long and wordy. Reddit ids are short base-36.
  if (!/^(t1_)?[a-z0-9]{4,12}$/i.test(last)) return null;
  if (segments.length < 2 || segments[segments.length - 2] === 'comments') return null;
  return normaliseCommentId(last);
}

/** Reddit hands out `t1_abc` in some places and `abc` in others, and Crawlzo is
 *  not documented on which. Compare on the bare id and the question goes away. */
export function normaliseCommentId(id: string): string {
  return id.replace(/^t1_/i, '').toLowerCase();
}

/** Is a check due, and which one? Null when nothing is owed. */
export function dueCheck(
  outcome: CommentOutcome,
  postedAtMs: number,
  nowMs: number,
): { index: number; dueAtMs: number } | null {
  if (outcome.done || outcome.removed || !postedAtMs) return null;
  const index = outcome.checks.length;
  if (index >= CHECK_SCHEDULE_MS.length) return null;
  const dueAtMs = postedAtMs + CHECK_SCHEDULE_MS[index];
  return nowMs >= dueAtMs ? { index, dueAtMs } : null;
}

/**
 * Measure one check from a freshly-read thread.
 *
 * Returns null when our comment is not in the thread at all, which the caller
 * records as `removed` — not as a zero. Conflating the two would teach the
 * learning loop that a removed comment is merely an unpopular one, and the
 * difference between those is the whole point of measuring.
 */
export function readOutcome(
  thread: ThreadSnapshot,
  commentId: string,
  postedAtMs: number,
  nowMs: number,
): OutcomeCheck | null {
  const target = normaliseCommentId(commentId);
  // Score-descending is the interface's promise, so index is rank.
  const ranked = [...thread.comments].sort((a, b) => b.score - a.score);
  const index = ranked.findIndex((c) => normaliseCommentId(c.commentId) === target);
  if (index === -1) return null;

  const mine = ranked[index];
  return {
    atMs: nowMs,
    ageHours: Math.max(0, Math.round(((nowMs - postedAtMs) / 3_600_000) * 10) / 10),
    score: mine.score,
    replies: mine.replyCount,
    rank: index + 1,
    totalTopLevel: ranked.length,
  };
}

/** Fold a check into the record. Pure: returns the next outcome, never mutates. */
export function withCheck(outcome: CommentOutcome, check: OutcomeCheck | null): CommentOutcome {
  if (!check) return { ...outcome, removed: true, done: true };
  const checks = [...outcome.checks, check];
  return { checks, removed: false, done: checks.length >= CHECK_SCHEDULE_MS.length };
}

/** The last measurement, which is the one worth learning from. */
export function finalCheck(outcome: CommentOutcome): OutcomeCheck | null {
  return outcome.checks.length ? outcome.checks[outcome.checks.length - 1] : null;
}

/** Read an outcome off a Firestore document. Defensive, like normalizeDraft. */
export function normalizeOutcome(raw: unknown): CommentOutcome {
  if (!raw || typeof raw !== 'object') return EMPTY_OUTCOME;
  const o = raw as Record<string, unknown>;
  const checks = Array.isArray(o.checks)
    ? o.checks.filter((c): c is OutcomeCheck => !!c && typeof c === 'object' && typeof (c as OutcomeCheck).score === 'number')
    : [];
  const removed = o.removed === true;
  return { checks, removed, done: removed || checks.length >= CHECK_SCHEDULE_MS.length };
}
