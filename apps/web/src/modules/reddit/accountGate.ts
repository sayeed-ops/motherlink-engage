import type { RedditAccountStatus } from './types';

// The account posting rate gate.
//
// A PURE function (no I/O, no 'server-only'), so the same decision is used in
// two places that must agree: the accounts UI showing whether an account may
// post, and — later, when publishing moves over — the server re-checking before
// it enqueues a job. Ported verbatim from ML Studio's accountPostGate; only the
// input shape changed, to take epoch-ms fields instead of Dates so a Firestore
// Timestamp (client) and an Admin Timestamp (server) both normalise cleanly.

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The account facts the gate needs, as plain numbers. Callers convert their
 *  Timestamps/Dates to epoch ms once, here, rather than inside the gate. */
export interface GateInput {
  status: RedditAccountStatus;
  dailyCap: number;
  minIntervalMinutes: number;
  postCountToday: number;
  /** Start of the current rolling 24h window, epoch ms (0 if never set). */
  postCountResetAtMs: number;
  /** Last successful post, epoch ms (0 if never). */
  lastPostAtMs: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
  remainingToday: number;
  /** Earliest next post permitted by the min-interval rail, epoch ms (null if
   *  the account has never posted). */
  nextAllowedAtMs: number | null;
}

/**
 * Given an account and "now" (epoch ms), decide whether it may post right now
 * under its own rails. Mirrors the reset logic in recordAccountPost so the UI
 * and the write agree. Returns a reason string when blocked.
 */
export function accountPostGate(a: GateInput, nowMs: number): GateResult {
  const windowExpired = !a.postCountResetAtMs || nowMs - a.postCountResetAtMs >= WINDOW_MS;
  const usedToday = windowExpired ? 0 : a.postCountToday;
  const remainingToday = Math.max(0, a.dailyCap - usedToday);

  const intervalMs = a.minIntervalMinutes * 60 * 1000;
  const nextAllowedAtMs = a.lastPostAtMs ? a.lastPostAtMs + intervalMs : null;

  if (a.status === 'banned') {
    return { ok: false, reason: 'Account is banned.', remainingToday, nextAllowedAtMs };
  }
  if (a.status === 'flagged') {
    return {
      ok: false,
      reason: 'Account is flagged (possible shadowban) — review before posting.',
      remainingToday,
      nextAllowedAtMs,
    };
  }
  if (remainingToday <= 0) {
    return { ok: false, reason: `Daily cap reached (${a.dailyCap}/day).`, remainingToday, nextAllowedAtMs };
  }
  if (a.lastPostAtMs && nowMs - a.lastPostAtMs < intervalMs) {
    return {
      ok: false,
      reason: `Too soon — wait ${a.minIntervalMinutes}m between posts.`,
      remainingToday,
      nextAllowedAtMs,
    };
  }
  return { ok: true, remainingToday, nextAllowedAtMs };
}
