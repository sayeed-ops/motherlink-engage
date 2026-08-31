import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { decideDraft, listCoversDrafts, runGeneration, saveDrafts } from '@/server/coversDrafts';
import { normaliseSection } from '@/modules/covers/sections';

// POST  /api/projects/:projectId/covers/drafts — write variants for a triage run
// GET   /api/projects/:projectId/covers/drafts — read the review queue back
// PATCH /api/projects/:projectId/covers/drafts — record a person's decision
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ NOTHING ON THIS ROUTE CAN POST, AND `approved` IS NOT A QUEUE
//
// PATCH records that a person read a draft and agreed with it. It enqueues
// nothing, because there is nothing to enqueue: no Covers job kind exists, the
// agent has no Covers vocabulary, and modules/covers/draft.ts has no state after
// `approved`. A person copies the text and posts it themselves, which is what
// phase 4 is for — COVERS-PLAN.md § The staged build, L1 Assisted.
//
// It is gated on `drafts.approve` — the REVERSIBLE tier — and never on
// `drafts.publish`, which exists for the irreversible act of queueing a job that
// a real account posts. When phase 6 adds a Covers job, the enqueue takes
// `drafts.publish` and this route keeps the weaker permission it actually needs.
// ════════════════════════════════════════════════════════════════════════════
//
// GENERATION IS GATED ON items.analyze — the model-spend tier, as triage is.
// Between two and four model calls per opportunity: one or two to write, one to
// score, and one to choose ONLY when two or three variants survived the free
// floors.

export const maxDuration = 300;

/** Opportunities per run. Low on purpose — each one costs several calls, and a
 *  phase-4 run exists to be read by a person, not to fill a queue. */
const MAX_OPPORTUNITIES = 10;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  runId?: string;
  section?: string;
  maxOpportunities?: number;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const section = body.section ? normaliseSection(String(body.section)) : undefined;

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const cap = Math.max(1, Math.min(MAX_OPPORTUNITIES, Number(body.maxOpportunities) || MAX_OPPORTUNITIES));

  const run = await runGeneration(
    projectId,
    { runId: body.runId, section, maxOpportunities: cap, nowMs: Date.now() },
    async (input) => {
      const result = await callModel(model, input);
      return { content: result.content, model: model.providerModelId };
    },
  );

  const saved = await saveDrafts(projectId, run, caller.uid);

  return NextResponse.json({
    runId: run.runId,
    opportunities: run.opportunities,
    written: saved.written,
    // The bill, split three ways. A run that spent most of its money on critic
    // calls is a run where the floors are too loose, and that is only visible
    // if the numbers are separate.
    calls: run.calls,
    skipped: run.skipped,
    // NONE is an outcome, counted and returned like any other.
    selected: run.drafts.reduce<Record<string, number>>((acc, d) => {
      acc[d.selected] = (acc[d.selected] ?? 0) + 1;
      return acc;
    }, {}),
  });
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);

  return NextResponse.json({
    drafts: await listCoversDrafts(projectId, {
      runId: url.searchParams.get('runId') ?? undefined,
      section: url.searchParams.get('section') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    }),
  });
});

interface PatchBody {
  draftId?: string;
  status?: string;
  reason?: string;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.approve');

  const body = await jsonBody<PatchBody>(req);
  const draftId = String(body.draftId ?? '').trim();
  if (!draftId) return badRequest('A draftId is required.');

  const status = String(body.status ?? '');
  // Only the two a person can choose. `none` is the pipeline's own answer and
  // `pending` is where a draft starts; neither is a decision anybody makes, and
  // accepting them here would let a request overwrite a recorded outcome.
  if (status !== 'approved' && status !== 'rejected') {
    return badRequest('status must be approved or rejected.');
  }

  await decideDraft(
    projectId,
    draftId,
    { status, reason: String(body.reason ?? '') },
    { uid: caller.uid, name: caller.profile.displayName ?? '' },
  );

  return NextResponse.json({ ok: true, draftId, status });
});
