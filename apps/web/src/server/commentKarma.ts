import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { callModel, LlmError } from '@/server/llm';
import { resolveModelForRun, type RunActor } from '@/server/llm/resolve';
import { getWarmupModel } from './agentControl';
import { communitiesForRole, keywordsByCommunity, normalizeCommunityList } from '@/modules/reddit/subreddits';
import { CrawlzoError, createCrawlzoReader } from '@/modules/reddit/reader/crawlzo';
import {
  normalizeDraft,
  nextStatus,
  type CommentDraftRecord,
  type ReviewAction,
} from '@/modules/reddit/commentKarma/drafts';
import { historyFromPosted, scanForComment, type ScanOutcome } from '@/modules/reddit/commentKarma/pipeline';
import {
  normalizeCommentSettings,
  scanReadiness,
  type CommentKarmaSettings,
} from '@/modules/reddit/commentKarma/settings';

// Comment karma — the thin server half.
//
// Everything that decides anything lives in modules/reddit/commentKarma and is
// pure. This file supplies the three things a pure function cannot have: a
// Crawlzo reader, a resolved model credential, and somewhere to write the
// result. Keep it that way — a judgement that migrates in here stops being
// testable without a network and an API key.
//
// NOTHING HERE POSTS. A scan writes a record; approving one sets a status. The
// enqueue, the counters and the agent's kind-specific allowlist are Phase 5, and
// until then the only way a comment reaches Reddit is a person typing it.
//
// THE MODEL IS RESOLVED THROUGH @/server/llm, never through the deepseek.ts
// helper, which calls the env key directly and bypasses both the per-project
// grant and the per-person `canUseSharedKeys` entitlement. See API-KEYS.md §4.

const accounts = () => adminDb().collection('accounts');
const drafts = (accountId: string) => accounts().doc(accountId).collection('commentDrafts');

/** Storage argument as warmupPolicy: small behavioural config, a field on the
 *  account doc, rides the existing client subscription, no rules change. */
