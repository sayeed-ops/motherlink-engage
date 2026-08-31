import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { getCoversConfig, saveCoversConfig } from '@/server/covers';
import { DEFAULT_SECTIONS, SECTION_ROLE_LABEL } from '@/modules/covers/sections';
import { MAX_PAGES_PER_SECTION, MAX_THREADS_PER_SCAN } from '@/modules/covers/config';

// GET /api/projects/:projectId/covers  — the module's settings
// PUT /api/projects/:projectId/covers  — replace them
//
// Reading the settings is `project.view`; changing them is `project.settings`,
// because a section's role decides whether a reply may ever name the client
// there. That is a policy question, not a preference.

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  return NextResponse.json({
    config: await getCoversConfig(projectId),
    // The shipped list travels with the response so the screen can offer a
    // section nobody has added yet without hardcoding a second copy of it.
    catalogue: DEFAULT_SECTIONS,
    roleLabels: SECTION_ROLE_LABEL,
    limits: { pagesPerSection: MAX_PAGES_PER_SECTION, maxThreadsPerScan: MAX_THREADS_PER_SCAN },
  });
});

export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<{ config?: unknown }>(req);
  // Normalisation happens server-side, so what comes back is what was stored —
  // a screen showing the values it sent rather than the values that were kept
  // is how a silently dropped section goes unnoticed.
  return NextResponse.json({ config: await saveCoversConfig(projectId, body.config, caller.uid) });
});
