import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requireProjectPermission, invalidateCaller, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import {
  PERMISSION_BUNDLES,
  expandBundle,
  isPermission,
  type Permission,
  type PermissionBundle,
} from '@/lib/types';

// Project membership — the authorization record itself.
//
// Note what a member CANNOT do, proven by the rules tests: write this document.
// If they could, every permission below would be self-grantable and the whole
// model would be decorative.

type Ctx = { params: Promise<{ projectId: string }> };

/** GET — list members. Requires project.view. */
export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const snap = await adminDb().collection('projects').doc(projectId).collection('members').get();

  return NextResponse.json({ members: snap.docs.map((d) => d.data()) });
});

interface AddBody {
  email?: string;
  /** A built-in bundle name (viewer/analyst/…). */
  bundle?: string;
  /** A custom role document id from roles/{roleId}. */
  roleId?: string;
  /** An explicit permission list (the granular editor). */
  permissions?: string[];
  /** Display-only label to store when granting an explicit list. */
  roleLabel?: string;
}

/**
 * POST — add or update a member. Requires project.members.
 *
 * The user must already be provisioned on the platform. Granting project access
 * to an address that has never been provisioned would quietly create a second
 * provisioning path with weaker checks than the CLI, so it is refused.
 */
export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.members');

  const body = await jsonBody<AddBody>(req);
  const email = body.email?.trim().toLowerCase();
  if (!email) return badRequest('An email address is required.');

  const db = adminDb();

  // Resolve permissions from a built-in bundle, a custom role, or an explicit
  // list. Whichever it is, we store the EXPANDED array below, never the role
  // reference — so redefining a role later never silently changes live grants.
  let permissions: Permission[];
  let grantedFromBundle: string | null = null;

  if (body.bundle) {
    if (!(body.bundle in PERMISSION_BUNDLES)) {
      return badRequest(`Unknown bundle "${body.bundle}". Options: ${Object.keys(PERMISSION_BUNDLES).join(', ')}.`);
    }
    permissions = expandBundle(body.bundle as PermissionBundle);
    grantedFromBundle = body.bundle;
  } else if (body.roleId) {
    const roleSnap = await db.collection('roles').doc(body.roleId).get();
    if (!roleSnap.exists) return badRequest('Unknown role.');
    const role = roleSnap.data()!;
    permissions = ((role.permissions ?? []) as unknown[]).filter(isPermission) as Permission[];
    if (permissions.length === 0) return badRequest('That role grants no permissions.');
    grantedFromBundle = role.name ?? null;
  } else if (Array.isArray(body.permissions)) {
    const bad = body.permissions.filter((p) => !isPermission(p));
    if (bad.length) return badRequest(`Unknown permissions: ${bad.join(', ')}.`);
    permissions = body.permissions as Permission[];
    grantedFromBundle = typeof body.roleLabel === 'string' ? body.roleLabel : null;
  } else {
    return badRequest('Provide a bundle, a roleId, or an explicit permissions array.');
  }

  const users = await db.collection('users').where('email', '==', email).limit(1).get();
  if (users.empty) {
    return badRequest(
      `${email} is not provisioned on Engage yet. Add them first: node tools/provision-user.mjs ${email}`,
    );
  }

  const user = users.docs[0].data();

  await db
    .collection('projects')
    .doc(projectId)
    .collection('members')
    .doc(user.uid)
    .set(
      {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        permissions,
        grantedFromBundle,
        grantedBy: caller.uid,
        grantedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  // Their new permissions on this project must apply now, not after the TTL.
  invalidateCaller(user.uid);

  return NextResponse.json({ uid: user.uid, email: user.email, permissions }, { status: 201 });
});
