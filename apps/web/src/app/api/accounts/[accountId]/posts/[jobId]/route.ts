import { NextResponse } from 'next/server';
import { type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { getAccountPostContext } from '@/server/accountPosts';

// GET /api/accounts/:accountId/posts/:jobId
//
// The saved post + analysis + comment for one of this account's posted replies,
// so the Dashboard can show it IN-APP instead of opening the live comment on
// Reddit (see server/accountPosts.ts for why that matters). Any provisioned
// caller may read it — same posture as the account activity list; the content is
// project-internal, not secret.

type Ctx = { params: Promise<{ accountId: string; jobId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, _caller: Caller, ctx: Ctx) => {
  const { accountId, jobId } = await ctx.params;
  const context = await getAccountPostContext(accountId, jobId);
  if (!context) return badRequest('No such post for this account.');
  return NextResponse.json(context);
});
