import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { adminDb } from '@/server/admin';
import { getAccount } from '@/server/accounts';
import { writeActivityLog } from '@/server/activityLog';
import {
  composeWarmupSession,
  normalizeWarmupPolicy,
  DEFAULT_POLICY,
  warmupDayFor,
} from '@/modules/reddit/warmupWalk';

// POST /api/accounts/[accountId]/warmup/run — queue ONE browsing session now.
//
// The manual trigger, for testing and for an operator who wants a session on
// demand. A scheduler will eventually call the same composition path on a
// due-time; this is deliberately the smaller half of that, so the loop is
// runnable end-to-end before any cron exists.
//
// THE PLAN IS COMPOSED HERE AND FROZEN ONTO THE JOB, exactly like the posting
// approach plan. The browser's preview is a preview: it shows the shape, but the
// authoritative walk is rolled server-side so what runs is what was recorded, and
// the agent re-rolls nothing.
//
// Note what this does NOT do: it does not touch dailyCap, minIntervalMinutes or
// postCountToday. Those count submitted comments. A browsing session posts
// nothing and must not consume a posting slot.

type Ctx = { params: Promise<{ accountId: string }> };

interface Body {
  /** Override the derived warm-up day — testing a later day without waiting. */
  day?: number;
  /** Subreddits the walk may open or search for. */
  subreddits?: string[];
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');

  const profileId = (account.adsPowerProfileId as string) || '';
  if (!profileId) return badRequest('This account has no AdsPower profile id — the agent needs it to open a browser.');
  const status = account.status as string;
  if (status === 'banned' || status === 'flagged') {
    return badRequest(`This account is ${status}. Warm-up will not drive it.`);
  }

  // One session at a time per account. Two concurrent browses from one profile
  // would fight over the same AdsPower window.
  const inFlight = await adminDb()
    .collection('jobs')
    .where('accountId', '==', accountId)
    .where('status', 'in', ['queued', 'posting'])
    .limit(1)
    .get();
  if (!inFlight.empty) {
    const j = inFlight.docs[0].data();
    return badRequest(
      j.kind === 'warmup'
        ? 'A warm-up session is already queued for this account.'
        : 'This account has a reply queued — let that finish first.',
    );
  }

  const body = await jsonBody<Body>(req);

  const startedAt = account.warmupStartedAt as { toMillis?: () => number } | undefined;
  const startedAtMs = startedAt?.toMillis?.() ?? 0;
  const derivedDay = warmupDayFor(startedAtMs, Date.now());
  const day = Math.max(1, Math.min(60, Math.round(Number(body.day)) || derivedDay));

  const subreddits = Array.isArray(body.subreddits)
    ? body.subreddits.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().replace(/^r\//, '')).slice(0, 40)
    : Array.isArray(account.warmupSubreddits)
      ? (account.warmupSubreddits as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

  const policy =
    normalizeWarmupPolicy({ ...(account.warmupPolicy as object | undefined), subreddits, searchTargets: subreddits }) ??
    { ...DEFAULT_POLICY, subreddits, searchTargets: subreddits };

  const session = composeWarmupSession({ day, policy });
  if (!session.plan.length) return badRequest('The composer produced an empty session — check the policy.');

  const ref = adminDb().collection('jobs').doc();
  await ref.set({
    jobId: ref.id,
    kind: 'warmup',
    accountId,
    adsPowerProfileId: profileId,
    expectedUsername: (account.username as string) || '',
    warmupPlan: session.plan,
    warmupDay: session.day,
    warmupUpvoteChance: session.upvoteChance,
    warmupUpvoteBudget: session.upvoteBudget,
    warmupStoppedBy: session.stoppedBy,
    warmupSeed: session.seed,
    status: 'queued',
    attempts: 0,
    createdBy: caller.uid,
    createdByName: caller.profile.displayName,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Stamp the start of the warm-up on first run, so the ramp has an origin. Only
  // ever set once — the day is derived from it and must not drift.
  if (!startedAtMs) {
    await adminDb().collection('accounts').doc(accountId).update({
      warmupStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await writeActivityLog({
    caller,
    action: 'warmup.session_queued',
    targetType: 'account',
    targetId: accountId,
    targetName: (account.label as string) || accountId,
    metadata: { day: session.day, steps: session.plan.length, upvoteBudget: session.upvoteBudget },
  });

  return NextResponse.json({ jobId: ref.id, session }, { status: 201 });
});
