import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { getProject, cleanProjectHistory } from '@/modules/reddit/store';
import { writeActivityLog } from '@/server/activityLog';

// POST /api/projects/:projectId/reddit/clean
//
// Clean fetch & analysis history: clears items and analyses and any draft not
// marked posted. Keeps the project, its config, knowledge sources, members, and
// posted drafts (the ANSWERED ledger).
//
// Gated on project.settings — the danger-zone permission (only the `manager`
// bundle and platform admins hold it). This is destructive and irreversible, so
// it is walled off from the analysts who run the day-to-day queue.

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const proj = await getProject(projectId);
  const result = await cleanProjectHistory(projectId);

  await writeActivityLog({
    caller,
    action: 'project.history_cleaned',
    targetType: 'project',
    targetId: projectId,
    targetName: proj?.name,
    metadata: result,
    severity: 'warning',
  });

  return NextResponse.json(result);
});
