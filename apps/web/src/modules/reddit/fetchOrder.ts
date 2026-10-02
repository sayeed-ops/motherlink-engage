// Which subreddit to fetch next.
//
// PURE — no 'server-only', no Firestore. The server records, the browser orders,
// and both import this.
//
// A fetch walks the project's subreddits one request at a time. It used to walk
// them in the order they were typed into Settings, every time, and to stop at
// the first request that failed outright — so the communities at the top of the
// list were fetched on every run and the ones at the bottom were the ones lost
// whenever a run was cut short. Nothing recorded that, so the next run started
// from the top again and lost the same ones.
//
// Now every attempt is recorded per subreddit, and a run is ordered by NEED:
// whichever community has gone longest without a successful fetch goes first.
// That one rule covers every case that matters —
//
//   never fetched            → first
//   missed by the last run   → ahead of everything that run did reach
//   failed last time         → still as overdue as before it failed, so early
//   fetched a minute ago     → last
//
// — without a separate notion of "the last run" that a closed tab or a timed
// out request could leave half-written.

/** What is remembered about one subreddit, for one kind of fetch. */
export interface FetchRecord {
  /** The last attempt, successful or not. */
  atMs: number;
  /** Whether that attempt worked. */
  ok: boolean;
  /** The last attempt that DID work. 0 when none ever has. The ordering reads
   *  this and nothing else: a failure must not make a community look fresh. */
  okAtMs: number;
}

export type FetchMode = 'new' | 'search';

/** Per mode, because they are different reads: a keyword search that worked
 *  says nothing about whether the community's new posts were collected. */
export type FetchState = Partial<Record<FetchMode, Record<string, FetchRecord>>>;

/** Subreddit names are case-insensitive on Reddit and typed by hand here. */
export const fetchKey = (subreddit: string): string => subreddit.trim().toLowerCase();

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Defensive parse of whatever is on the config document. */
export function normalizeFetchState(raw: unknown): FetchState {
  const out: FetchState = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const mode of ['new', 'search'] as const) {
    const m = (raw as Record<string, unknown>)[mode];
    if (!m || typeof m !== 'object') continue;
    const records: Record<string, FetchRecord> = {};
    for (const [key, value] of Object.entries(m as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const r = value as Record<string, unknown>;
      records[fetchKey(key)] = { atMs: num(r.atMs), ok: r.ok === true, okAtMs: num(r.okAtMs) };
    }
    out[mode] = records;
  }
  return out;
}

/**
 * The order to fetch in: longest since a successful fetch first.
 *
 * Ties keep the order from Settings, so a project that has never fetched
 * anything still starts where the operator expects, and the sort is stable
 * across runs instead of reshuffling communities that are equally fresh.
 */
export function fetchOrder(subreddits: readonly string[], state: FetchState, mode: FetchMode): string[] {
  const records = state[mode] ?? {};
  return subreddits
    .map((subreddit, index) => ({ subreddit, index, okAtMs: records[fetchKey(subreddit)]?.okAtMs ?? 0 }))
    .sort((a, b) => a.okAtMs - b.okAtMs || a.index - b.index)
    .map((s) => s.subreddit);
}

/** The record to store after one attempt. A failure keeps the previous
 *  `okAtMs`, which is what stops it looking freshly fetched. */
export function nextFetchRecord(previous: FetchRecord | undefined, ok: boolean, nowMs: number): FetchRecord {
  return { atMs: nowMs, ok, okAtMs: ok ? nowMs : (previous?.okAtMs ?? 0) };
}

/** "r/a, r/b and 3 more" — for the line that says what a run did not get. */
export function listSubreddits(subreddits: readonly string[], max = 4): string {
  const shown = subreddits.slice(0, max).map((s) => `r/${s}`);
  const rest = subreddits.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}
