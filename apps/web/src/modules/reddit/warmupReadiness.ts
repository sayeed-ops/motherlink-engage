// When a Reddit account stops being "warming" — the one place that decides.
//
// PURE, like accountGate.ts: the autopilot pass promotes accounts with it, the
// account route refuses a hand-set "active" with it, and the Accounts page shows
// its progress, and all three have to agree.
//
// TWO CLOCKS, BOTH REQUIRED. Age alone would pass an account that sat idle for
// three weeks; activity alone would pass one that did ten days' browsing in its
// first ten days. Age counts from when the account was added to Engage, not from
// its first session, because that is the one date every account has.

import { localDate } from './autopilot';

/** Full days since the account was added to Engage. */
export const READY_AFTER_DAYS = 21;
/** Separate local days with at least one finished warm-up session. */
export const READY_WARMUP_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WarmupRunFacts {
  ranAtMs: number;
  /** A dry run never touched Reddit, so it earned the account nothing. */
  dryRun?: boolean;
}

/** How many separate days, in the account's own time zone, it really warmed up. */
export function countWarmupDays(runs: readonly WarmupRunFacts[], timeZone: string): number {
  const days = new Set<string>();
  for (const run of runs) {
    if (run.dryRun === true || !(run.ranAtMs > 0)) continue;
    days.add(localDate(timeZone, run.ranAtMs));
  }
  return days.size;
}

export interface WarmupReadiness {
  ageDays: number;
  warmupDays: number;
  ready: boolean;
}

export function warmupReadiness(createdAtMs: number, warmupDays: number, nowMs: number): WarmupReadiness {
  const ageDays = createdAtMs > 0 ? Math.max(0, Math.floor((nowMs - createdAtMs) / DAY_MS)) : 0;
  return {
    ageDays,
    warmupDays,
    ready: ageDays >= READY_AFTER_DAYS && warmupDays >= READY_WARMUP_DAYS,
  };
}
