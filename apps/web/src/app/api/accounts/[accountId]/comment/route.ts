import { NextResponse } from 'next/server';
import { requireOwner, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { openAccountComment } from '@/server/profileTasks';
import { writeActivityLog } from '@/server/activityLog';

// GET /api/accounts/[accountId]/comment — reveal the account's comment (logins,
// recovery details). Owner only, decrypted on request, never cached, and every
// reveal is written to the activity log.

type Ctx = { params: Promise<{ accountId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireOwner(caller);
  const { accountId } = await ctx.params;
  const comment = await openAccountComment(accountId);
  await writeActivityLog({
    caller,
    action: 'account.comment_revealed',
    targetType: 'account',
    targetId: accountId,
    targetName: accountId,
  });
  return NextResponse.json({ comment }, { headers: { 'Cache-Control': 'no-store' } });
});
