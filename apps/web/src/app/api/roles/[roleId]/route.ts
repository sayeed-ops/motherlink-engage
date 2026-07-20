import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { requirePlatformAdmin, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { PERMISSION_BUNDLES, isPermission, type Permission } from '@/lib/types';

// Edit or delete a custom role.
//
// Editing a role changes only the TEMPLATE. Members already granted from it keep
// the exact permissions they were given (the member document stores the expanded
// array), so this can never silently widen or narrow live access. Same for
// delete — it removes the picker option, nothing else.

type Ctx = { params: Promise<{ roleId: string }> };

const RESERVED = new Set(Object.keys(PERMISSION_BUNDLES));

interface PatchBody {
  name?: string;
  description?: string;
  permissions?: string[];
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { roleId } = await ctx.params;

  const db = adminDb();
  const ref = db.collection('roles').doc(roleId);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('No such role.');

  const body = await jsonBody<PatchBody>(req);
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 60);
    if (!name) return badRequest('A role name is required.');
    if (RESERVED.has(name.toLowerCase())) {
      return badRequest(`"${name}" is a built-in role name. Choose a different name.`);
    }
    const clash = await db.collection('roles').where('name', '==', name).limit(1).get();
    if (!clash.empty && clash.docs[0].id !== roleId) {
      return badRequest(`A role named "${name}" already exists.`);
    }
    updates.name = name;
  }

  if (body.description !== undefined) {
    updates.description = body.description.trim().slice(0, 200);
  }

  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions)) return badRequest('permissions must be an array.');
    const bad = body.permissions.filter((p) => !isPermission(p));
    if (bad.length) return badRequest(`Unknown permissions: ${bad.join(', ')}.`);
    const permissions = [...new Set(body.permissions.filter(isPermission))] as Permission[];
    if (permissions.length === 0) return badRequest('A role must grant at least one permission.');
    updates.permissions = permissions;
  }

  await ref.update(updates);
  return NextResponse.json({ id: roleId, ...updates, updatedAt: undefined });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requirePlatformAdmin(caller);
  const { roleId } = await ctx.params;

  const ref = adminDb().collection('roles').doc(roleId);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('No such role.');

  await ref.delete();
  return NextResponse.json({ id: roleId, deleted: true });
});
