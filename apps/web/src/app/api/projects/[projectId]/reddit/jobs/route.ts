import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getItem, getDraft } from '@/modules/reddit/store';
import { getAccount } from '@/server/accounts';
import { enqueuePostJob, hasActiveJobForDraft } from '@/server/jobs';
import { accountPostGate } from '@/modules/reddit/accountGate';
import type { RedditAccountStatus } from '@/modules/reddit/types';

// POST /api/projects/:projectId/reddit/jobs
//
// Queue an approved reply to be posted from a chosen account. This is the
// publish action, gated on drafts.publish — the irreversible tier. It writes a
// job to the top-level queue; it does NOT post. Nothing posts until a local
// agent is wired to this database and drains the queue (not built yet).
//
// The rate gate is re-checked HERE, server-side, against the account's live
// counters — the picker's client-side check is only a hint. Counters are
// advanced by the agent on a real successful post, so queuing does not consume
// the daily cap; the agent re-checks again before each post.

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.publish');

  const { draftId, accountId } = await jsonBody<{ draftId?: string; accountId?: string }>(req);
  if (!draftId) return badRequest('A draftId is required.');
  if (!accountId) return badRequest('An accountId is required.');

  const draft = await getDraft(projectId, draftId);
  if (!draft) return badRequest('That draft is not in this project.');
  if (draft.status === 'posted') return badRequest('That reply has already been posted.');
  if (draft.status === 'rejected') return badRequest('That draft was rejected.');

  const item = (await getItem(projectId, draft.itemId as string)) as Record<string, unknown> | null;
  if (!item) return badRequest('The post for that draft is no longer here.');

  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');
  if (!account.adsPowerProfileId) {
    return badRequest('That account has no AdsPower profile ID — it cannot post yet.');
  }

  // Authoritative rate-gate check.
  const gate = accountPostGate(
    {
      status: account.status as RedditAccountStatus,
      dailyCap: Number(account.dailyCap ?? 0),
      minIntervalMinutes: Number(account.minIntervalMinutes ?? 0),
      postCountToday: Number(account.postCountToday ?? 0),
      postCountResetAtMs: ms(account.postCountResetAt),
      lastPostAtMs: ms(account.lastPostAt),
    },
    Date.now(),
  );
  if (!gate.ok) return badRequest(gate.reason ?? 'That account cannot post right now.');

  if (await hasActiveJobForDraft(draftId)) {
    return badRequest('This reply is already queued.');
  }

  const jobId = await enqueuePostJob({
    projectId,
    draftId,
    itemId: item.itemId as string,
    redditPostId: item.externalId as string,
    subreddit: item.subreddit as string,
    threadUrl: (item.permalink as string) || (item.url as string) || '',
    postTitle: (item.title as string) ?? '',
    postBody: (item.body as string) ?? '',
    postAuthor: (item.author as string) ?? '',
    body: draft.body as string,
    accountId,
    adsPowerProfileId: account.adsPowerProfileId as string,
    expectedUsername: (account.username as string) ?? '',
    createdBy: caller.uid,
    createdByName: caller.profile.displayName,
  });

  return NextResponse.json({ jobId, status: 'queued' });
});
