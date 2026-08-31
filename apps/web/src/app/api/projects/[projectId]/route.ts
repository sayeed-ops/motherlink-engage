import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getProject, deleteProjectDeep } from '@/modules/reddit/store';
import { writeActivityLog } from '@/server/activityLog';
import { ENABLED_PLATFORMS, type Platform } from '@/lib/types';

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

// PATCH /api/projects/:projectId
//
// Turn a module on or off for this client. The only settable field is
// `enabledModules`, and it is validated against ENABLED_PLATFORMS rather than
// against the Platform type: the type lists every platform the data model
// anticipates, the constant lists the ones that are actually built, and a
// project must never be pointed at a module that is only a plan.
//
// Turning a module OFF removes its screen from the project page. It deletes
// nothing — a harvest already read stays where it is, and turning the module
// back on shows it again. Destroying data is the danger zone's job, behind a
// type-to-confirm, and a toggle must not quietly do the same thing.
interface PatchBody {
  enabledModules?: unknown;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.settings');

  const body = await jsonBody<PatchBody>(req);
  if (!Array.isArray(body.enabledModules)) {
    return badRequest('enabledModules must be an array.');
  }

  const requested = [...new Set(body.enabledModules.filter((m): m is string => typeof m === 'string'))];
  const invalid = requested.filter((m) => !ENABLED_PLATFORMS.includes(m as Platform));
  if (invalid.length > 0) {
    return badRequest(
      `Not available yet: ${invalid.join(', ')}. Currently supported: ${ENABLED_PLATFORMS.join(', ')}.`,
    );
  }

  await adminDb()
    .collection('projects')
    .doc(projectId)
    .update({ enabledModules: requested, updatedAt: FieldValue.serverTimestamp() });

  return NextResponse.json({ enabledModules: requested });
});
