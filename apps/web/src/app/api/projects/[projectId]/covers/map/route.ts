import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { buildConversationMap, clearConversationMap, getConversationMap } from '@/server/coversMap';

// GET    /api/projects/:projectId/covers/map — the audience map
// POST   — rebuild it from what triage has recorded
// DELETE — clear it
//
// ════════════════════════════════════════════════════════════════════════════
// THE MAP IS ABOUT THE FORUM, NOT ABOUT THE CLIENT
//
// It describes what Covers bettors need. Swapping the client changes nothing
// about it, which is why it lives in its own document, survives a
// client-knowledge reset, and has its own DELETE rather than being swept up by
// one. See modules/covers/conversationMap.ts.
//
// Rebuilding is ONE model call — the clustering and the counts are free
// arithmetic over analyses already paid for, and the model only names what
// arithmetic found. It is still gated on items.analyze, because one call is
// still somebody's money.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 120;

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');
  return NextResponse.json({ map: await getConversationMap(projectId) });
});

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const result = await buildConversationMap(projectId, async (input) => {
    const res = await callModel(model, input);
    return { content: res.content, model: model.providerModelId };
  });

  return NextResponse.json({
    map: result.map,
    // Reported side by side so "6 needs" from 14 candidates reads as selective
    // rather than as a thin sample.
    candidates: result.candidates,
    modelCalls: result.modelCalls,
  });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  // The same permission the reset takes: clearing the map is destructive and
  // rebuilding it costs a re-triage.
  await requireProjectPermission(caller, projectId, 'knowledge.manage');
  await clearConversationMap(projectId);
  return NextResponse.json({ ok: true });
});
