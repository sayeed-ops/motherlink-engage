import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/server/admin';
import { requirePlatformAdmin, invalidateCaller, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { GLOBAL_ROLES, type GlobalRole, type UserStatus } from '@/lib/types';
import { writeActivityLog } from '@/server/activityLog';

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
  canUseSharedKeys?: boolean;
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
    if (!['active', 'invited', 'disabled', 'archived'].includes(status)) {
      return badRequest('Status must be active, invited, disabled, or archived.');
    }
    const endsAccess = status === 'disabled' || status === 'archived';
    if (uid === caller.uid && endsAccess) {
      return badRequest('You cannot disable or archive your own account.');
    }
    if (target.role === 'owner' && caller.role !== 'owner') {
      return badRequest('Only an owner can disable or archive an owner.');
    }

    updates.status = status;

    if (endsAccess) {
      // Both 'disabled' and 'archived' end access — disabled blocks new sign-ins,
      // revoke kills live sessions. 'archived' additionally hides the row from
      // the default roster (a UI concern, handled client-side).
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

  // --- organisation LLM spend ---
  //
  // Unlike role, this is NOT blocked on uid === caller.uid. Turning your own
  // org spend off costs you nothing you cannot restore in one click, and there
  // is no privilege-escalation shape to it: the setting can only ever narrow
  // what a key resolves to. An owner is still protected from admins by the
  // clause below.
  if (body.canUseSharedKeys !== undefined) {
    if (typeof body.canUseSharedKeys !== 'boolean') {
      return badRequest('canUseSharedKeys must be true or false.');
    }
    if (target.role === 'owner' && caller.role !== 'owner') {
      return badRequest("Only an owner can change an owner's API key access.");
    }
    // Written explicitly rather than deleted when true, so the roster shows a
    // decision instead of an absence. Reads still treat absent as allowed.
    updates.canUseSharedKeys = body.canUseSharedKeys;
  }

  await ref.update(updates);
  // A role, status or spend change must take effect now, not after the cache
  // TTL — mayUseSharedKeys() reads the cached profile this drops.
  invalidateCaller(uid);

  if (body.canUseSharedKeys !== undefined) {
    // Shared keys spend org money, so who may spend them is an org-spend event,
    // logged for the same reason creating a shared key is.
    await writeActivityLog({
      caller,
      action: body.canUseSharedKeys ? 'user.shared_keys_granted' : 'user.shared_keys_revoked',
      targetType: 'user',
      targetId: uid,
      targetName: target.email,
      metadata: { canUseSharedKeys: body.canUseSharedKeys },
    });
  }

  return NextResponse.json({ uid, ...updates, updatedAt: undefined });
});

/**
 * DELETE — a real, irreversible hard delete.
 *
 * Removes the Firebase Auth user, the users/{uid} profile, and every per-project
 * membership document that granted them access. What it deliberately does NOT
 * touch: the uid strings stamped as `createdBy`/authorship on projects, items,
 * analyses and drafts — those are historical references to a person, not live
 * access, and rewriting them would destroy the audit trail for no gain.
 *
 * For a reversible retirement that keeps the account on file, use PATCH with
 * status 'archived' (hidden from the roster) or 'disabled' (access revoked).
 */
export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { uid } = await ctx.params;

  if (uid === caller.uid) return badRequest('You cannot delete your own account.');

  const db = adminDb();
  const auth = adminAuth();
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('No such user.');
  const target = snap.data()!;
  if (target.role === 'owner' && caller.role !== 'owner') {
    return badRequest('Only an owner can delete an owner.');
  }

  // Drop their project memberships and profile atomically. Batches cap at 500
  // writes; a single user on ~500 projects is not a real case, but if it ever
  // is this would need chunking.
  const memberships = await db.collectionGroup('members').where('uid', '==', uid).get();
  const batch = db.batch();
  memberships.forEach((m) => batch.delete(m.ref));
  batch.delete(ref);
  await batch.commit();

  // Delete the Auth user last. If it's already gone that's fine — the profile
  // and memberships (the things that grant access) are what matter, and they're
  // gone now.
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }

  invalidateCaller(uid);
  await writeActivityLog({
    caller,
    action: 'user.deleted',
    targetType: 'user',
    targetId: uid,
    targetName: target.email,
    metadata: { removedMemberships: memberships.size },
    severity: 'warning',
  });

  return NextResponse.json({ uid, deleted: true, removedMemberships: memberships.size });
});
