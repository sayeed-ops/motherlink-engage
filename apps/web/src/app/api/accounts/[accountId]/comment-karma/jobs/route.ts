import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth } from '@/server/route';
import { commentJobsForAccount } from '@/server/commentKarmaJobs';

// GET /api/accounts/[accountId]/comment-karma/jobs — the route each queued
// comment is taking, or took, keyed by draft id. Read-only; no Reddit, no model,
// nothing billed. See server/commentKarmaJobs.ts for why the panel asks here.

type Ctx = { params: Promise<{ accountId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  return NextResponse.json({ jobs: await commentJobsForAccount(accountId) });
});
