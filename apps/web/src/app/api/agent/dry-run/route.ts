import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { setDryRun } from '@/server/agentControl';

// POST /api/agent/dry-run  { dryRun: boolean }
//
// Flip the local posting agent between dry-run (types but never submits) and
// live posting. The agent re-reads this every poll, so the change takes effect
// within seconds without a restart. Global control (one agent, one queue), so
// gated on accounts.manage like the accounts it governs. Reads happen
// client-side via the SDK (agents/control is world-readable to signed-in users).

export const POST = withAuth(async (req: Request, caller: Caller) => {
  requireGlobalPermission(caller, 'accounts.manage');

  const body = await jsonBody<{ dryRun?: unknown; platform?: unknown }>(req);
  if (typeof body.dryRun !== 'boolean') return badRequest('dryRun must be true or false.');
  const platform = body.platform === undefined ? 'reddit' : body.platform;
  if (platform !== 'reddit' && platform !== 'shopify') return badRequest('platform must be reddit or shopify.');

  await setDryRun(body.dryRun, caller.uid, caller.profile.displayName, platform);
  return NextResponse.json({ dryRun: body.dryRun, platform });
});
