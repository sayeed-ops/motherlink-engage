import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { updateAccount, deleteAccount, accountExists, type AccountInput } from '@/server/accounts';

// PATCH / DELETE /api/accounts/:accountId
//
// Edit or remove a posting identity. Both gated on the global `accounts.manage`
// permission. Deleting an account leaves any posted replies untouched — it only
// removes the identity mapping.

type Ctx = { params: Promise<{ accountId: string }> };

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  const body = await jsonBody<Partial<AccountInput>>(req);
  if (body.label !== undefined && !body.label.trim()) return badRequest('Label cannot be empty.');
  if (body.adsPowerProfileId !== undefined && !body.adsPowerProfileId.trim()) {
    return badRequest('An AdsPower profile ID is required — the agent needs it to post.');
  }

  // Prove it exists first — update() on a missing doc would 500.
  if (!(await accountExists(accountId))) return badRequest('No such account.');

  await updateAccount(accountId, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  await deleteAccount(accountId);
  return NextResponse.json({ deleted: true });
});
