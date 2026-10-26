import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { joinedCommunities } from '@/modules/reddit/joined';
import {
  composeWarmupSession,
  normalizeWarmupPolicy,
  DEFAULT_POLICY,
  warmupDayFor,
  warmupBoldnessDay,
  type WarmupSessionKind,
} from '@/modules/reddit/warmupWalk';
import {
  communitiesForRole,
  keywordsByCommunity,
  normalizeCommunityList,
  normalizeKeywordList,
  normalizeSubredditList,
} from '@/modules/reddit/subreddits';

// Composing ONE browsing session for an account and queueing it as a job.
//
// Shared by the manual "Run a session" button (warmup/run) and the autopilot,
// so the two can never compose differently. The plan is composed here and
// FROZEN onto the job — the agent re-rolls nothing. See the run route for why a
// previewed seed is honoured, and WARMUP-LOOP.md for the walk itself.
//
// This does NOT touch dailyCap, minIntervalMinutes or postCountToday: those
// count submitted comments, and a browse posts nothing.

const MAX_REROLLS = 30;

export interface SessionRequest {
  kind: WarmupSessionKind;
  /** The previewed seed, or omitted for a fresh roll (the autopilot). */
  seed?: number;
  /** Override the derived warm-up day — testing a later day without waiting. */
  day?: number;
  subreddits?: string[];
  curve?: unknown;
  follow?: unknown;
  /** Not claimable before this instant (the autopilot plans a day ahead). */
  notBeforeMs?: number;
  /** Queued by the autopilot rather than by a person. */
  autopilot?: boolean;
  /** Re-roll (fresh seeds, up to MAX_REROLLS) until the session is estimated at
   *  least this long, keeping the longest if none is. The autopilot's
   *  short-session rule; never used with a previewed seed. */
  minEstimatedSec?: number;
  createdBy: string;
  createdByName: string;
}

export type SessionResult =
  | { ok: true; jobId: string; session: ReturnType<typeof composeWarmupSession> }
  | { ok: false; error: string };

/** Follow-tagged communities the account does not follow yet. */
export function joinTargetsOf(account: Record<string, unknown>): string[] {
  const followed = new Set(joinedCommunities(account));
  return communitiesForRole(normalizeCommunityList(account.warmupCommunities), 'follow').filter((s) => !followed.has(s));
}

