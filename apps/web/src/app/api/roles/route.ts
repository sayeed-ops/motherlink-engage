import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import {
  PERMISSION_BUNDLES,
  builtInRoles,
  isPermission,
  type Permission,
  type RoleSummary,
} from '@/lib/types';

// Roles — reusable, named per-project permission sets.
//
// Two sources, one flat list to the caller:
//   - the four BUILT-IN bundles (viewer/analyst/approver/manager) live in code
//     and are read-only here;
//   - CUSTOM roles live in roles/{roleId} and are created/edited by admins.
//
// A role is only a template for the picker. Granting one always writes the
// EXPANDED permission array onto the member document (see the members route),
// never a role reference — so editing or deleting a role later never silently
// changes anyone's live access. That is the same guarantee the built-in bundles
// already gave, extended to custom roles.

/** Names that can never be taken by a custom role — they'd shadow a built-in. */
const RESERVED = new Set(Object.keys(PERMISSION_BUNDLES));

function sanitizeName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
}

function sanitizePermissions(raw: unknown): { permissions: Permission[]; bad: string[] } {
  if (!Array.isArray(raw)) return { permissions: [], bad: [] };
  const bad = raw.filter((p) => !isPermission(p)).map(String);
  const permissions = [...new Set(raw.filter(isPermission))] as Permission[];
  return { permissions, bad };
}

/**
 * GET — the full role list (built-in + custom).
 *
 * Available to any provisioned caller: roles are non-secret permission
 * templates, and the project member picker (gated on project.members) needs
 * them. Nothing here reveals which clients exist or who is on them.
 */
export const GET = withAuth(async () => {
  const snap = await adminDb().collection('roles').orderBy('name').get();
  const custom: RoleSummary[] = snap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id,
      name: r.name,
      description: r.description ?? '',
      permissions: (r.permissions ?? []).filter(isPermission) as Permission[],
      builtIn: false,
    };
  });

  return NextResponse.json({ roles: [...builtInRoles(), ...custom] });
});

interface CreateBody {
  name?: string;
  description?: string;
  permissions?: string[];
}

/** POST — create a custom role. Platform admins only. */
export const POST = withAuth(async (req: Request, caller: Caller) => {
  requirePlatformAdmin(caller);

  const body = await jsonBody<CreateBody>(req);
  const name = sanitizeName(body.name);
  if (!name) return badRequest('A role name is required.');
  if (RESERVED.has(name.toLowerCase())) {
    return badRequest(`"${name}" is a built-in role name. Choose a different name.`);
  }

  const { permissions, bad } = sanitizePermissions(body.permissions);
  if (bad.length) return badRequest(`Unknown permissions: ${bad.join(', ')}.`);
  if (permissions.length === 0) return badRequest('A role must grant at least one permission.');

  const db = adminDb();

  // Custom role names are unique (case-insensitive) so the picker is unambiguous.
  const clash = await db.collection('roles').where('name', '==', name).limit(1).get();
  if (!clash.empty) return badRequest(`A role named "${name}" already exists.`);

  const ref = db.collection('roles').doc();
  await ref.set({
    name,
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 200) : '',
    permissions,
    createdBy: caller.uid,
    createdByName: caller.profile.displayName,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: ref.id, name, permissions }, { status: 201 });
});
