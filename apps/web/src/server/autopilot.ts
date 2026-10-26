import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { joinTargetsOf, queueWarmupSession, recentSessionLengths } from './warmupSession';
import { runAutopilotComment } from './autopilotComment';
import { commentPairs } from '@/modules/reddit/commentKarma/pairs';
import { joinedCommunities } from '@/modules/reddit/joined';
import { normalizeCommunityList, normalizeKeywordList } from '@/modules/reddit/subreddits';
import { accountPlatform } from '@/modules/accounts/platform';
import { humanCheckRefusal } from '@/modules/accounts/humanCheck';
import { warmupDayFor } from '@/modules/reddit/warmupWalk';
import {
  dayNeedsPlan,
  isTimezone,
  localDate,
  needsLongerSession,
  normalizeAutopilot,
  planDay,
  type AutopilotSettings,
  type PlannedKind,
} from '@/modules/reddit/autopilot';

// The warm-up autopilot, server side: its settings, the per-account switch, and
// the planning run ("tick").
//
// The tick plans each switched-on account's day once, in the account's own time
// zone, and queues the day's sessions straight away with their start times. The
// agent will not claim a session before it is due, and the 5-minute wake-check
// starts the sleeping server a few minutes ahead of it. So the tick only needs
// to run now and then — it is called from that same wake-check, and on demand.
//
// What it records on the account (`autopilot`), for the Autopilot tab:
//   enabled, timezone, lastPlannedDate, lastPlan {date, stage, skipped,
//   sessions [{atMs, kind, jobId}]}, paused (why it did not plan, or '').

const settingsRef = () => adminDb().collection('agents').doc('autopilot');

export async function getAutopilotSettings(): Promise<AutopilotSettings> {
  const snap = await settingsRef().get();
  return normalizeAutopilot(snap.exists ? snap.data() : {});
}

export async function saveAutopilotSettings(raw: unknown, uid: string, byName: string): Promise<AutopilotSettings> {
  const settings = normalizeAutopilot(raw);
  await settingsRef().set({ ...settings, updatedBy: uid, updatedByName: byName, updatedAt: FieldValue.serverTimestamp() });
  return settings;
}

interface AccountAutopilot {
  enabled?: boolean;
  timezone?: string;
  lastPlannedDate?: string;
}

function readAutopilot(account: Record<string, unknown>): AccountAutopilot {
  const a = account.autopilot;
  return a && typeof a === 'object' ? (a as AccountAutopilot) : {};
}

export function timezoneOf(account: Record<string, unknown>, settings: AutopilotSettings): string {
  const tz = readAutopilot(account).timezone;
  return isTimezone(tz) ? tz : settings.defaultTimezone;
}

/** Why the autopilot will not drive this account, or '' when it may. */
export function pauseReason(account: Record<string, unknown>): string {
  if (accountPlatform(account) !== 'reddit') return 'Warm-up is a Reddit routine.';
  if (!String(account.adsPowerProfileId ?? '').trim()) return 'No AdsPower profile yet.';
  const status = String(account.status ?? '');
  if (status === 'banned' || status === 'flagged') return `The account is ${status}.`;
  const hc = humanCheckRefusal(account);
  if (hc) return 'A "prove you are human" check is waiting to be solved.';
  return '';
}

