import 'server-only';

import { adminDb } from './admin';

// Read the full context of ONE comment this account posted — the original post,
// our analysis, and the comment itself — assembled from our OWN stored copies.
//
// This exists so reviewing a posted reply never means opening the live comment on
// reddit.com. Repeatedly landing on the comment permalinks of a set of accounts
// from one reviewer's browser/IP is its own correlation signal; showing our saved
// copy in-app avoids generating any Reddit pageview at all. Everything here is
// data we already hold: the post (items), the analysis (analyses), the reply
// (drafts). A job resolves to its draft, and the draft carries postId + analysisId.

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

export interface AccountPostContext {
  jobId: string;
  subreddit: string;
  threadUrl: string;
  post: {
    title: string;
    body: string;
    author: string;
    url: string;
    permalink: string;
    score: number;
    numComments: number;
  } | null;
  analysis: {
    decision: string;
    score: number;
    reason: string;
    suggestedAngle: string;
    growthScore: number | null;
    growthAngle: string;
    riskLevel: string;
  } | null;
  comment: {
    body: string;
    permalink: string;
    status: string;
    postedAtMs: number;
  } | null;
}

/** Assemble the post + analysis + comment for one of an account's jobs, or null
 *  if the job doesn't exist or isn't this account's. */
export async function getAccountPostContext(accountId: string, jobId: string): Promise<AccountPostContext | null> {
  const jobSnap = await adminDb().collection('jobs').doc(jobId).get();
  if (!jobSnap.exists) return null;
  const job = jobSnap.data() as Record<string, unknown>;
  if (job.accountId !== accountId) return null; // never leak another account's job

  const projectId = String(job.projectId ?? '');
  const project = adminDb().collection('projects').doc(projectId);

  const draftSnap = projectId && job.draftId ? await project.collection('drafts').doc(String(job.draftId)).get() : null;
  const draft = draftSnap?.exists ? (draftSnap.data() as Record<string, unknown>) : null;

  let post: AccountPostContext['post'] = null;
  let analysis: AccountPostContext['analysis'] = null;

  if (draft?.postId) {
    const itemSnap = await project.collection('items').doc(String(draft.postId)).get();
    if (itemSnap.exists) {
      const p = itemSnap.data() as Record<string, unknown>;
      post = {
        title: String(p.title ?? ''),
        body: String(p.body ?? ''),
        author: String(p.author ?? ''),
        url: String(p.url ?? ''),
        permalink: String(p.permalink ?? ''),
        score: Number(p.score) || 0,
        numComments: Number(p.numComments) || 0,
      };
    }
  }

  // Fall back to the copy denormalised onto the job at publish time, so the reader
  // still shows the original post even after the item was purged.
  if (!post && (job.postTitle || job.postBody)) {
    post = {
      title: String(job.postTitle ?? ''),
      body: String(job.postBody ?? ''),
      author: String(job.postAuthor ?? ''),
      url: String(job.threadUrl ?? ''),
      permalink: String(job.threadUrl ?? ''),
      score: 0,
      numComments: 0,
    };
  }

  if (draft?.analysisId) {
    const anSnap = await project.collection('analyses').doc(String(draft.analysisId)).get();
    if (anSnap.exists) {
      const a = anSnap.data() as Record<string, unknown>;
      analysis = {
        decision: String(a.decision ?? ''),
        score: Number(a.score) || 0,
        reason: String(a.reason ?? ''),
        suggestedAngle: String(a.suggestedAngle ?? ''),
        growthScore: typeof a.growthScore === 'number' ? a.growthScore : null,
        growthAngle: String(a.growthAngle ?? ''),
        riskLevel: String(a.riskLevel ?? ''),
      };
    }
  }

  const comment = draft
    ? {
        body: String(draft.body ?? ''),
        permalink: String(draft.postedPermalink ?? job.permalink ?? ''),
        status: String(draft.status ?? job.status ?? ''),
        postedAtMs: toMs(draft.postedAt),
      }
    : null;

  return {
    jobId,
    subreddit: String(job.subreddit ?? ''),
    threadUrl: String(job.threadUrl ?? ''),
    post,
    analysis,
    comment,
  };
}
