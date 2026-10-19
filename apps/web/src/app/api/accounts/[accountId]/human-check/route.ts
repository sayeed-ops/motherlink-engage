import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { adminDb } from '@/server/admin';
import { humanCheckOf } from '@/modules/accounts/humanCheck';

// POST /api/accounts/:accountId/human-check — "I have solved it."
//
// The only way an open human check is cleared. The agent never clears one: it
// cannot know whether a person solved the check or it simply went away, and
// that difference is the whole point of the stop. Who said so, and when, is
// kept on the record.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  const ref = adminDb().collection('accounts').doc(accountId);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('No such account.');
  const check = humanCheckOf(snap.data());
  if (!check || check.status !== 'open') return badRequest('There is no open human check on this account.');

  await ref.update({
    'humanCheck.status': 'resolved',
    'humanCheck.resolvedAtMs': Date.now(),
    'humanCheck.resolvedBy': caller.uid,
    'humanCheck.resolvedByName': caller.profile.displayName,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
});
