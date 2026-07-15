import { NextResponse } from 'next/server';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';

type Ctx = { params: Promise<{ projectId: string; sourceId: string }> };

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, sourceId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  // Existing analyses keep referencing this id in relevantSourceIds. That is
  // intentional: an analysis records what the model saw at the time, and
  // rewriting history to hide a deleted source would make old analyses
  // unreproducible.
  await adminDb().collection('projects').doc(projectId).collection('sources').doc(sourceId).delete();

  return NextResponse.json({ sourceId, deleted: true });
});
