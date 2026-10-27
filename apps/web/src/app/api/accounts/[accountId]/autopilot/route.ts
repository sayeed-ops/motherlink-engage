import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { adminDb } from '@/server/admin';
import { accountExists, getAccount } from '@/server/accounts';
import { cancelPlannedSessions, getAutopilotSettings, pauseReason, planAccount, setAccountAutopilot, timezoneOf } from '@/server/autopilot';
import { writeActivityLog } from '@/server/activityLog';
import { isTimezone, stageFor } from '@/modules/reddit/autopilot';
import { warmupDayFor } from '@/modules/reddit/warmupWalk';

// POST /api/accounts/[accountId]/autopilot  { enabled?, timezone?, replan? }
//
// Switch the account's warm-up autopilot on or off, set its time zone, or plan
// the rest of today again. Switching on plans what is left of today straight
// away; switching off cancels the sessions it planned that have not started.
// Same gate as running a session by hand.

type Ctx = { params: Promise<{ accountId: string }> };

// GET — what the Autopilot tab shows: the account's stage, time zone, and
// today's sessions with how each is going. Job statuses are read here because
// warm-up jobs belong to no project, so most people cannot read them directly.
export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');
  const settings = await getAutopilotSettings();
  const ap = (account.autopilot ?? {}) as { enabled?: boolean; timezone?: string; lastPlan?: { sessions?: { jobId?: string }[] } };
  const startedAtMs = (account.warmupStartedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
  const day = startedAtMs ? warmupDayFor(startedAtMs, Date.now()) : 0;
  const ids = (ap.lastPlan?.sessions ?? []).map((s) => s.jobId).filter((x): x is string => !!x);
  const jobs = ids.length ? await adminDb().getAll(...ids.map((id) => adminDb().collection('jobs').doc(id))) : [];
  const status: Record<string, { status: string; error: string }> = {};
  for (const j of jobs) if (j.exists) status[j.id] = { status: String(j.get('status') ?? ''), error: String(j.get('error') ?? '').slice(0, 160) };
  return NextResponse.json({
    enabled: ap.enabled === true,
    timezone: timezoneOf(account, settings),
    ownTimezone: typeof ap.timezone === 'string' ? ap.timezone : '',
    day,
    stage: stageFor(settings, Math.max(1, day)).stage.name,
    paused: pauseReason(account),
    lastPlan: ap.lastPlan ?? null,
    jobStatus: status,
    // For the tab's "next plan in …" countdown.
    wakeStart: settings.wakeStart,
    wakeEnd: settings.wakeEnd,
  });
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;
  if (!(await accountExists(accountId))) return badRequest('No such account.');
  const body = await jsonBody<{ enabled?: unknown; timezone?: unknown; replan?: unknown }>(req);

  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== '' && !isTimezone(body.timezone)) {
    return badRequest('Unknown time zone — use a name like Europe/London or America/Chicago.');
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  await setAccountAutopilot(accountId, {
    enabled,
    timezone: body.timezone === undefined ? undefined : (body.timezone as string) || null,
  });

  let result = null;
  if (enabled === true || body.replan === true) {
    const replan = body.replan === true;
    if (replan) await cancelPlannedSessions(accountId);
    result = await planAccount(accountId, await getAutopilotSettings(), { force: true, replan });
  }
  if (enabled !== undefined) {
    await writeActivityLog({
      caller,
      action: enabled ? 'warmup.autopilot_on' : 'warmup.autopilot_off',
      targetType: 'account',
      targetId: accountId,
      targetName: accountId,
      metadata: result ? { outcome: result.outcome, detail: result.detail } : {},
    });
  }
  return NextResponse.json({ ok: true, result });
});
