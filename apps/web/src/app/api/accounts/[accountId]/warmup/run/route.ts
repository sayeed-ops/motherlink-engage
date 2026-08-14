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
  warmupBoldnessDay,
  SESSION_KIND_LABEL,
  type WarmupSessionKind,
} from '@/modules/reddit/warmupWalk';
import {
  communitiesForRole,
  keywordsByCommunity,
  normalizeCommunityList,
  normalizeKeywordList,
  normalizeSubredditList,
} from '@/modules/reddit/subreddits';

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
    const j = inFlight.docs[0].data() as { kind?: string; status?: string; claimedAt?: { toMillis?: () => number } };
    if (j.kind !== 'warmup') {
      return badRequest('This account has a reply queued — let that finish first.');
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

  // TWO CLOCKS. Age is the calendar — how old the account looks, which does not
  // pause when the Mac is off. Experience is sessions actually completed.
  // Boldness takes the lower: it can never act older than it is, and never more
  // experienced than it earned. Age alone handed a week-idle account day-8
  // confidence having run three sessions.
  const startedAt = account.warmupStartedAt as { toMillis?: () => number } | undefined;
  const startedAtMs = startedAt?.toMillis?.() ?? 0;
  const ageDay = warmupDayFor(startedAtMs, Date.now());
  const sessionsCompleted = Number(account.warmupSessionsCompleted) || 0;
  const derivedDay = warmupBoldnessDay(ageDay, sessionsCompleted);
  const day = Math.max(1, Math.min(60, Math.round(Number(body.day)) || derivedDay));

  // The browse-tagged rows of the account's community list are the walk's
  // vocabulary. `warmupSubreddits` is kept in sync by saveWarmupCommunities and
  // read as the fallback, so an account saved before the tagged list existed
  // still composes exactly as it did.
  const communities = normalizeCommunityList(account.warmupCommunities);
  const tagged = communitiesForRole(communities, 'browse');
  const subreddits = Array.isArray(body.subreddits)
    ? normalizeSubredditList(body.subreddits)
    : tagged.length
      ? tagged
      : normalizeSubredditList(account.warmupSubreddits);

  // Follow-tagged communities MINUS the ones already followed. The run-time
  // button check is the actual guarantee against unfollowing — this only stops
  // the composer wasting a discovery leg on a community it would then skip.
  // Deliberately NOT fail-closed: an account with no capture yet would otherwise
  // never join anything, and the primitive refuses to click on an unreadable
  // button anyway.
  const followed = new Set(normalizeSubredditList(account.followedSubreddits));
  const joinTargets = communitiesForRole(communities, 'follow').filter((s) => !followed.has(s));
  const keywords = normalizeKeywordList(account.warmupKeywords);

  const composed = {
    ...(account.warmupPolicy as object | undefined),
    ...(body.curve && typeof body.curve === 'object' ? { upvoteCurve: body.curve } : {}),
    ...(body.follow && typeof body.follow === 'object' ? { follow: body.follow } : {}),
    subreddits,
    searchTargets: subreddits,
    joinTargets,
    keywords,
    keywordsByCommunity: keywordsByCommunity(communities),
  };
  // If normalisation rejects the input the policy was unusable, so the fallback
  // keeps only the SERVER-DERIVED lists and drops every client-supplied override
  // — reusing the parts of a rejected policy would be trusting exactly what was
  // just refused.
  const policy = normalizeWarmupPolicy(composed) ?? {
    ...DEFAULT_POLICY,
    subreddits,
    searchTargets: subreddits,
    joinTargets,
    keywords,
    keywordsByCommunity: keywordsByCommunity(communities),
  };

  // Same seed + same policy => byte-identical plan, so the operator runs the
  // session they looked at. Omitted (e.g. a future scheduler) => a fresh roll.
  // Defaults to `browse` — the kind that can do the least — so a caller that
  // omits it can never accidentally queue a session that joins.
  const kind: WarmupSessionKind =
    body.kind === 'follow' || body.kind === 'comment' || body.kind === 'post' ? body.kind : 'browse';

  if (kind === 'comment' || kind === 'post') {
    return badRequest(`${SESSION_KIND_LABEL[kind]} sessions are not built yet.`);
  }
  // Refuse LOUDLY rather than degrading to a browse. A follow roll that quietly
  // ran as a browse would look like a successful session in every record, and
  // the operator would keep believing the account was still accumulating
  // communities long after the list ran dry.
  if (kind === 'follow' && !joinTargets.length) {
    const total = communitiesForRole(communities, 'follow').length;
    return badRequest(
      total === 0
        ? 'Nothing to join — no community on this account is tagged Follow. Tag some on the Communities tab.'
        : `Nothing left to join — the account already follows all ${total} community/communities tagged Follow. Add more, or sync from a project.`,
    );
  }

  const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) >>> 0 : undefined;
  const session = composeWarmupSession({ day, policy, seed, kind });
  if (!session.plan.length) return badRequest('The composer produced an empty session — check the policy.');
  if (session.blocked) return badRequest(`This session cannot run: ${session.blocked}.`);
  // A follow roll that composed no join at all is a defect, not a browse.
  if (kind === 'follow' && !session.joinsPlanned.length) {
    return badRequest('The composer could not reach any community to join — check the community list and keywords.');
  }

  const ref = adminDb().collection('jobs').doc();
  await ref.set({
    jobId: ref.id,
    kind: 'warmup',
    accountId,
    adsPowerProfileId: profileId,
    expectedUsername: (account.username as string) || '',
    warmupPlan: session.plan,
    warmupDay: session.day,
    // WHICH kind of roll this was. Without it the history cannot answer "how
    // many follow sessions has this account actually run", which is the
    // question the package designer will need.
    warmupKind: session.kind,
    // Both clocks, frozen on the job. `warmupDay` is the boldness the session
    // actually ran at; without these two you cannot tell afterwards whether a
    // cautious session was a young account or an idle one.
    warmupAgeDay: ageDay,
    warmupSessionsCompleted: sessionsCompleted,
    warmupUpvoteChance: session.upvoteChance,
    warmupUpvoteBudget: session.upvoteBudget,
    warmupStoppedBy: session.stoppedBy,
    warmupSeed: session.seed,
    // What the session INTENDS to join. The confirmed list is written back by the
    // agent from the button state, never from this.
    warmupJoinTargets: session.joinsPlanned,
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
    metadata: {
      kind: session.kind,
      day: session.day,
      steps: session.plan.length,
      upvoteBudget: session.upvoteBudget,
      joins: session.joinsPlanned.join(', '),
    },
  });

  return NextResponse.json({ jobId: ref.id, session }, { status: 201 });
});