export async function queueWarmupSession(
  accountId: string,
  account: Record<string, unknown>,
  req: SessionRequest,
): Promise<SessionResult> {
  const profileId = (account.adsPowerProfileId as string) || '';
  if (!profileId) return { ok: false, error: 'This account has no AdsPower profile id — the agent needs it to open a browser.' };

  // TWO CLOCKS. Age is the calendar; experience is sessions actually completed.
  // Boldness takes the lower. A session planned for later is composed at the
  // boldness of the day it runs on.
  const startedAt = account.warmupStartedAt as { toMillis?: () => number } | undefined;
  const startedAtMs = startedAt?.toMillis?.() ?? 0;
  const atMs = req.notBeforeMs && req.notBeforeMs > Date.now() ? req.notBeforeMs : Date.now();
  const ageDay = warmupDayFor(startedAtMs, atMs);
  const sessionsCompleted = Number(account.warmupSessionsCompleted) || 0;
  const derivedDay = warmupBoldnessDay(ageDay, sessionsCompleted);
  const day = Math.max(1, Math.min(60, Math.round(Number(req.day)) || derivedDay));

  // Browse-tagged communities are the walk's vocabulary; `warmupSubreddits` is
  // the fallback for an account saved before the tagged list existed.
  const communities = normalizeCommunityList(account.warmupCommunities);
  const tagged = communitiesForRole(communities, 'browse');
  const subreddits = Array.isArray(req.subreddits)
    ? normalizeSubredditList(req.subreddits)
    : tagged.length
      ? tagged
      : normalizeSubredditList(account.warmupSubreddits);
  const joinTargets = joinTargetsOf(account);
  const keywords = normalizeKeywordList(account.warmupKeywords);

  const composed = {
    ...(account.warmupPolicy as object | undefined),
    ...(req.curve && typeof req.curve === 'object' ? { upvoteCurve: req.curve } : {}),
    ...(req.follow && typeof req.follow === 'object' ? { follow: req.follow } : {}),
    subreddits,
    searchTargets: subreddits,
    joinTargets,
    keywords,
    keywordsByCommunity: keywordsByCommunity(communities),
  };
  // A rejected policy keeps only the SERVER-DERIVED lists — reusing parts of
  // what was just refused would be trusting it.
  const policy = normalizeWarmupPolicy(composed) ?? {
    ...DEFAULT_POLICY,
    subreddits,
    searchTargets: subreddits,
    joinTargets,
    keywords,
    keywordsByCommunity: keywordsByCommunity(communities),
  };

  if (req.kind === 'follow' && !joinTargets.length) {
    const total = communitiesForRole(communities, 'follow').length;
    return {
      ok: false,
      error:
        total === 0
          ? 'Nothing to join — no community on this account is tagged Follow. Tag some on the Communities tab.'
          : `Nothing left to join — the account already follows all ${total} community/communities tagged Follow. Add more, or sync from a project.`,
    };
  }

  const seed = Number.isFinite(Number(req.seed)) ? Number(req.seed) >>> 0 : undefined;
  let session = composeWarmupSession({ day, policy, seed, kind: req.kind });
  let rerolls = 0;
  if (req.minEstimatedSec && seed === undefined) {
    for (let i = 0; i < MAX_REROLLS && session.estimatedSec < req.minEstimatedSec; i += 1) {
      const next = composeWarmupSession({ day, policy, kind: req.kind });
      rerolls += 1;
      if (next.plan.length && !next.blocked && next.estimatedSec > session.estimatedSec) session = next;
    }
  }
  if (!session.plan.length) return { ok: false, error: 'The composer produced an empty session — check the policy.' };
  if (session.blocked) return { ok: false, error: `This session cannot run: ${session.blocked}.` };
  if (req.kind === 'follow' && !session.joinsPlanned.length) {
    return { ok: false, error: 'The composer could not reach any community to join — check the community list and keywords.' };
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
    warmupKind: session.kind,
    warmupAgeDay: ageDay,
    warmupSessionsCompleted: sessionsCompleted,
    warmupUpvoteChance: session.upvoteChance,
    warmupUpvoteBudget: session.upvoteBudget,
    warmupStoppedBy: session.stoppedBy,
    warmupSeed: session.seed,
    // How long the session is expected to run, and how many rolls it took —
    // the autopilot reads the first back to spot a run of short sessions.
    warmupEstimatedSec: session.estimatedSec,
    ...(rerolls ? { warmupRerolls: rerolls } : {}),
    warmupJoinTargets: session.joinsPlanned,
    ...(req.notBeforeMs && req.notBeforeMs > Date.now() ? { notBeforeMs: Math.round(req.notBeforeMs) } : {}),
    ...(req.autopilot ? { autopilot: true } : {}),
    status: 'queued',
    attempts: 0,
    createdBy: req.createdBy,
    createdByName: req.createdByName,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // The warm-up's origin, stamped once — every day is derived from it.
  if (!startedAtMs) {
    await adminDb().collection('accounts').doc(accountId).update({
      warmupStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return { ok: true, jobId: ref.id, session };
}

/**
 * The account's job that stands in the way of queueing something now: one
 * running, or one queued and already due. A session the autopilot planned for
 * later does NOT count — otherwise a 16:00 session would block a 10:00 comment
 * all morning. The agent's claim locks still keep two jobs of one account from
 * ever running together.
 */
export async function blockingJobFor(accountId: string, nowMs = Date.now()): Promise<Record<string, unknown> | null> {
  const snap = await adminDb().collection('jobs').where('accountId', '==', accountId).where('status', 'in', ['queued', 'posting']).limit(20).get();
  for (const d of snap.docs) {
    const j = d.data();
    const nb = Number(j.notBeforeMs);
    if (j.status === 'posting' || !(Number.isFinite(nb) && nb > nowMs)) return j;
  }
  return null;
}

/** The account's most recent warm-up sessions, newest first, as estimated
 *  seconds (null when the job predates the estimate). Cancelled and failed
 *  sessions are left out — they say nothing about what the account did. */
export async function recentSessionLengths(accountId: string, limit: number): Promise<(number | null)[]> {
  if (limit <= 0) return [];
  const snap = await adminDb().collection('jobs').where('accountId', '==', accountId).where('kind', '==', 'warmup').limit(100).get();
  const at = (d: FirebaseFirestore.DocumentData) => Number(d.notBeforeMs) || d.createdAt?.toMillis?.() || 0;
  return snap.docs
    .map((d) => d.data())
    .filter((d) => d.status === 'completed' || d.status === 'queued' || d.status === 'posting')
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit)
    .map((d) => (Number.isFinite(Number(d.warmupEstimatedSec)) && d.warmupEstimatedSec !== undefined ? Number(d.warmupEstimatedSec) : null));
}
