// The gates, composed — and the order they run in, which is the point of the
// file.
//
// PURE. Everything here is arithmetic over data the caller already has.
//
// ORDER IS A COST CONTROL, exactly as it is in ./select.ts:
//
//   1. screenBeforeGeneration — account timing. Text-independent, so a run that
//      was never going to be permitted spends NOTHING: no gap call, no
//      generation, no critic.
//   2. screenCandidates — every mechanical, conflict and bot-tell check on each
//      written candidate. Free, and it runs BEFORE the critic, so the critic is
//      only ever asked to judge comments that could actually be posted. If
//      nothing survives, the critic call is skipped entirely and the outcome is
//      a skip — which is the normal outcome anyway.
//   3. runGates on the chosen one, again. Cheap, and it is the last thing
//      between a model's output and an account's reputation.
//
// FAILURES ARE COLLECTED, NEVER SHORT-CIRCUITED. Phase 4's review panel has to
// show an operator why nothing was posted, and "too long" on its own hides the
// fact that it also linked to something and named a user.

import type { ThreadComment } from '../reader/types';
import {
  screenAccountTiming,
  screenBotTell,
  openingOf,
  type BotTellFailure,
  type CommentHistoryEntry,
} from './botTell';
import { screenConflict, type ConflictFailure } from './conflict';
import { countWords, type RoomProfile } from './roomProfile';
import { validateComment, type Failure as ValidationFailure } from './validate';

export type GateName = 'mechanical' | 'conflict' | 'bot-tell';

export interface GateFailure {
  gate: GateName;
  code: string;
  detail: string;
}

export interface GateContext {
  /** From targetLength(profile). Measured, never chosen. */
  length: { min: number; max: number; target: number };
  profile: RoomProfile;
  /** The thread we would be commenting in. */
  comments: ThreadComment[];
  subreddit: string;
  /** This account's recent comments. Empty for a new account, which passes. */
  history: CommentHistoryEntry[];
  /** Brands and clients this account must never mention. */
  bannedTerms?: string[];
}

const tag = (gate: GateName) => (f: ValidationFailure | ConflictFailure | BotTellFailure): GateFailure => ({
  gate,
  code: f.code,
  detail: f.detail,
});

/**
 * Before any model is called: is this account allowed to comment at all right
 * now, anywhere?
 *
 * Nothing here is about the comment, so nothing here can be fixed by writing a
 * better one — the fix is to wait, or to go to a different subreddit.
 */
export function screenBeforeGeneration(ctx: GateContext, nowMs: number): { ok: boolean; failures: GateFailure[] } {
  const timing = screenAccountTiming(ctx.history, ctx.subreddit, nowMs);
  return { ok: timing.ok, failures: timing.failures.map(tag('bot-tell')) };
}

/** Every check that applies to one piece of text. */
export function runGates(text: string, ctx: GateContext): { ok: boolean; failures: GateFailure[] } {
  const mechanical = validateComment(text, {
    length: ctx.length,
    profile: ctx.profile,
    bannedTerms: ctx.bannedTerms,
    existing: ctx.comments,
  });
  const conflict = screenConflict(text, ctx.comments);
  const botTell = screenBotTell(
    { words: countWords(text), opening: openingOf(text), subreddit: ctx.subreddit },
    ctx.history,
  );

  const failures = [
    ...mechanical.failures.map(tag('mechanical')),
    ...conflict.failures.map(tag('conflict')),
    ...botTell.failures.map(tag('bot-tell')),
  ];
  return { ok: failures.length === 0, failures };
}

export interface ScreenedCandidate {
  index: number;
  text: string;
  failures: GateFailure[];
}

/**
 * Filter written candidates down to the ones that could be posted.
 *
 * Both halves are returned. The rejected ones are not waste: they are the
 * record of what the generator keeps producing, and the fastest way to notice
 * that a prompt has drifted is that every candidate now fails the same gate.
 */
export function screenCandidates(
  texts: string[],
  ctx: GateContext,
): { survivors: ScreenedCandidate[]; rejected: ScreenedCandidate[] } {
  const survivors: ScreenedCandidate[] = [];
  const rejected: ScreenedCandidate[] = [];

  texts.forEach((text, index) => {
    const { ok, failures } = runGates(text, ctx);
    (ok ? survivors : rejected).push({ index, text, failures });
  });

  return { survivors, rejected };
}
