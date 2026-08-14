import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/server/admin';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { GLOBAL_ROLES, globalPermissionsForRole, type GlobalRole } from '@/lib/types';
import { sendInviteEmail } from '@/server/email';

// Users — provisioning and listing.
//
// There is no invitation token anywhere in this file, and that is the point.
//
// ML Studio's flow: an admin's BROWSER generates a token with Math.random(),
// writes it to Firestore in plaintext, and emails a signup link. Anyone could
// read those tokens (rules allowed it at limit==1, and the deployed rules
// allowed everything). Whoever held a token could create an account with the
// role baked into it.
//
// Engage: an admin provisions an email address. The user signs in with Google.
// The server matches their *verified* Google email to a users/{uid} document.
// Nothing to generate, guess, expire, leak, or enumerate. The email we send is
// a courtesy, not a credential — it carries no secret, and losing it costs
// nothing.

/** GET /api/users — platform admins only. */
export const GET = withAuth(async (_req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);

  const snap = await adminDb().collection('users').orderBy('email').get();

  return NextResponse.json({
    users: snap.docs.map((d) => {
      const u = d.data();
      return {
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        status: u.status,
        // Normalised here so the roster never has to know that absent means
        // allowed — the client gets a plain boolean either way.
        canUseSharedKeys: u.canUseSharedKeys !== false,
        lastLoginAt: u.lastLoginAt?.toDate?.()?.toISOString() ?? null,
        createdAt: u.createdAt?.toDate?.()?.toISOString() ?? null,
      };
    }),
  });
});

interface CreateBody {
  email?: string;
  displayName?: string;
  role?: string;
  sendEmail?: boolean;
}

/**
 * POST /api/users — provision someone.
 *
 * Idempotent on email: calling twice updates rather than duplicating, so a
 * double-click cannot create a second account for the same person.
 */
export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);

  const body = await jsonBody<CreateBody>(req);
  const email = body.email?.trim().toLowerCase();
  const role = (body.role ?? 'member') as GlobalRole;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return badRequest('A valid email address is required.');
  }
  if (!GLOBAL_ROLES.includes(role)) {
    return badRequest(`Role must be one of: ${GLOBAL_ROLES.join(', ')}.`);
  }

  // Only an owner may mint another owner. ML Studio let any admin issue a
  // super_admin invitation despite admins having canManageRoles: false — the
  // UI offered it and the rules only checked isAdmin().
  if (role === 'owner' && caller.role !== 'owner') {
    return badRequest('Only an owner can create another owner.');
  }

  const auth = adminAuth();
  const db = adminDb();
  const displayName = body.displayName?.trim() || email.split('@')[0];

  let user;
  let created = false;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    user = await auth.createUser({ email, displayName, emailVerified: false });
    created = true;
  }

  // Mirror the role into a custom claim so rules can check it without a read.
  await auth.setCustomUserClaims(user.uid, { role });

  const ref = db.collection('users').doc(user.uid);
  const existing = await ref.get();

  await ref.set(
    {
      uid: user.uid,
      email,
      displayName,
      avatarUrl: user.photoURL ?? null,
      role,
      status: 'active',
      globalPermissions: globalPermissionsForRole(role),
      // Default-allow for a new person, PRESERVED for an existing one. This POST
      // is idempotent on email, so re-provisioning someone must not quietly hand
      // org spend back to a person an admin deliberately cut off — unlike `role`
      // above, which the caller is explicitly restating on every call.
      canUseSharedKeys: existing.exists ? (existing.data()!.canUseSharedKeys ?? true) : true,
      createdAt: existing.exists ? existing.data()!.createdAt : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: existing.exists ? (existing.data()!.lastLoginAt ?? null) : null,
      invitedBy: existing.exists ? existing.data()!.invitedBy : caller.uid,
    },
    { merge: true },
  );

  // Best-effort. A failed send must not lose the provisioning we just did — the
  // user can sign in regardless, since the email carries no secret.
  let emailed: boolean | null = null;
  if (body.sendEmail) {
    emailed = await sendInviteEmail({ to: email, invitedByName: caller.profile.displayName });
  }

  return NextResponse.json(
    { uid: user.uid, email, role, created, emailed },
    { status: created ? 201 : 200 },
  );
});
