import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { listTriage, runTriage, saveTriageRun } from '@/server/coversTriage';
import { normaliseSection } from '@/modules/covers/sections';
import { getCoversConfig } from '@/server/covers';

// POST /api/projects/:projectId/covers/triage  — run the funnel over a section
// GET  /api/projects/:projectId/covers/triage  — read the queue back
//
// ════════════════════════════════════════════════════════════════════════════
// GATED ON items.analyze — THE MODEL-SPEND TIER
//
// The harvest is gated on items.fetch because it spends somebody else's server.
// This spends model credit, which is a different budget and a different
// permission, exactly as the Reddit path splits fetch from analyse.
//
// Nothing here writes a reply. Triage produces a ranked queue and a gap board;
// generation is phase 4 and there is no code in the tree that could post any of
// it before phase 6.
// ════════════════════════════════════════════════════════════════════════════

// One model call per surviving post, capped by maxIntentCalls.
export const maxDuration = 300;

const MAX_INTENT_CALLS = 120;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  section?: string;
  /** Ceiling on PAID calls. The free tier runs over everything regardless. */
  maxIntentCalls?: number;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<Body>(req);
  const section = normaliseSection(String(body.section ?? ''));
  if (!section) return badRequest('A section is required.');

  const config = await getCoversConfig(projectId);
  if (!config.sections.some((s) => s.slug === section)) {
    return badRequest(`${section} is not one of this project's sections.`);
  }

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const budget = Math.max(1, Math.min(MAX_INTENT_CALLS, Number(body.maxIntentCalls) || MAX_INTENT_CALLS));

  const run = await runTriage(
    projectId,
    { section, maxIntentCalls: budget, nowMs: Date.now() },
    async (input) => {
      const result = await callModel(model, input);
      return { content: result.content, model: model.providerModelId };
    },
  );

  const saved = await saveTriageRun(projectId, run, caller.uid);

  return NextResponse.json({
    runId: saved.runId,
    section: run.section,
    posts: run.posts,
    counts: run.counts,
    intentCalls: run.intentCalls,
    // Said out loud: a queue cut short by budget looks exactly like a quiet
    // forum unless the number is on the screen.
    budgetSkipped: run.budgetSkipped,
    // Three trays, not one list. `offDomain` is deliberately returned rather
    // than dropped — the filter will be wrong sometimes and the only way that
    // gets corrected is if its rejections are on the screen.
    board: run.board,
    written: saved.written,
  });
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);

  return NextResponse.json({
    triage: await listTriage(projectId, {
      runId: url.searchParams.get('runId') ?? undefined,
      section: url.searchParams.get('section') ?? undefined,
      all: url.searchParams.get('all') === '1',
      limit: Number(url.searchParams.get('limit')) || undefined,
    }),
  });
});
