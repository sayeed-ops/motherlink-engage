import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { cancelJob } from '@/server/jobs';

// POST /api/projects/:projectId/reddit/jobs/cancel  { jobId }
//
// Cancel a reply that hasn't posted yet (queued, or stuck in 'posting' after an
// agent stopped mid-post). Frees the draft so it can be published again. Gated
// on drafts.publish, the same tier as enqueuing. Cancelling does not un-post an
// already-posted reply — only queued/posting jobs are cancellable.

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.publish');

  const { jobId } = await jsonBody<{ jobId?: string }>(req);
  if (!jobId) return badRequest('A jobId is required.');

  const outcome = await cancelJob(jobId, projectId);
  switch (outcome) {
    case 'not-found':
      return badRequest('That job no longer exists.');
    case 'wrong-project':
      return badRequest('That job belongs to another project.');
    case 'already-terminal':
      return badRequest('That reply already finished — nothing to cancel.');
    default:
      return NextResponse.json({ cancelled: true });
  }
});
