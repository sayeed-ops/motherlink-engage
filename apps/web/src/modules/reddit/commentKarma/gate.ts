// May this account comment right now?
//
// PURE. No I/O, no clock — `nowMs` is passed in, exactly like accountGate.ts.
//
// SEPARATE COUNTERS FROM POSTING, AND THAT IS THE POINT. `postCountToday` and
// `dailyCap` on the account count submitted REPLIES — the thing the account
// exists for. A warm-up comment that consumed one of those slots would silently
// throttle real work, and the throttling would be invisible: a reply would sit
// in the queue saying "daily cap reached" while the cap had been spent on karma
// building. So comments have their own counters, their own cap and their own
// interval.
//
// IT REUSES accountPostGate RATHER THAN REIMPLEMENTING IT. The handoff records
// "rate gate implemented three times" as a known defect; this is the same
// window logic, so it maps comment counters into that function's input and adds
// only the two rails that are genuinely new. If the rolling-window rule is ever
// wrong, it is wrong in one place.

import { accountPostGate, type GateResult } from '../accountGate';
import type { RedditAccountStatus } from '../types';
import type { CommentHistoryEntry } from './botTell';
import type { CommentKarmaSettings } from './settings';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CommentGateInput {
  status: RedditAccountStatus;
  settings: CommentKarmaSettings;

  /** Comment counters — the parallel set. */
  commentCountToday: number;
  commentCountResetAtMs: number;
  lastCommentAtMs: number;

  /**
   * The POSTING counter, read and never written.
   *
   * This is the combined ceiling's only input from the other side of the house.
   * Reading it here means a busy posting day leaves less room for karma
   * building, which is the correct priority; writing it would be the bug this
   * whole file exists to avoid.
   */
  postCountToday: number;
  postCountResetAtMs: number;

  /** This account's recent comments, for the per-subreddit rail. */
  history: CommentHistoryEntry[];
  /** Where this comment would go. */
  subreddit: string;
}

export interface CommentGateResult extends GateResult {
  /** Total actions used in the rolling day, comments plus replies. */
  combinedToday: number;
}

function usedInWindow(count: number, resetAtMs: number, nowMs: number): number {
  const expired = !resetAtMs || nowMs - resetAtMs >= WINDOW_MS;
  return expired ? 0 : count;
}

/** How many comments this account has already made in one subreddit today. */
export function commentsInSubredditToday(
  history: CommentHistoryEntry[],
  subreddit: string,
  nowMs: number,
): number {
  const target = subreddit.toLowerCase();
  return history.filter(
    (e) => e.subreddit.toLowerCase() === target && nowMs - e.postedAtMs < WINDOW_MS,
  ).length;
}

/**
 * The comment rails.
 *
 * Order matters only for which reason is reported first, and the order chosen is
 * "most permanent first": a banned account is not going to become postable in an
 * hour, while a min-interval block is.
 */
export function commentGate(input: CommentGateInput, nowMs: number): CommentGateResult {
  const { settings } = input;

  const base = accountPostGate(
    {
      status: input.status,
      dailyCap: settings.dailyCap,
      minIntervalMinutes: settings.minIntervalMinutes,
      postCountToday: input.commentCountToday,
      postCountResetAtMs: input.commentCountResetAtMs,
      lastPostAtMs: input.lastCommentAtMs,
    },
    nowMs,
  );

  const commentsUsed = usedInWindow(input.commentCountToday, input.commentCountResetAtMs, nowMs);
  const postsUsed = usedInWindow(input.postCountToday, input.postCountResetAtMs, nowMs);
  const combinedToday = commentsUsed + postsUsed;

  if (!base.ok) return { ...base, combinedToday };

  // The combined ceiling. An account that has already made five replies today
  // does not also need three warm-up comments — what a human reading the
  // profile sees is TOTAL activity, and it does not care which of our two
  // systems produced each one.
  if (combinedToday >= settings.combinedDailyCap) {
    return {
      ...base,
      ok: false,
      reason: `Combined ceiling reached — ${combinedToday} action(s) today across replies and comments (limit ${settings.combinedDailyCap}).`,
      combinedToday,
    };
  }

  // The per-subreddit rail. Three comments in one small community in a day is
  // the single most visible pattern to that community's regulars, who are the
  // people most able to act on it.
  const inSub = commentsInSubredditToday(input.history, input.subreddit, nowMs);
  if (inSub >= settings.maxPerSubredditPerDay) {
    return {
      ...base,
      ok: false,
      reason: `Already commented ${inSub} time(s) in r/${input.subreddit} today (limit ${settings.maxPerSubredditPerDay}).`,
      combinedToday,
    };
  }

  return { ...base, combinedToday };
}

/**
 * The counter advance after a comment goes out.
 *
 * Mirrors nextCounters in the agent and recordAccountPost in the app — the same
 * rolling-window reset, on the comment fields. Returned as plain values so the
 * caller decides how to write them (Admin Timestamp, client Timestamp, epoch).
 */
export function nextCommentCounters(
  current: { commentCountToday: number; commentCountResetAtMs: number },
  nowMs: number,
): { commentCountToday: number; commentCountResetAtMs: number; lastCommentAtMs: number } {
  const expired =
    !current.commentCountResetAtMs || nowMs - current.commentCountResetAtMs >= WINDOW_MS;
  return {
    commentCountToday: (expired ? 0 : current.commentCountToday) + 1,
    commentCountResetAtMs: expired ? nowMs : current.commentCountResetAtMs,
    lastCommentAtMs: nowMs,
  };
}
