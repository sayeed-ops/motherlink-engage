import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, invalidateCaller, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { isPermission, type Permission } from '@/lib/types';

// Edit or remove one member's access on a project.
//
// The member document IS the authorization record — the same doc security rules
// read on every request. PATCH rewrites its permission set (the granular
// add/remove-an-action editor); DELETE removes it entirely. Either way the
// change is immediate: invalidateCaller drops the cache so there's no TTL lag.

type Ctx = { params: Promise<{ projectId: string; uid: string }> };

interface PatchBody {
  permissions?: string[];
  /** Display-only label for where these came from (e.g. a role name, or 'custom'). */
  roleLabel?: string | null;
}

/**
 * PATCH — set this member's exact permissions. Requires project.members.
 *
 * This is the fine-grained control: tick or untick individual actions for one
 * person, independent of any role. Guards against a manager stripping their own
 * project.members and stranding the project with nobody who can manage it.
 */
export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, uid } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.members');

  const body = await jsonBody<PatchBody>(req);
  if (!Array.isArray(body.permissions)) {
    return badRequest('A permissions array is required.');
  }
  const bad = body.permissions.filter((p) => !isPermission(p));
  if (bad.length) return badRequest(`Unknown permissions: ${bad.join(', ')}.`);
  const permissions = [...new Set(body.permissions.filter(isPermission))] as Permission[];

  const members = adminDb().collection('projects').doc(projectId).collection('members');
  const ref = members.doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('That person is not a member of this project.');

  // Don't let the last manager remove their own ability to manage members and
  // strand the project. (A platform admin could still rescue it, but silently
  // creating that state is worse than refusing.)
  if (uid === caller.uid && !permissions.includes('project.members')) {
    const managers = await members.where('permissions', 'array-contains', 'project.members').get();
    if (managers.size <= 1) {
      return badRequest(
        'You would remove your own ability to manage this project, and no one else can. Grant another manager first.',
      );
    }
  }

  await ref.update({
    permissions,
    grantedFromBundle: body.roleLabel === undefined ? 'custom' : body.roleLabel,
    grantedBy: caller.uid,
    grantedAt: FieldValue.serverTimestamp(),
  });
  invalidateCaller(uid);

  return NextResponse.json({ projectId, uid, permissions });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, uid } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.members');

  const members = adminDb().collection('projects').doc(projectId).collection('members');

  // Don't strand a project with nobody who can manage it. A platform admin
  // could still rescue it, but silently creating that situation is worse than
  // refusing.
  if (uid === caller.uid) {
    const remaining = await members.where('permissions', 'array-contains', 'project.members').get();
    if (remaining.size <= 1) {
      return badRequest(
        'You are the only member who can manage this project. Add another manager before removing yourself.',
      );
    }
  }

  await members.doc(uid).delete();
  // Their access ends immediately, not after the cache TTL.
  invalidateCaller(uid);

  return NextResponse.json({ projectId, uid, removed: true });
});
