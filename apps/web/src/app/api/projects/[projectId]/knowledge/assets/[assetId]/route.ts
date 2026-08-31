import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { deleteAsset, getAsset, setAssetStatus, UnverifiedAssetError } from '@/server/knowledge';

// PATCH  /api/projects/:projectId/knowledge/assets/:assetId  — confirm / retire
// DELETE /api/projects/:projectId/knowledge/assets/:assetId  — remove it and its claims

type Ctx = { params: Promise<{ projectId: string; assetId: string }> };

interface Body {
  status?: string;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, assetId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const status = body.status;
  if (status !== 'active' && status !== 'draft' && status !== 'retired') {
    return badRequest('Status must be active, draft or retired.');
  }

  const asset = await getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'No such asset.' }, { status: 404 });

  // Activating is also how a stale asset comes back: it means "I have read the
  // changed page and this still describes it". setAssetStatus clears the flag,
  // and nothing else may — see the comment there.
  try {
    await setAssetStatus(
      projectId,
      assetId,
      status,
      { uid: caller.uid, name: caller.profile.displayName },
      Date.now(),
    );
  } catch (err) {
    // Confirming a page nobody has read is refused, not reported as a server
    // fault: the operator's next move is to read it or paste it.
    if (err instanceof UnverifiedAssetError) return badRequest(err.message);
    throw err;
  }

  return NextResponse.json({ assetId, status });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, assetId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const asset = await getAsset(projectId, assetId);
  if (!asset) return NextResponse.json({ error: 'No such asset.' }, { status: 404 });

  const claimsDeleted = await deleteAsset(projectId, assetId);
  return NextResponse.json({ assetId, claimsDeleted });
});
