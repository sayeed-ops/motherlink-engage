import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import {
  decideCandidate,
  getResearchBrief,
  importResearch,
  listCandidates,
} from '@/server/coversResearch';

// GET   /api/projects/:projectId/covers/research — the brief and the candidates
// POST  — import structured research findings
// PATCH — approve / edit / reject one candidate
//
// ════════════════════════════════════════════════════════════════════════════
// THE MIDDLE STEP IS DELIBERATELY OUTSIDE THIS STACK
//
// There is no web search here. Rather than build one today, the brief is
// generated for a person to hand to a search-enabled assistant, and the findings
// come back as JSON through POST. That keeps discovery (what might this client
// have?) separate from evidence (what public source proves it?), which is what
// makes onboarding work for a client whose own website refuses our server —
// the case that broke the crawler-first design.
//
// ⚠️ NOTHING HERE SPENDS MODEL CREDIT, so none of it is gated on items.analyze.
// Importing is a knowledge change, so it takes knowledge.manage.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 60;

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const [brief, candidates] = await Promise.all([
    getResearchBrief(projectId),
    listCandidates(projectId),
  ]);

  return NextResponse.json({ ...brief, ...candidates });
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<{ research?: unknown }>(req);
  if (body.research === undefined) return badRequest('Paste the research JSON.');

  const summary = await importResearch(projectId, body.research, {
    uid: caller.uid,
    name: caller.profile.displayName ?? '',
  });

  // Rejected rows are returned, not swallowed. A researcher whose output half
  // parses should find that out rather than wonder where six capabilities went.
  return NextResponse.json(summary);
});

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<{ assetId?: string; status?: string; edits?: unknown }>(req);
  const assetId = String(body.assetId ?? '').trim();
  if (!assetId) return badRequest('An assetId is required.');

  // `active` is approve, `retired` is reject. There is no delete: a rejected
  // candidate is kept so the research that produced it stays explicable.
  if (body.status !== 'active' && body.status !== 'retired') {
    return badRequest('status must be active or retired.');
  }

  await decideCandidate(
    projectId,
    assetId,
    { status: body.status, edits: (body.edits ?? {}) as never },
    { uid: caller.uid, name: caller.profile.displayName ?? '' },
  );

  return NextResponse.json({ ok: true, assetId, status: body.status });
});
