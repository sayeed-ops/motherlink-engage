import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { getProject, deleteProjectDeep } from '@/modules/reddit/store';
import { writeActivityLog } from '@/server/activityLog';

// DELETE /api/projects/:projectId
//
// Delete a client project and everything under it. Nothing in ML Studio gates
// this — its browser-side deleteProjectCascade ran under `allow write: if true`,
// so anyone on the internet could erase a client. Here it needs project.settings
// (the danger-zone permission), and the deletion runs server-side with the
// Admin SDK.
//
// recursiveDelete removes the whole projects/{id}/ subtree — members, config,
// sources, items, analyses, drafts — so no orphaned documents are left behind.

type Ctx = { params: Promise<{ projectId: string }> };

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  // Capture the name before the doc is gone, for the audit entry.
  const proj = await getProject(projectId);
  const result = await deleteProjectDeep(projectId);

  await writeActivityLog({
    caller,
    action: 'project.deleted',
    targetType: 'project',
    targetId: projectId,
    targetName: proj?.name,
    metadata: result,
    severity: 'warning',
  });

  return NextResponse.json({ deleted: true, ...result });
});
