import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { cancelJob } from '@/server/jobs';
import { postingContext, PostingRefused, queueShopifyPost } from '@/server/shopifyPosting';

// GET    /api/projects/:projectId/shopify/post — accounts, agent readiness, dry-run state
// POST   /api/projects/:projectId/shopify/post — queue an approved draft { draftId, accountId }
// DELETE /api/projects/:projectId/shopify/post — cancel a job that has not finished { jobId }
//
// `drafts.publish` to queue or cancel: the irreversible tier, as on Reddit. The
// agent does the posting; in dry run it types and stops.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json(await postingContext());
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.publish');
  const body = await jsonBody<{ draftId?: unknown; accountId?: unknown }>(req);
  const draftId = String(body.draftId ?? '').trim();
  const accountId = String(body.accountId ?? '').trim();
  if (!draftId) return badRequest('A draftId is required.');
  if (!accountId) return badRequest('Choose the account to post from.');
  try {
    const res = await queueShopifyPost({ projectId, draftId, accountId, uid: caller.uid, name: caller.profile.displayName });
    return NextResponse.json({ ...res, status: 'queued' }, { status: 201 });
  } catch (err) {
    if (err instanceof PostingRefused) return badRequest(err.message);
    throw err;
  }
});

export const DELETE = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.publish');
  const { jobId } = await jsonBody<{ jobId?: unknown }>(req);
  const id = String(jobId ?? '').trim();
  if (!id) return badRequest('A jobId is required.');
  const outcome = await cancelJob(id, projectId);
  if (outcome === 'not-found' || outcome === 'wrong-project') return badRequest('No such job on this project.');
  if (outcome === 'already-terminal') return badRequest('That job has already finished.');
  return NextResponse.json({ jobId: id, status: 'cancelled' });
});
