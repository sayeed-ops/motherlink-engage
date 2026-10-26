import { NextResponse } from 'next/server';
import { requireGlobalPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { getAccount } from '@/server/accounts';
import { accountPlatform } from '@/modules/accounts/platform';
import { humanCheckRefusal } from '@/modules/accounts/humanCheck';
import { writeActivityLog } from '@/server/activityLog';
import { SESSION_KIND_LABEL, type WarmupSessionKind } from '@/modules/reddit/warmupWalk';
import { wakeAgent } from '@/server/agentWake';
import { blockingJobFor, queueWarmupSession } from '@/server/warmupSession';

// POST /api/accounts/[accountId]/warmup/run — queue ONE browsing session now.
//
// The manual trigger, for testing and for an operator who wants a session on
// demand. A scheduler will eventually call the same composition path on a
// due-time; this is deliberately the smaller half of that, so the loop is
// runnable end-to-end before any cron exists.
//
// THE PLAN IS COMPOSED HERE AND FROZEN ONTO THE JOB, exactly like the posting
// approach plan — the agent re-rolls nothing.
//
// But it is composed from the SEED the operator previewed, so the session that
// runs is the one they looked at. The first version ignored the preview and
// rolled a fresh walk, which meant re-rolling to pick a session and then getting
// a different one: seven steps on screen, two steps executed. Deterministic
// composition makes the seed sufficient, so this keeps server authority without
// ever trusting a client-supplied step list.
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
  /** The seed of the session the operator actually previewed.
   *
   *  Composition is deterministic, so the seed IS the plan — sending it means
   *  what ran is exactly what was on screen, while the plan itself is still
   *  built HERE from a validated policy. Sending the composed plan instead would
   *  mean trusting client-supplied steps; sending nothing (the first version)
   *  meant re-rolling a different session out from under the operator, which is
   *  the whole reason this parameter exists. */
  seed?: number;
  /** Curve overrides from the panel's sliders. Passed through
   *  normalizeWarmupPolicy like any other untrusted input. */
  curve?: unknown;
  /** Follow-policy overrides from the Communities tab. Same treatment. */
  follow?: unknown;
  /** What this session is for. Each tab queues its own kind and only its own —
   *  a browsing roll must never join, however many targets are waiting. */
  kind?: string;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  requireGlobalPermission(caller, 'accounts.manage');
  const { accountId } = await ctx.params;

  const account = await getAccount(accountId);
  if (!account) return badRequest('No such account.');
  const humanCheck = humanCheckRefusal(account);
  if (humanCheck) return badRequest(humanCheck);
  if (accountPlatform(account) !== 'reddit') return badRequest('Warm-up is a Reddit routine — this is a Shopify Community account.');

  const profileId = (account.adsPowerProfileId as string) || '';
  if (!profileId) return badRequest('This account has no AdsPower profile id — the agent needs it to open a browser.');
  const status = account.status as string;
  if (status === 'banned' || status === 'flagged') {
    return badRequest(`This account is ${status}. Warm-up will not drive it.`);
  }

  // One session at a time per account. Two concurrent browses from one profile
  // would fight over the same AdsPower window. A session the autopilot planned
  // for later does not count (see blockingJobFor).
  const j = (await blockingJobFor(accountId)) as { kind?: string; status?: string; claimedAt?: { toMillis?: () => number } } | null;
  if (j) {
    if (j.kind !== 'warmup') {
      return badRequest(
        j.kind === 'comment'
          ? 'This account has a karma comment queued — let that finish first.'
          : 'This account has a reply queued — let that finish first.',
      );
    }
    // Say WHICH state it is in and how to get out of it. "Already queued" with no
    // way forward is what an operator hits after restarting the agent mid-run,
    // and it used to be a dead end until the stale reclaim happened to fire.
    const claimedMs = j.claimedAt?.toMillis?.() ?? 0;
    const runningFor = claimedMs ? Math.round((Date.now() - claimedMs) / 60_000) : 0;
    return badRequest(
      j.status === 'posting'
        ? `A warm-up session has been running for ${runningFor} minute(s). Sessions are capped at 12 — if the agent was restarted, this one is dead. Use Cancel to release it.`
        : 'A warm-up session is already queued for this account. Use Cancel to release it, or wait for the agent to pick it up.',
    );
  }

  const body = await jsonBody<Body>(req);

  // Same seed + same policy => byte-identical plan, so the operator runs the
  // session they looked at. Defaults to `browse` — the kind that can do the
  // least — so a caller that omits it can never accidentally queue a join.
  const kind: WarmupSessionKind =
    body.kind === 'follow' || body.kind === 'comment' || body.kind === 'post' ? body.kind : 'browse';

  if (kind === 'comment') {
    return badRequest(
      'Comment sessions are queued from the Comment karma tab, from an approved comment — a comment needs a specific thread and a body written for it, which a browsing roll cannot produce.',
    );
  }
  if (kind === 'post') {
    return badRequest(`${SESSION_KIND_LABEL[kind]} sessions are not built yet.`);
  }
  // A follow roll with nothing to join is refused LOUDLY rather than degraded
  // to a browse (inside queueWarmupSession) — a quiet browse would look like a
  // successful session while the account stopped accumulating communities.
  const queued = await queueWarmupSession(accountId, account, {
    kind,
    seed: body.seed,
    day: body.day,
    subreddits: body.subreddits,
    curve: body.curve,
    follow: body.follow,
    createdBy: caller.uid,
    createdByName: caller.profile.displayName,
  });
  if (!queued.ok) return badRequest(queued.error);
  const { session } = queued;

  await writeActivityLog({
    caller,
    action: 'warmup.session_queued',
    targetType: 'account',
    targetId: accountId,
    targetName: (account.label as string) || accountId,
    metadata: {
      kind: session.kind,
      day: session.day,
      steps: session.plan.length,
      upvoteBudget: session.upvoteBudget,
      joins: session.joinsPlanned.join(', '),
    },
  });

  await wakeAgent('warm-up queued');

  return NextResponse.json({ jobId: queued.jobId, session }, { status: 201 });
});
