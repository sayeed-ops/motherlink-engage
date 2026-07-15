// ============================================================
// Client-safe throttling helpers. MUST NOT import server-only modules
// (e.g. undici) — this file is imported by client components too. The
// proxy-aware fetchWithRetry lives in ./redditFetch (server-only).
// ============================================================

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

// Run tasks sequentially with a gap between them so we don't burst Reddit's
// per-IP limit. Returns Promise.allSettled-shaped results in input order, so
// existing call sites that iterate over settled results stay unchanged.
export async function runThrottled<I, O>(
  items: I[],
  fn: (item: I, index: number) => Promise<O>,
  gapMs = 400
): Promise<Settled<O>[]> {
  const out: Settled<O>[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(gapMs);
    try {
      out.push({ status: 'fulfilled', value: await fn(items[i], i) });
    } catch (reason) {
      out.push({ status: 'rejected', reason });
    }
  }
  return out;
}