export async function saveCommentSettings(
  accountId: string,
  settings: Partial<CommentKarmaSettings>,
  savedBy: string,
): Promise<CommentKarmaSettings> {
  const clean = normalizeCommentSettings(settings);
  await accounts().doc(accountId).update({
    commentKarma: clean,
    commentKarmaUpdatedAt: FieldValue.serverTimestamp(),
    commentKarmaUpdatedBy: savedBy,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return clean;
}

export async function getCommentSettings(accountId: string): Promise<CommentKarmaSettings> {
  const snap = await accounts().doc(accountId).get();
  return normalizeCommentSettings(snap.exists ? snap.data()?.commentKarma : undefined);
}

/** The account's recent comment history, for the account-level bot-tell gate.
 *
 *  Built from what WE posted, which is a lower bound on what the account did —
 *  it cannot see comments made outside this system. That is honest and it is
 *  also the safe direction: an underestimate makes the gate stricter, never
 *  laxer. */
async function recentHistory(accountId: string, limit = 20) {
  // Ordered on ONE field and filtered in memory, deliberately. `where('status')`
  // plus `orderBy('createdAtMs')` is a composite index, and a composite index is
  // a second thing that has to be deployed out of band — exactly the drift that
  // left the security rules three weeks behind the code. The volume here is a
  // few dozen documents per account, so the query that needs no index is also
  // the cheap one.
  const snap = await drafts(accountId).orderBy('createdAtMs', 'desc').limit(limit * 5).get();

  return historyFromPosted(
    snap.docs
      .map((d) => normalizeDraft(d.id, d.data()))
      .filter((d): d is CommentDraftRecord => !!d && !!d.thread && d.status === 'posted')
      .slice(0, limit)
      .map((d) => ({
        text: d.text,
        subreddit: d.thread?.subreddit ?? '',
        // The posted time, falling back to when the scan ran. Only ordering and
        // spacing matter to the gate, and both survive that substitution.
        postedAtMs: d.reviewedAtMs ?? d.createdAtMs,
      })),
  );
}

export interface ScanReport {
  draftId: string;
  outcome: ScanOutcome;
  autoApproved: boolean;
}

/**
 * Run one scan for one account and file the result.
 *
 * A skip is a normal, recorded outcome. A fault (no Crawlzo key, a model
 * refusing, a network failure) is filed as `skipStage: 'error'` and rethrown as
 * a message the route turns into a 4xx/5xx — the record exists so the panel can
 * show that something ran and broke, rather than silently showing nothing.
 */
export async function runCommentScan(
  accountId: string,
  actor: RunActor,
  actorName: string,
): Promise<ScanReport> {
  const snap = await accounts().doc(accountId).get();
  if (!snap.exists) throw new Error('No such account.');
  const account = snap.data() ?? {};

  const settings = normalizeCommentSettings(account.commentKarma);
  const communities = normalizeCommunityList(account.warmupCommunities);
  const commentCommunities = communitiesForRole(communities, 'comment');

  const ready = scanReadiness(settings, commentCommunities);
  if (!ready.ok) throw new Error(ready.reason);

  // The Communities tab already stores per-community keywords, which is the only
  // way in — Crawlzo has no listing endpoint. See docs/CRAWLZO-API.md.
  const byCommunity = keywordsByCommunity(communities);
  const pairs = commentCommunities.map((subreddit) => ({
    subreddit,
    keywords: byCommunity[subreddit] ?? [],
  }));

  const history = await recentHistory(accountId);
  const reader = createCrawlzoReader();

  // Resolved once and reused across the three calls of a scan: the alternative
  // is three resolutions that could disagree mid-scan if a grant changes.
  const model = await resolveModelForRun(actor, null, await getWarmupModel(), { requireJson: true });

  const nowMs = Date.now();
  let outcome: ScanOutcome;
  try {
    outcome = await scanForComment(
      {
        reader,
        nowMs,
        ask: async ({ system, user, temperature, maxTokens }) => {
          const { content } = await callModel(model, { system, user, temperature, maxTokens, json: true });
          return JSON.parse(content);
        },
      },
      { settings, pairs, history },
    );
  } catch (err) {
    const message =
      err instanceof CrawlzoError || err instanceof LlmError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown failure.';
    const draftId = await fileScan(accountId, settings, actorName, {
      produced: false,
      skipStage: 'error',
      skipReason: message,
      thread: null,
      text: null,
      words: 0,
      gap: null,
      room: null,
      criticReason: '',
      rejected: [],
      trace: [`error: ${message}`],
    });
    throw Object.assign(new Error(message), { draftId });
  }

  const draftId = await fileScan(accountId, settings, actorName, outcome);
  return { draftId, outcome, autoApproved: outcome.produced && settings.autoPost };
}

/** Write one scan record. Every scan writes one, including the skips — see the
 *  header of modules/reddit/commentKarma/drafts.ts for why. */
async function fileScan(
  accountId: string,
  settings: CommentKarmaSettings,
  actorName: string,
  outcome: ScanOutcome,
): Promise<string> {
  const ref = drafts(accountId).doc();
  // Auto only decides WHO says yes. The pipeline and every gate above it are
  // identical on both paths, which is the whole reason the switch ships now
  // rather than being retrofitted over a review-only design.
  const autoApproved = outcome.produced && settings.autoPost;

  await ref.set({
    draftId: ref.id,
    accountId,
    status: outcome.produced ? (autoApproved ? 'approved' : 'pending') : 'skipped',
    skipStage: outcome.skipStage,
    skipReason: outcome.skipReason,
    thread: outcome.thread,
    text: outcome.text,
    words: outcome.words,
    gap: outcome.gap,
    room: outcome.room,
    criticReason: outcome.criticReason,
    rejected: outcome.rejected,
    trace: outcome.trace,
    autoApproved,
    // Epoch ms rather than a serverTimestamp: the record is ordered against
    // thread ages and snapshot times, which are epoch ms from Reddit, and a
    // mixed-unit sort is a bug waiting for a slow day.
    createdAtMs: Date.now(),
    createdAt: FieldValue.serverTimestamp(),
    reviewedBy: autoApproved ? 'auto' : null,
    reviewedByName: autoApproved ? `Auto (${actorName})` : '',
    reviewedAtMs: autoApproved ? Date.now() : null,
    reviewNote: '',
  });
  return ref.id;
}

/**
 * Approve or reject one draft.
 *
 * The transition runs inside a transaction against the CURRENT status, because
 * approval is a race: two operators with the panel open, or an operator and the
 * auto switch. `nextStatus` refuses anything that is not pending, so the loser
 * gets a refusal instead of overwriting the winner.
 */
export async function reviewDraft(
  accountId: string,
  draftId: string,
  action: ReviewAction,
  note: string,
  reviewer: { uid: string; name: string },
): Promise<CommentDraftRecord> {
  const ref = drafts(accountId).doc(draftId);

  const updated = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('No such draft.');
    const record = normalizeDraft(snap.id, snap.data());
    if (!record) throw new Error('That draft is unreadable.');

    const status = nextStatus(record.status, action);
    if (!status) throw new Error(`This draft is already ${record.status}; it cannot be ${action}d.`);

    const patch = {
      status,
      reviewedBy: reviewer.uid,
      reviewedByName: reviewer.name,
      reviewedAtMs: Date.now(),
      // The note is the training data — "too eager", "wrong register" — and is
      // worth more than the rejection itself, so it is kept on approvals too.
      reviewNote: note.trim().slice(0, 1000),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.update(ref, patch);
    return { ...record, ...patch };
  });

  return updated;
}
