import { NextResponse } from 'next/server';
import { adminDb } from '@/server/admin';
import { withAuth } from '@/server/route';

// A minimal people directory for the project member picker.
//
// Why this exists separately from GET /api/users (which is platform-admin only
// and returns roles, status, last-seen): granting project access requires only
// project.members on that project, which a non-admin can hold. Such a person
// still needs to pick WHO to add, so they need a candidate list — but they have
// no business seeing platform roles or account status.
//
// So this returns the low-sensitivity minimum (uid, name, email) for anyone
// provisioned. In an internal team tool where every user is staff and each
// project already shows its own roster to members, exposing colleagues' names
// and emails to add them is a negligible disclosure; roles/status stay admin-only.
//
// Disabled/archived users are omitted — there's no reason to grant a retired
// account new project access.
export const GET = withAuth(async () => {
  const snap = await adminDb().collection('users').orderBy('email').get();

  const people = snap.docs
    .map((d) => d.data())
    .filter((u) => u.status !== 'disabled' && u.status !== 'archived')
    .map((u) => ({ uid: u.uid, email: u.email, displayName: u.displayName }));

  return NextResponse.json({ people });
});
