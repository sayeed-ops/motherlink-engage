import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { adminDb } from '@/server/admin';
import { executeCoversReset, normaliseScope, previewCoversReset } from '@/server/coversReset';

// GET  /api/projects/:projectId/covers/reset — what a reset WOULD delete
// POST — do it
//
// ════════════════════════════════════════════════════════════════════════════
// THE PREVIEW IS NOT A COURTESY, IT IS THE SAFETY MECHANISM
//
// GET returns both columns — what goes and what stays, with the Reddit counts
// named — and POST requires the project's own name typed back. The fear a
// destructive action has to answer is "will this touch Reddit", and the only
// convincing answer is the Reddit numbers on the same screen before the click
// and again in the result after it.
//
// Every delete is a positive `platform == 'covers'` match. See server/coversReset.ts.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

const scopeFromQuery = (url: URL) =>
  normaliseScope({
    clientKnowledge: url.searchParams.get('clientKnowledge') !== '0',
    pipelineOutput: url.searchParams.get('pipelineOutput') !== '0',
    conversationMap: url.searchParams.get('conversationMap') === '1',
  });

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json(await previewCoversReset(projectId, scopeFromQuery(new URL(req.url))));
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  // The permission that owns the asset library. Not project.edit: this destroys
  // knowledge, and the split between those two exists for exactly this.
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<{ confirmName?: string; scope?: unknown }>(req);

  const snap = await adminDb().collection('projects').doc(projectId).get();
  const name = String(snap.data()?.name ?? '');

  // Typed back, not a checkbox. A confirmation that can be clicked through
  // without reading is not a confirmation.
  if (String(body.confirmName ?? '').trim() !== name) {
    return badRequest(`Type the project name (${name}) to confirm.`);
  }

  const scope = normaliseScope(body.scope);
  if (!scope.clientKnowledge && !scope.pipelineOutput && !scope.conversationMap) {
    return badRequest('Nothing selected to reset.');
  }

  return NextResponse.json(await executeCoversReset(projectId, scope));
});
