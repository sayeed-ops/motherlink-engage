import 'server-only';

import { adminDb } from './admin';
import { isPlatformAdmin, projectPermissions, type Caller } from './auth';
import { normalizeApproachPlan, normalizeApproachTrace, normalizeRouteShape } from '@/modules/reddit/approach';
import { normalizeBrowsePlan, normalizeLeadSkip } from '@/modules/reddit/browseLead';
import { normalizeWarmupTrace, type WarmupLoopPlan } from '@/modules/reddit/warmupWalk';
import { normalizeDraft } from '@/modules/forum/reply/drafts';

// Account activity — everything the tool did with the accounts, in one list.
//
// One row per job (browsing session, warm-up comment, project reply, Shopify
// reply) plus the warm-up comment scans that never became a job (nothing found,
// rejected). This is the ONLY history view: the lists that used to be scattered
// across Browsing loop, the account Dashboard and Comment karma were removed in
// its favour (operator, 2026-10-27). What still waits for a person — comments to
// approve — stays on Comment karma; today's plan stays on Autopilot.
//
// Read on the server: jobs carry reply bodies and belong to projects, and the
// rules scope those per project. Owners/admins see everything; anyone else with
// accounts.manage sees warm-up work and replies from projects they belong to.

export type ActivityType = 'browse' | 'follow' | 'warmup-comment' | 'project-comment' | 'shopify-reply';
export type ActivityOrigin = 'autopilot' | 'manual' | 'project';
export type ActivityStatus = 'planned' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'nothing' | 'rejected';

export interface ActivityRow {
  /** "job:<id>" or "scan:<accountId>:<draftId>". */
  key: string;
  accountId: string;
  accountLabel: string;
  type: ActivityType;
  origin: ActivityOrigin;
  projectId: string;
  projectName: string;
  subreddit: string;
  status: ActivityStatus;
  /** Why it failed, was cancelled, or found nothing. */
  reason: string;
  /** When it was planned to run (a scheduled job), else when it was created. */
  atMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  steps: { planned: number; ran: number; failed: number } | null;
  upvotes: number | null;
  /** The posted comment or reply on Reddit / the forum. */
  permalink: string;
  threadUrl: string;
  threadTitle: string;
  /** The comment or reply text, when there is one. */
  text: string;
}

const DAY_MS = 86_400_000;
const MAX_ROWS = 600;

const toMs = (v: unknown): number =>
  typeof v === 'number' ? v : v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

function typeOfJob(j: Record<string, unknown>): ActivityType {
  if (j.kind === 'warmup') return j.warmupKind === 'follow' ? 'follow' : 'browse';
  if (j.kind === 'comment') return 'warmup-comment';
  return j.platform === 'shopify' ? 'shopify-reply' : 'project-comment';
}

function statusOfJob(j: Record<string, unknown>, nowMs: number): ActivityStatus {
  const s = String(j.status ?? '');
  if (s === 'queued') return Number(j.notBeforeMs) > nowMs ? 'planned' : 'queued';
  if (s === 'posting') return 'running';
  if (s === 'posted' || s === 'completed') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  return 'queued';
}

function stepsOf(j: Record<string, unknown>): ActivityRow['steps'] {
  const trace = Array.isArray(j.approachTrace) ? (j.approachTrace as { ok?: boolean }[]) : [];
  const planned = Array.isArray(j.warmupPlan) ? j.warmupPlan.length : Array.isArray(j.approachPlan) ? j.approachPlan.length : 0;
  if (!planned && !trace.length) return null;
  return { planned, ran: trace.length, failed: trace.filter((t) => t?.ok === false).length };
}

export interface ActivityQuery {
  /** One account only (the account Dashboard). */
  accountId?: string;
  /** Rows from this many days back (default 30). */
  days?: number;
  /** For "Load older": rows before this instant. */
  beforeMs?: number;
}

