import { NextResponse } from 'next/server';
import { type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { getAccountActivity } from '@/server/accountActivity';

// GET /api/accounts/:accountId/activity
//
// The account's own posting ledger, aggregated from `jobs` (see
// server/accountActivity.ts). Any provisioned caller may read it — same posture
// as reading the account doc (no secrets; jobs' reply bodies are summarised, not
// returned). Used by the account Dashboard tab.

type Ctx = { params: Promise<{ accountId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, _caller: Caller, ctx: Ctx) => {
  const { accountId } = await ctx.params;
  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const activity = await getAccountActivity(accountId);
  return NextResponse.json(activity);
});
