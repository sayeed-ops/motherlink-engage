import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import { withAuth, type Handler } from '@/server/route';
import type { Caller } from '@/server/auth';

// POST /api/auth/session — record a sign-in.
//
// This exists because clients cannot write. ML Studio's AuthContext calls
// updateLastLogin() directly from the browser, which works there only because
// its rules let any signed-in user write any user document — the same opening
// that let anyone edit anyone else's profile and role.
//
// Here the browser asks and the server decides, and the server will only ever
// stamp the caller's OWN document: the uid comes from the verified token, not
// from the request body, so there is no parameter to tamper with.

const handler: Handler<unknown> = async (_req, caller: Caller) => {
  await adminDb().collection('users').doc(caller.uid).update({
    lastLoginAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
};

export const POST = withAuth(handler);
