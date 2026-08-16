import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { checkCommentOutcomes } from '@/server/commentKarma';

// The outcome sweep, and what it has taught this account.
//
// POST — go and look at Reddit. One BILLED read per comment due a check, capped
//        per sweep, so a press cannot quietly cost twenty reads.
//
// There is no GET. The panel computes the same aggregate CLIENT-side from the
// records it is already subscribed to, using the same pure functions the server
// uses to fit the scan's knobs — one implementation, two call sites, and no way
// for the numbers an operator reads to drift from the numbers the scan acts on.
//
// Operator-triggered like the scan, and deliberately not a cron: a check that
// falls due simply waits, and `dueCheck` is time-based rather than tick-based,
// so a late sweep still records a real measurement — with `ageHours` stored, so
// a late reading can never be mistaken for an on-time one.

export const maxDuration = 60;

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  try {
    return NextResponse.json({ sweep: await checkCommentOutcomes(accountId) });
  } catch (err) {
    // Almost always the Crawlzo key or a rate limit, and both are actionable.
    return badRequest(err instanceof Error ? err.message : 'The outcome sweep could not run.');
  }
});
