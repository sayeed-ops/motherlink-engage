import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { accountExists, requestStatsRefresh } from '@/server/accounts';

// POST /api/accounts/:accountId/refresh-stats
//
// The "Update data" button. It does NOT crawl Reddit — it sets a flag the local
// poster agent honours the next time it opens this account's AdsPower profile
// (post or warm-up session), capturing karma/subscriptions/age on the account's
// own session and IP. Opportunistic by design: no scheduled central fetch that
// would correlate the accounts. Gated on `accounts.manage`, like account CRUD.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  await requestStatsRefresh(accountId, caller.uid);
  return NextResponse.json({ ok: true, requested: true });
});