export async function listActivity(caller: Caller, query: ActivityQuery): Promise<{ rows: ActivityRow[]; oldestMs: number; truncated: boolean }> {
  const nowMs = Date.now();
  const untilMs = query.beforeMs ?? nowMs + 2 * DAY_MS; // planned sessions run ahead of now
  const sinceMs = (query.beforeMs ?? nowMs) - Math.max(1, Math.min(365, query.days ?? 30)) * DAY_MS;

  const accountsSnap = query.accountId
    ? [await adminDb().collection('accounts').doc(query.accountId).get()].filter((d) => d.exists)
    : (await adminDb().collection('accounts').get()).docs;
  const labels = new Map(accountsSnap.map((d) => [d.id, String(d.get('label') ?? d.id)]));

  // Jobs. One account: equality only, sorted here (no composite index). All
  // accounts: a range on createdAt, which needs none either.
  const jobDocs = query.accountId
    ? (await adminDb().collection('jobs').where('accountId', '==', query.accountId).get()).docs
    : (await adminDb().collection('jobs').where('createdAt', '>=', new Date(sinceMs)).orderBy('createdAt', 'desc').limit(MAX_ROWS * 2).get()).docs;

  const rows: ActivityRow[] = [];
  const projectIds = new Set<string>();
  for (const d of jobDocs) {
    const j = d.data();
    const created = toMs(j.createdAt);
    const at = Number(j.notBeforeMs) > 0 ? Number(j.notBeforeMs) : created;
    if (at < sinceMs || at > untilMs) continue;
    const accountId = String(j.accountId ?? '');
    const type = typeOfJob(j);
    const projectId = String(j.projectId ?? '');
    if (projectId) projectIds.add(projectId);
    rows.push({
      key: `job:${d.id}`,
      accountId,
      accountLabel: labels.get(accountId) ?? accountId,
      type,
      origin: j.autopilot === true ? 'autopilot' : type === 'project-comment' || type === 'shopify-reply' ? 'project' : 'manual',
      projectId,
      projectName: '',
      subreddit: String(j.subreddit ?? ''),
      status: statusOfJob(j, nowMs),
      reason: String(j.error ?? '').slice(0, 300),
      atMs: at,
      startedAtMs: toMs(j.claimedAt),
      finishedAtMs: toMs(j.completedAt),
      steps: stepsOf(j),
      upvotes: Array.isArray(j.approachTrace) ? (j.approachTrace as { upvoted?: boolean }[]).filter((t) => t?.upvoted === true).length : null,
      permalink: String(j.permalink ?? ''),
      threadUrl: String(j.threadUrl ?? ''),
      threadTitle: String(j.postTitle ?? ''),
      text: type === 'browse' || type === 'follow' ? '' : String(j.body ?? ''),
    });
  }

  // Warm-up comment scans that never became a job — the job row stands for the
  // ones that did. Pending ones still wait for a person on Comment karma.
  for (const acc of accountsSnap) {
    const drafts = await acc.ref.collection('commentDrafts').where('createdAtMs', '>=', sinceMs).get();
    for (const d of drafts.docs) {
      const r = normalizeDraft(d.id, d.data());
      if (!r || r.createdAtMs > untilMs) continue;
      if (r.status !== 'skipped' && r.status !== 'rejected') continue;
      const autopilot = r.reviewedBy === 'autopilot' || (r.trace ?? []).some((t) => String(t).startsWith('autopilot'));
      rows.push({
        key: `scan:${acc.id}:${d.id}`,
        accountId: acc.id,
        accountLabel: labels.get(acc.id) ?? acc.id,
        type: 'warmup-comment',
        origin: autopilot ? 'autopilot' : 'manual',
        projectId: '',
        projectName: '',
        subreddit: r.thread?.subreddit ?? '',
        status: r.status === 'rejected' ? 'rejected' : 'nothing',
        reason: (r.status === 'rejected' ? r.reviewNote || 'Rejected on review.' : r.skipReason) ?? '',
        atMs: r.createdAtMs,
        startedAtMs: 0,
        finishedAtMs: 0,
        steps: null,
        upvotes: null,
        permalink: '',
        threadUrl: r.thread?.threadUrl ?? '',
        threadTitle: r.thread?.title ?? '',
        text: r.text ?? '',
      });
    }
  }

  // Project replies: only for people in that project (owners/admins see all).
  const allowed = new Map<string, boolean>();
  const names = new Map<string, string>();
  for (const pid of projectIds) {
    allowed.set(pid, isPlatformAdmin(caller) || !!(await projectPermissions(caller, pid)));
    if (allowed.get(pid)) names.set(pid, String((await adminDb().collection('projects').doc(pid).get()).get('name') ?? pid));
  }
  const visible = rows
    .filter((r) => !r.projectId || allowed.get(r.projectId))
    .map((r) => (r.projectId ? { ...r, projectName: names.get(r.projectId) ?? r.projectId } : r))
    .sort((a, b) => b.atMs - a.atMs);
  const truncated = visible.length > MAX_ROWS;
  const page = visible.slice(0, MAX_ROWS);
  return { rows: page, oldestMs: page.length ? page[page.length - 1].atMs : sinceMs, truncated };
}

// ---- One row's detail, fetched when it is opened ----

export async function activityDetail(caller: Caller, key: string): Promise<Record<string, unknown> | null> {
  if (key.startsWith('job:')) {
    const snap = await adminDb().collection('jobs').doc(key.slice(4)).get();
    if (!snap.exists) return null;
    const j = snap.data() as Record<string, unknown>;
    if (j.projectId && !isPlatformAdmin(caller) && !(await projectPermissions(caller, String(j.projectId)))) return null;
    if (j.kind === 'warmup') {
      return {
        kind: 'warmup',
        plan: (Array.isArray(j.warmupPlan) ? j.warmupPlan : []) as WarmupLoopPlan,
        trace: normalizeWarmupTrace(j.approachTrace),
        day: Number(j.warmupDay) || null,
      };
    }
    return {
      kind: 'approach',
      approachPlan: normalizeApproachPlan(j.approachPlan),
      approachTrace: normalizeApproachTrace(j.approachTrace),
      browse: { plan: normalizeBrowsePlan(j.browsePlan), trace: normalizeWarmupTrace(j.browseTrace), skipped: normalizeLeadSkip(j.browseMeta) },
      firstVisit: { plan: normalizeApproachPlan(j.firstVisitPlan), trace: normalizeApproachTrace(j.firstVisitTrace), shape: normalizeRouteShape(j.routeShape) },
    };
  }
  if (key.startsWith('scan:')) {
    const [, accountId, draftId] = key.split(':');
    const snap = await adminDb().collection('accounts').doc(accountId).collection('commentDrafts').doc(draftId).get();
    const r = snap.exists ? normalizeDraft(snap.id, snap.data()) : null;
    if (!r) return null;
    return { kind: 'scan', gap: r.gap, criticReason: r.criticReason, rejected: r.rejected, trace: r.trace };
  }
  return null;
}
