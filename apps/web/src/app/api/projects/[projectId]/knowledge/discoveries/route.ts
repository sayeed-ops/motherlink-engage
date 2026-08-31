import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { listDiscoveries } from '@/server/discovery';

// GET /api/projects/:projectId/knowledge/discoveries — the review queue.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const discoveries = await listDiscoveries(projectId);
  return NextResponse.json({
    discoveries,
    counts: {
      new: discoveries.filter((d) => d.status === 'new').length,
      review: discoveries.filter((d) => d.status === 'review').length,
      added: discoveries.filter((d) => d.status === 'added').length,
      ignored: discoveries.filter((d) => d.status === 'ignored').length,
    },
  });
});