/** Cancel the autopilot's sessions that have not started yet. */
export async function cancelPlannedSessions(accountId: string): Promise<number> {
  const snap = await adminDb().collection('jobs').where('accountId', '==', accountId).where('status', '==', 'queued').limit(30).get();
  let n = 0;
  for (const d of snap.docs) {
    if (d.get('autopilot') !== true) continue;
    await d.ref.update({
      status: 'cancelled',
      error: 'Autopilot turned off.',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    n += 1;
  }
  return n;
}

export async function setAccountAutopilot(
  accountId: string,
  change: { enabled?: boolean; timezone?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof change.enabled === 'boolean') {
    patch['autopilot.enabled'] = change.enabled;
    if (!change.enabled) {
      await cancelPlannedSessions(accountId);
      // Forget today's plan, so switching back on plans the rest of today again.
      patch['autopilot.lastPlannedDate'] = '';
      patch['autopilot.lastPlan'] = FieldValue.delete();
    }
  }
  if (change.timezone !== undefined) patch['autopilot.timezone'] = change.timezone && isTimezone(change.timezone) ? change.timezone : FieldValue.delete();
  await adminDb().collection('accounts').doc(accountId).update(patch);
}

export interface TickResult {
  accountId: string;
  label: string;
  outcome: 'planned' | 'day-off' | 'not-due' | 'paused' | 'error';
  detail: string;
}

/** Plan one account's day if it is due. `force` plans the rest of today now,
 *  whatever the hour — but still only once per day; `replan` (after the old
 *  plan's sessions were cancelled) plans today again. */
export async function planAccount(
  accountId: string,
  settings: AutopilotSettings,
  opts: { force?: boolean; replan?: boolean; nowMs?: number } = {},
): Promise<TickResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const snap = await adminDb().collection('accounts').doc(accountId).get();
  const account = (snap.data() ?? {}) as Record<string, unknown>;
  const label = String(account.label ?? accountId);
  const ap = readAutopilot(account);
  const ref = snap.ref;

  const paused = pauseReason(account);
  if (paused) {
    await ref.update({ 'autopilot.paused': paused });
    return { accountId, label, outcome: 'paused', detail: paused };
  }
  const timezone = timezoneOf(account, settings);
  if (!opts.replan && ap.lastPlannedDate === localDate(timezone, nowMs)) {
    return { accountId, label, outcome: 'not-due', detail: 'today is already planned' };
  }
  if (!opts.force && !opts.replan && !dayNeedsPlan({ settings, timezone, nowMs, lastPlannedDate: ap.lastPlannedDate ?? '' })) {
    return { accountId, label, outcome: 'not-due', detail: '' };
  }

  // The stage is by calendar day of warm-up; a first-ever plan starts it today.
  const startedAtMs = (account.warmupStartedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? nowMs;
  const plan = planDay({
    settings,
    timezone,
    nowMs,
    warmupDay: warmupDayFor(startedAtMs, nowMs),
    canFollow: joinTargetsOf(account).length > 0,
    canComment: canCommentOn(account),
    random: Math.random,
  });

  // The short-session rule runs through the day in order: what was planned
  // earlier today counts as "the last sessions" for the next one.
  const recent = await recentSessionLengths(accountId, settings.shortStreakMax);
  const sessions: { atMs: number; kind: PlannedKind; jobId: string; estimatedSec?: number; rerolled?: boolean; error?: string }[] = [];
  for (const s of plan.sessions) {
    const longer = needsLongerSession(recent, settings);
    const base = {
      notBeforeMs: s.atMs,
      autopilot: true,
      createdBy: 'autopilot',
      createdByName: 'Autopilot',
      ...(longer ? { minEstimatedSec: settings.shortSessionMinutes * 60 } : {}),
    };
    let queued = await queueWarmupSession(accountId, account, { ...base, kind: s.kind });
    // A joining session that cannot be composed (nothing reachable to join)
    // becomes a plain browse rather than a gap in the day.
    if (!queued.ok && s.kind === 'follow') queued = await queueWarmupSession(accountId, account, { ...base, kind: 'browse' });
    if (queued.ok) recent.unshift(queued.session.estimatedSec);
    sessions.push(
      queued.ok
        ? { atMs: s.atMs, kind: queued.session.kind as PlannedKind, jobId: queued.jobId, estimatedSec: queued.session.estimatedSec, ...(longer ? { rerolled: true } : {}) }
        : { atMs: s.atMs, kind: s.kind, jobId: '', error: queued.error },
    );
    // The first queued session stamps warmupStartedAt; later ones must see it.
    if (queued.ok && !account.warmupStartedAt) account.warmupStartedAt = { toMillis: () => nowMs };
  }

  await ref.update({
    'autopilot.lastPlannedDate': plan.date,
    'autopilot.paused': '',
    'autopilot.lastPlan': {
      date: plan.date,
      timezone,
      stage: plan.stageName,
      stageIndex: plan.stageIndex,
      skipped: plan.skipped,
      sessions,
      comments: plan.comments.map((atMs) => ({ atMs, status: 'planned' })),
      plannedAt: nowMs,
    },
  });
  const failed = sessions.filter((s) => s.error);
  if (plan.skipped) return { accountId, label, outcome: 'day-off', detail: `${plan.stageName}: a day off` };
  return {
    accountId,
    label,
    outcome: failed.length === sessions.length && sessions.length ? 'error' : 'planned',
    detail: `${plan.stageName}: ${sessions.length - failed.length} session(s)${plan.comments.length ? `, ${plan.comments.length} comment(s)` : ''}${failed.length ? `, ${failed.length} refused (${failed[0].error})` : ''}`,
  };
}

/** Has the account joined a community tagged Comment? The scan only looks there. */
function canCommentOn(account: Record<string, unknown>): boolean {
  return commentPairs(normalizeCommunityList(account.warmupCommunities), normalizeKeywordList(account.warmupKeywords), joinedCommunities(account)).length > 0;
}

// ---- Running the day's comment slots ----

export interface CommentSlot {
  atMs: number;
  /** planned → running → queued | nothing | refused | error | cancelled | missed */
  status: string;
  detail?: string;
  draftId?: string;
  jobId?: string;
  startedAt?: number;
}

/** A slot left "running" this long was cut off mid-scan (the function timed out). */
const SLOT_STALE_MS = 10 * 60_000;

async function setSlot(accountId: string, atMs: number, patch: Partial<CommentSlot>, onlyIf?: (c: CommentSlot) => boolean): Promise<boolean> {
  const ref = adminDb().collection('accounts').doc(accountId);
  return adminDb().runTransaction(async (tx) => {
    const comments = ((await tx.get(ref)).get('autopilot.lastPlan.comments') as CommentSlot[] | undefined) ?? [];
    const i = comments.findIndex((c) => c.atMs === atMs);
    if (i < 0 || (onlyIf && !onlyIf(comments[i]))) return false;
    comments[i] = { ...comments[i], ...patch };
    tx.update(ref, { 'autopilot.lastPlan.comments': comments });
    return true;
  });
}

/**
 * Run the comment slots that are due: five threads, a comment written for
 * each, the best one posted with no approval (server/autopilotComment.ts).
 * ONE run per call: a run takes most of a minute and this runs inside the
 * 5-minute check, so the next due slot waits for the next call. Never throws.
 */
export async function runDueComments(settings: AutopilotSettings, nowMs = Date.now()): Promise<TickResult[]> {
  const snap = await adminDb().collection('accounts').where('autopilot.enabled', '==', true).get();
  const results: TickResult[] = [];
  let scanned = false;
  for (const d of snap.docs) {
    const account = d.data() as Record<string, unknown>;
    const label = String(account.label ?? d.id);
    const plan = (account.autopilot as { lastPlan?: { date?: string; timezone?: string; comments?: CommentSlot[] } } | undefined)?.lastPlan;
    const slots = plan?.comments ?? [];
    for (const slot of slots) {
      // A scan cut off by the time limit: record it rather than leave it spinning.
      if (slot.status === 'running' && nowMs - (slot.startedAt ?? 0) > SLOT_STALE_MS) {
        await setSlot(d.id, slot.atMs, { status: 'error', detail: 'The scan was cut off before it finished.' }, (c) => c.status === 'running');
        continue;
      }
      if (slot.status !== 'planned' || slot.atMs > nowMs) continue;
      if (!settings.commentsEnabled) {
        await setSlot(d.id, slot.atMs, { status: 'cancelled', detail: 'Autopilot comments were switched off.' }, (c) => c.status === 'planned');
        continue;
      }
      const tz = plan?.timezone || timezoneOf(account, settings);
      if (plan?.date !== localDate(tz, nowMs)) {
        await setSlot(d.id, slot.atMs, { status: 'missed', detail: 'Its day ended before it could run.' }, (c) => c.status === 'planned');
        continue;
      }
      const paused = pauseReason(account);
      if (paused) {
        await setSlot(d.id, slot.atMs, { status: 'cancelled', detail: paused }, (c) => c.status === 'planned');
        continue;
      }
      if (scanned) continue; // one scan per call
      if (!(await setSlot(d.id, slot.atMs, { status: 'running', startedAt: nowMs }, (c) => c.status === 'planned'))) continue;
      scanned = true;
      try {
        const run = await runAutopilotComment(d.id);
        const took = `${Math.round(run.stats.ms / 1000)}s, ${run.stats.crawlzoReads} reads, ${run.stats.aiCalls} AI calls`;
        const patch: Partial<CommentSlot> = {
          status: run.status,
          detail: `${run.detail} (${took})`,
          ...(run.draftId ? { draftId: run.draftId } : {}),
          ...(run.jobId ? { jobId: run.jobId } : {}),
        };
        await setSlot(d.id, slot.atMs, patch);
        results.push({ accountId: d.id, label, outcome: patch.status === 'queued' ? 'planned' : 'not-due', detail: `comment: ${patch.status}${patch.detail ? ` — ${patch.detail}` : ''}` });
      } catch (e) {
        await setSlot(d.id, slot.atMs, { status: 'error', detail: String((e as Error).message || e).slice(0, 200) });
        results.push({ accountId: d.id, label, outcome: 'error', detail: `comment: ${(e as Error).message}` });
      }
    }
  }
  return results;
}

/** Plan every switched-on account whose day is due. Never throws per account. */
export async function runAutopilotTick(opts: { force?: boolean } = {}): Promise<TickResult[]> {
  const snap = await adminDb().collection('accounts').where('autopilot.enabled', '==', true).get();
  if (snap.empty) return [];
  const settings = await getAutopilotSettings();
  const results: TickResult[] = [];
  for (const d of snap.docs) {
    try {
      results.push(await planAccount(d.id, settings, opts));
    } catch (e) {
      results.push({ accountId: d.id, label: String(d.get('label') ?? d.id), outcome: 'error', detail: (e as Error).message });
    }
  }
  // Then any comment slot that is due (one scan per call — see runDueComments).
  // No wake here: the first session may be hours away. The 5-minute wake-check
  // starts the server a few minutes ahead of each one, and a queued comment
  // wakes it by itself.
  results.push(...(await runDueComments(settings)));
  return results;
}
