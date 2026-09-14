import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { createAccount, type AccountInput } from '@/server/accounts';
import { isAccountPlatform, cleanUsername } from '@/modules/accounts/platform';

// POST /api/accounts — create a posting identity.
//
// Gated on the global `accounts.manage` permission (platform admins hold it
// implicitly). Accounts are top-level, not per-project, so this is a global
// grant rather than a project permission.
//
// Reads are not here: the accounts list is read client-side via the SDK (rules
// allow any signed-in user, since accounts carry no secrets). Only writes pass
// through the server.

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');

  const body = await jsonBody<Partial<AccountInput>>(req);
  const label = body.label?.trim();
  const adsPowerProfileId = body.adsPowerProfileId?.trim();
  if (!label) return badRequest('A label is required.');
  if (!adsPowerProfileId) return badRequest('An AdsPower profile ID is required — the agent needs it to post.');
  if (body.platform !== undefined && !isAccountPlatform(body.platform)) return badRequest('Unknown platform.');
  const platform = body.platform ?? 'reddit';
  // On the Shopify Community the username is not optional: the agent compares it
  // with the signed-in forum user before typing, and has nothing to compare
  // against without it.
  if (platform === 'shopify' && !cleanUsername(body.username, 'shopify')) {
    return badRequest('A Shopify Community username is required — the agent checks it before posting.');
  }

  const accountId = await createAccount(
    {
      platform,
      label,
      username: body.username ?? '',
      adsPowerProfileId,
      status: body.status ?? 'warming',
      dailyCap: body.dailyCap ?? 5,
      minIntervalMinutes: body.minIntervalMinutes ?? 45,
      karma: body.karma ?? 0,
      notes: body.notes ?? '',
    },
    caller.uid,
    caller.profile.displayName,
  );

  return NextResponse.json({ accountId, label }, { status: 201 });
});
