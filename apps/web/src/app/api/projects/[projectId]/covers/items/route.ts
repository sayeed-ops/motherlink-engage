import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getCoversItem, listCoversItems, listCoversPosts } from '@/server/covers';

// GET /api/projects/:projectId/covers/items            — harvested threads
// GET /api/projects/:projectId/covers/items?itemId=…    — one thread, with posts
//
// Read-only, `project.view`. The posts come only when one thread is asked for:
// a section harvest is tens of threads and hundreds of posts, and shipping every
// body to render a list of titles is the same mistake the asset snapshots avoid
// by living in a subcollection.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);
  const itemId = url.searchParams.get('itemId');

  if (itemId) {
    const item = await getCoversItem(projectId, itemId);
    if (!item) return NextResponse.json({ error: 'No such harvested thread.' }, { status: 404 });
    return NextResponse.json({ item, posts: await listCoversPosts(projectId, itemId) });
  }

  const section = url.searchParams.get('section');
  const limit = Number(url.searchParams.get('limit')) || undefined;

  return NextResponse.json({
    items: await listCoversItems(projectId, { section: section ?? undefined, limit }),
  });
});
