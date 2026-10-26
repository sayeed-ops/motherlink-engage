import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { joinTargetsOf, queueWarmupSession } from './warmupSession';
import { accountPlatform } from '@/modules/accounts/platform';
import { humanCheckRefusal } from '@/modules/accounts/humanCheck';
import { warmupDayFor } from '@/modules/reddit/warmupWalk';
import {
  dayNeedsPlan,
  isTimezone,
  localDate,
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
    random: Math.random,
  });

  const sessions: { atMs: number; kind: PlannedKind; jobId: string; error?: string }[] = [];
  for (const s of plan.sessions) {
    let queued = await queueWarmupSession(accountId, account, {
      kind: s.kind,
      notBeforeMs: s.atMs,
      autopilot: true,
      createdBy: 'autopilot',
      createdByName: 'Autopilot',
    });
    // A joining session that cannot be composed (nothing reachable to join)
    // becomes a plain browse rather than a gap in the day.
    if (!queued.ok && s.kind === 'follow') {
      queued = await queueWarmupSession(accountId, account, { kind: 'browse', notBeforeMs: s.atMs, autopilot: true, createdBy: 'autopilot', createdByName: 'Autopilot' });
    }
    sessions.push(queued.ok ? { atMs: s.atMs, kind: queued.session.kind as PlannedKind, jobId: queued.jobId } : { atMs: s.atMs, kind: s.kind, jobId: '', error: queued.error });
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
      plannedAt: nowMs,
    },
  });
  const failed = sessions.filter((s) => s.error);
  if (plan.skipped) return { accountId, label, outcome: 'day-off', detail: `${plan.stageName}: a day off` };
  return {
    accountId,
    label,
    outcome: failed.length === sessions.length && sessions.length ? 'error' : 'planned',
    detail: `${plan.stageName}: ${sessions.length - failed.length} session(s)${failed.length ? `, ${failed.length} refused (${failed[0].error})` : ''}`,
  };
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
  // No wake here: the first session may be hours away. The 5-minute wake-check
  // starts the server a few minutes ahead of each one.
  return results;
}
