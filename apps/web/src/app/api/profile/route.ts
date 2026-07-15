import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/server/admin';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import type { Caller } from '@/server/auth';

// PATCH /api/profile — edit your own profile.
//
// The security property here is what it does NOT accept. A user may change
// their display name and avatar. Nothing else. `role`, `status` and
// `globalPermissions` are not read from the body at all — they are not
// filtered out, they are simply never looked at, so no amount of creative
// JSON reaches them.
//
// The uid comes from the verified token, so this can only ever edit the
// caller's own record. There is no uid parameter to swap.

interface Body {
  displayName?: string;
  avatarUrl?: string | null;
}

export const PATCH = withAuth(async (req: Request, caller: Caller) => {
  const body = await jsonBody<Body>(req);
  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (body.displayName !== undefined) {
    const name = body.displayName.trim();
    if (!name) return badRequest('Your name cannot be empty.');
    if (name.length > 80) return badRequest('That name is too long (80 characters max).');
    updates.displayName = name;
  }

  if (body.avatarUrl !== undefined) {
    const url = body.avatarUrl?.trim() ?? '';
    if (url && !/^https:\/\//i.test(url)) {
      // https only: an http:// avatar would be a mixed-content request, and a
      // javascript: or data: URL rendered into an <img src> is a self-XSS.
      return badRequest('An avatar URL must start with https://');
    }
    updates.avatarUrl = url || null;
  }

  if (Object.keys(updates).length === 1) {
    return badRequest('Nothing to update.');
  }

  await adminDb().collection('users').doc(caller.uid).update(updates);

  // Keep the Auth record in step so Google-sourced names don't drift back.
  if (updates.displayName) {
    await adminAuth().updateUser(caller.uid, { displayName: updates.displayName as string });
  }

  return NextResponse.json({ ok: true, displayName: updates.displayName ?? caller.profile.displayName });
});
