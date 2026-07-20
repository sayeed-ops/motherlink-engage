import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { saveWarmupPlan, clearWarmupPlan } from '@/server/warmup';
import { normalizeWarmupPlan } from '@/modules/reddit/warmup';

// Save or clear an account's warm-up plan.
//
// Gated on `accounts.manage` (platform admins hold it implicitly) — the same
// gate as account CRUD. Reads happen client-side off the account doc; only
// writes come through here, and the plan is normalised server-side so the client
// can propose a shape but never store an out-of-bounds or unknown-action plan.

type Ctx = { params: Promise<{ accountId: string }> };

/** PUT — persist a (client-authored or AI-generated) plan. */
export const PUT = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const body = await jsonBody<{ plan?: unknown }>(req);
  const plan = normalizeWarmupPlan(body.plan);
  if (!plan) return badRequest('The plan is empty or malformed.');

  await saveWarmupPlan(accountId, plan, caller.uid);
  return NextResponse.json({ accountId, days: plan.days.length, source: plan.source });
});

/** DELETE — remove the plan entirely. */
export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  await clearWarmupPlan(accountId);
  return NextResponse.json({ accountId, cleared: true });
});
