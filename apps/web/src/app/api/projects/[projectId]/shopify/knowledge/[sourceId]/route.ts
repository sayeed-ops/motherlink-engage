import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { deleteShopifySource, SourceNotFoundError, updateShopifySource } from '@/server/shopifyKnowledge';
import { normaliseSource } from '@/modules/shopify/knowledge';

// PUT    /api/projects/:projectId/shopify/knowledge/:sourceId — edit one source
// DELETE /api/projects/:projectId/shopify/knowledge/:sourceId — remove it

type Ctx = { params: Promise<{ projectId: string; sourceId: string }> };

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, sourceId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const res = normaliseSource((await jsonBody<{ source?: unknown }>(req)).source);
  if (!res.ok) return badRequest(`That source was not saved: ${res.reason}.`);

  try {
    return NextResponse.json({ source: await updateShopifySource(projectId, sourceId, res.source) });
  } catch (err) {
    if (err instanceof SourceNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, sourceId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');
  await deleteShopifySource(projectId, sourceId);
  return NextResponse.json({ sourceId, deleted: true });
});
