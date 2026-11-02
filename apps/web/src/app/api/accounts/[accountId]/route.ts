import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { updateAccount, deleteAccount, getAccount, type AccountInput } from '@/server/accounts';
import { accountPlatform, cleanUsername } from '@/modules/accounts/platform';
import { READY_AFTER_DAYS, READY_WARMUP_DAYS, warmupReadiness } from '@/modules/reddit/warmupReadiness';

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
  const existing = await getAccount(accountId);
  if (!existing) return badRequest('No such account.');
  if (body.platform !== undefined && body.platform !== accountPlatform(existing)) {
    return badRequest("An account's platform is fixed when it is created — add a new account instead.");
  }
  if (accountPlatform(existing) === 'shopify' && body.username !== undefined && !cleanUsername(body.username, 'shopify')) {
    return badRequest('A Shopify Community username is required — the agent checks it before posting.');
  }

  // A warming Reddit account becomes active by earning it, not by being edited.
  // The same rule the autopilot pass applies, so the two can never disagree.
  if (accountPlatform(existing) === 'reddit' && existing.status === 'warming' && body.status === 'active') {
    const createdAtMs = (existing.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const days = Number((existing.warmupProgress as { days?: number } | undefined)?.days ?? 0);
    if (!warmupReadiness(createdAtMs, days, Date.now()).ready) {
      return badRequest(
        `A Reddit account becomes active by itself after ${READY_AFTER_DAYS} days in Engage, including ${READY_WARMUP_DAYS} days of warm-up.`,
      );
    }
  }

  await updateAccount(accountId, body);
  return NextResponse.json({ ok: true });
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await getAccount(accountId))) return badRequest('No such account.');

  await deleteAccount(accountId);
  return NextResponse.json({ deleted: true });
});
