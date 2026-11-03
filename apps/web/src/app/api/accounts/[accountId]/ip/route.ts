import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { getAccount } from '@/server/accounts';
import { checkProxy, PoolError } from '@/server/proxyPool';

// POST /api/accounts/:accountId/ip — "Update IP data": check the account's
// proxy from the web server. Never wakes the posting server.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const account = await getAccount((await ctx.params).accountId);
  if (!account) return badRequest('No such account.');
  const key = account.proxyKey;
  if (typeof key !== 'string' || !key) return badRequest('This account is not linked to a proxy on the list yet.');
  try {
    return NextResponse.json(await checkProxy(key));
  } catch (err) {
    if (err instanceof PoolError) return badRequest(err.message);
    throw err;
  }
});
