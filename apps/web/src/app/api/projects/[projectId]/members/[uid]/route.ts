import { NextResponse } from 'next/server';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';

// Remove someone from a project.
//
// Deleting the member document is the whole operation: it IS the authorization
// record, so removing it removes access, immediately and completely, with no
// cache to wait on. Security rules read this exact document on every request.

type Ctx = { params: Promise<{ projectId: string; uid: string }> };

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

  return NextResponse.json({ projectId, uid, removed: true });
});
