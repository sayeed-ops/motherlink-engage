import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, badRequest } from '@/server/route';
import { accountExists } from '@/server/accounts';
import { cancelWarmupJobs } from '@/server/warmup';
import { writeActivityLog } from '@/server/activityLog';

// POST /api/accounts/[accountId]/warmup/cancel — let go of a stuck session.
//
// The case this is for: the agent is restarted mid-session (which is exactly
// what happens after a code change), the job stays in `posting` forever from the
// app's point of view, and every subsequent run is refused with "a warm-up
// session is already queued". The agent's stale reclaim does clear it eventually,
// but until this route existed there was no way to say "that one is dead".
//
// Gated on `accounts.manage`, the same gate as running one. Only ever touches
// `kind: 'warmup'` jobs — a queued reply is not cancellable from here.

type Ctx = { params: Promise<{ accountId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  if (!(await accountExists(accountId))) return badRequest('No such account.');

  const { cancelled, wasRunning } = await cancelWarmupJobs(accountId);

  if (cancelled > 0) {
    await writeActivityLog({
      caller,
      action: 'warmup.session_cancelled',
      targetType: 'account',
      targetId: accountId,
      targetName: accountId,
      metadata: { cancelled, wasRunning },
    });
  }

  return NextResponse.json({
    accountId,
    cancelled,
    wasRunning,
    message:
      cancelled === 0
        ? 'Nothing to cancel — no warm-up session is queued or running for this account.'
        : wasRunning
          ? `Cancelled ${cancelled} session(s). One was already running: the browser will finish what it started, but nothing is recorded and no further session is blocked.`
          : `Cancelled ${cancelled} queued session(s).`,
  });
});
