import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';

// The post queue — jobs the (future) local agent drains to post on Reddit.
//
// Top-level, like accounts: one agent drains one global queue across all
// clients. A job is fully denormalised so the agent needs no extra reads — it
// carries the thread URL, the AdsPower profile to open, the username to verify,
// and the reply body.
//
// Enqueuing is server-only and gated on drafts.publish (the irreversible tier).
// Writing a job does NOT post anything by itself — nothing posts until a local
// agent is wired to this database and drains the queue. Engage's queue is a
// different Firebase project from ML Studio's, so ML Studio's agent can't see
// it. Account counters are advanced by the agent on a real successful post, not
// here.

const jobs = () => adminDb().collection('jobs');

export interface EnqueueInput {
  projectId: string;
  draftId: string;
  itemId: string; // composite post id "<projectId>_<redditPostId>"
  redditPostId: string; // bare reddit id, for the agent's thread check
  subreddit: string;
  threadUrl: string; // full reddit thread URL to navigate to
  body: string; // the reply to type
  accountId: string;
  adsPowerProfileId: string;
  expectedUsername: string; // agent aborts if the open profile isn't this handle
  createdBy: string;
  createdByName: string;
}

/** True if this draft already has a job that hasn't finished — so we never
 *  double-queue the same reply. Filtered in memory to avoid a composite index. */
export async function hasActiveJobForDraft(draftId: string): Promise<boolean> {
  const snap = await jobs().where('draftId', '==', draftId).get();
  return snap.docs.some((d) => {
    const s = d.data().status;
    return s === 'queued' || s === 'posting';
  });
}

export async function enqueuePostJob(input: EnqueueInput): Promise<string> {
  const ref = jobs().doc();
  await ref.set({
    jobId: ref.id,
    projectId: input.projectId,
    postId: input.itemId,
    draftId: input.draftId,
    redditPostId: input.redditPostId,
    subreddit: input.subreddit,
    threadUrl: input.threadUrl,
    accountId: input.accountId,
    adsPowerProfileId: input.adsPowerProfileId,
    expectedUsername: input.expectedUsername,
    body: input.body,
    status: 'queued',
    attempts: 0,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
