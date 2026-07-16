import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/server/admin';
import { requirePlatformAdmin, invalidateCaller, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { GLOBAL_ROLES, type GlobalRole, type UserStatus } from '@/lib/types';

// Change a user's role, or disable them.
//
// Disabling is the piece ML Studio never really finished. Its RouteGuard pushes
// a suspended user to /login WITHOUT signing them out, so firebaseUser stays
// set, which re-triggers "logged in, don't show login" and bounces them back —
// an infinite redirect loop. And because auth was client-side only, a suspended
// user's token still worked against every API route anyway.
//
// Here disabling revokes refresh tokens AND disables the auth user, so existing
// sessions die on their next verifyIdToken (which passes checkRevoked: true).
// Access ends in seconds, not whenever the tab happens to reload.

type Ctx = { params: Promise<{ uid: string }> };

interface PatchBody {
  role?: string;
  status?: string;
  displayName?: string;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);

  const { uid } = await ctx.params;
  const body = await jsonBody<PatchBody>(req);

  const db = adminDb();
  const auth = adminAuth();
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('No such user.');

  const target = snap.data()!;
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  // --- role ---
  if (body.role !== undefined) {
    const role = body.role as GlobalRole;
    if (!GLOBAL_ROLES.includes(role)) {
      return badRequest(`Role must be one of: ${GLOBAL_ROLES.join(', ')}.`);
    }
    // Only an owner may create or demote owners. Without this an admin could
    // promote themselves and then demote everyone above them.
    if ((role === 'owner' || target.role === 'owner') && caller.role !== 'owner') {
      return badRequest('Only an owner can change owner roles.');
    }
    if (uid === caller.uid && role !== caller.role) {
      return badRequest('You cannot change your own role. Ask another owner.');
    }

    updates.role = role;
    updates.globalPermissions = role === 'owner' || role === 'admin' ? ['accounts.manage'] : [];
    await auth.setCustomUserClaims(uid, { role });
    // A claim only reaches the client on token refresh; force it so an
    // in-flight session cannot keep acting on the old role.
    await auth.revokeRefreshTokens(uid);
  }

  // --- status ---
  if (body.status !== undefined) {
    const status = body.status as UserStatus;
    if (!['active', 'invited', 'disabled'].includes(status)) {
      return badRequest('Status must be active, invited, or disabled.');
    }
    if (uid === caller.uid && status === 'disabled') {
      return badRequest('You cannot disable your own account.');
    }
    if (target.role === 'owner' && caller.role !== 'owner') {
      return badRequest('Only an owner can disable an owner.');
    }

    updates.status = status;

    if (status === 'disabled') {
      // Both matter: disabled blocks new sign-ins; revoke kills live sessions.
      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
    } else {
      await auth.updateUser(uid, { disabled: false });
    }
  }

  if (body.displayName !== undefined) {
    const name = body.displayName.trim();
    if (!name) return badRequest('Display name cannot be empty.');
    updates.displayName = name;
  }

  await ref.update(updates);
  // A role or status change must take effect now, not after the cache TTL.
  invalidateCaller(uid);

  return NextResponse.json({ uid, ...updates, updatedAt: undefined });
});

/**
 * DELETE — disables rather than deletes.
 *
 * Their uid is stamped on every project, item, analysis and draft they touched.
 * Hard-deleting turns all of that into dangling references and destroys the
 * audit trail. Disabling ends access completely, which is the actual
 * requirement.
 */
export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { uid } = await ctx.params;

  if (uid === caller.uid) return badRequest('You cannot disable your own account.');

  const db = adminDb();
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return badRequest('No such user.');
  if (snap.data()!.role === 'owner' && caller.role !== 'owner') {
    return badRequest('Only an owner can disable an owner.');
  }

  await adminAuth().updateUser(uid, { disabled: true });
  await adminAuth().revokeRefreshTokens(uid);
  await db.collection('users').doc(uid).update({
    status: 'disabled',
    updatedAt: FieldValue.serverTimestamp(),
  });
  invalidateCaller(uid);

  return NextResponse.json({ uid, status: 'disabled' });
});
