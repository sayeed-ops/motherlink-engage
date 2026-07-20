import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getAccount } from '@/server/accounts';
import { designWarmupPlan } from '@/server/warmup';
import type { WarmupComposeContext } from '@/modules/reddit/warmup';

// POST /api/accounts/[accountId]/warmup/generate — AI-design a plan.
//
// Returns a fresh plan for the given number of days; it is NOT saved (the client
// previews and edits, then PUTs it back). DeepSeek shapes the day-by-day
// schedule and the server expands it into concrete, bounded actions — see
// designWarmupPlan. Falls back to a deterministic composer when DeepSeek is
// unavailable, so this always returns a usable plan.

type Ctx = { params: Promise<{ accountId: string }> };

interface Body {
  days?: number;
  keywords?: string[];
  subreddits?: string[];
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');

  const body = await jsonBody<Body>(req);
  const days = Math.max(1, Math.min(60, Math.round(Number(body.days)) || 7));

  const clean = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()).slice(0, 25) : [];

  const context: WarmupComposeContext = {
    keywords: clean(body.keywords),
    subreddits: clean(body.subreddits),
    // The account's notes double as a persona hint for the model.
    persona: typeof account.notes === 'string' ? (account.notes as string).slice(0, 500) : undefined,
  };

  const { plan, ai } = await designWarmupPlan(days, context);
  return NextResponse.json({ plan, ai });
});
