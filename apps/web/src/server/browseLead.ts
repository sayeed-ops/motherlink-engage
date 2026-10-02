import 'server-only';

import { adminDb } from './admin';
import { composeBrowseLead, type BrowseLead } from '@/modules/reddit/browseLead';

// The server half of the browse lead: the one read the pure composer cannot
// make. Everything that decides anything is in modules/reddit/browseLead.ts.

/** When this account's last warm-up session finished, or 0 when it has never
 *  run one. One document, ordered on a single field — no composite index. */
async function lastWarmupAtMs(accountId: string): Promise<number> {
  const snap = await adminDb()
    .collection('accounts')
    .doc(accountId)
    .collection('warmupRuns')
    .orderBy('ranAt', 'desc')
    .limit(1)
    .get();
  const ranAt = snap.docs[0]?.data().ranAt as { toMillis?: () => number } | undefined;
  return ranAt?.toMillis?.() ?? 0;
}

/**
 * The browsing session this account runs before it goes looking for the thread.
 *
 * NEVER THROWS. A lead is an improvement on how a comment arrives, not a
 * condition of posting it: if the read or the composer fails, the job is queued
 * with no lead and opens the way it always did.
 */
export async function browseLeadFor(
  accountId: string,
  account: Record<string, unknown>,
  targetSubreddit: string,
): Promise<BrowseLead> {
  try {
    return composeBrowseLead({
      account,
      targetSubreddit,
      nowMs: Date.now(),
      lastWarmupAtMs: await lastWarmupAtMs(accountId),
    });
  } catch {
    return { plan: [], skipped: 'chance', day: 0, upvoteChance: 0, upvoteBudget: 0, seed: null, estimatedSec: 0 };
  }
}
