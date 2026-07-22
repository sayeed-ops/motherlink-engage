import 'server-only';

import { adminDb } from './admin';

// Account activity ledger — OUR OWN data, aggregated from the `jobs` queue.
//
// The counterpart to AccountStats (Reddit-side truth captured by the agent).
// Everything the tool did with an account — what it posted, in which subreddit,
// whether it succeeded — is already ours; we never scrape Reddit for it. This
// aggregates `jobs` (which carry accountId, subreddit, status, permalink, dates)
// into the numbers the account Dashboard shows. Read via a server route because
// jobs carry the reply body and a client query across all of an account's jobs
// would cross project boundaries the rules scope per-project.

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export interface AccountActivityPost {
  jobId: string;
  projectId: string;
  subreddit: string;
  status: string; // queued | posting | posted | failed | cancelled
  permalink: string;
  threadUrl: string;
  createdAtMs: number;
  completedAtMs: number;
}

export interface AccountActivity {
  totalJobs: number;
  posted: number;
  failed: number;
  pending: number; // queued or posting
  cancelled: number;
  firstPostAtMs: number; // earliest successful post through the tool, 0 if none
  lastPostAtMs: number; // most recent successful post, 0 if none
  bySubreddit: { subreddit: string; posted: number; total: number }[];
  recent: AccountActivityPost[]; // newest first, capped
}

/** Aggregate an account's job history into Dashboard figures. */
export async function getAccountActivity(accountId: string, recentLimit = 15): Promise<AccountActivity> {
  const snap = await adminDb().collection('jobs').where('accountId', '==', accountId).get();

  const posts: AccountActivityPost[] = snap.docs.map((d) => {
    const j = d.data();
    return {
      jobId: d.id,
      projectId: String(j.projectId ?? ''),
      subreddit: String(j.subreddit ?? ''),
      status: String(j.status ?? ''),
      permalink: String(j.permalink ?? ''),
      threadUrl: String(j.threadUrl ?? ''),
      createdAtMs: toMs(j.createdAt),
      completedAtMs: toMs(j.completedAt),
    };
  });

  let posted = 0;
  let failed = 0;
  let pending = 0;
  let cancelled = 0;
  let firstPostAtMs = 0;
  let lastPostAtMs = 0;
  const subMap = new Map<string, { posted: number; total: number }>();

  for (const p of posts) {
    if (p.status === 'posted') posted += 1;
    else if (p.status === 'failed') failed += 1;
    else if (p.status === 'cancelled') cancelled += 1;
    else pending += 1; // queued | posting

    const sub = p.subreddit || '(unknown)';
    const cur = subMap.get(sub) ?? { posted: 0, total: 0 };
    cur.total += 1;
    if (p.status === 'posted') cur.posted += 1;
    subMap.set(sub, cur);

    if (p.status === 'posted') {
      const at = p.completedAtMs || p.createdAtMs;
      if (at) {
        if (!firstPostAtMs || at < firstPostAtMs) firstPostAtMs = at;
        if (at > lastPostAtMs) lastPostAtMs = at;
      }
    }
  }

  const bySubreddit = [...subMap.entries()]
    .map(([subreddit, v]) => ({ subreddit, ...v }))
    .sort((a, b) => b.total - a.total);

  const recent = posts
    .sort((a, b) => (b.completedAtMs || b.createdAtMs) - (a.completedAtMs || a.createdAtMs))
    .slice(0, recentLimit);

  return {
    totalJobs: posts.length,
    posted,
    failed,
    pending,
    cancelled,
    firstPostAtMs,
    lastPostAtMs,
    bySubreddit,
    recent,
  };
}
