import 'server-only';

import { adminDb } from './admin';
import {
  normalizeApproachPlan,
  normalizeApproachTrace,
  normalizeRouteShape,
  type ApproachPlan,
  type ApproachTrace,
  type RouteShape,
} from '@/modules/reddit/approach';
import { normalizeBrowsePlan, normalizeLeadSkip, type LeadSkip } from '@/modules/reddit/browseLead';
import { normalizeWarmupTrace, type WarmupLoopPlan, type WarmupTrace } from '@/modules/reddit/warmupWalk';

// The route each queued comment takes — the job behind a comment karma record.
//
// Read on the server because the panel cannot read it itself: a karma job
// belongs to an account, not a project, and the jobs rule lets a browser read
// a job only through its project. Same shape the reply page and the account
// Dashboard hand to ApproachPlanView, so the plan reads the same everywhere.

export interface CommentJobView {
  jobId: string;
  status: string;
  error: string;
  approachPlan: ApproachPlan;
  approachTrace: ApproachTrace;
  browse: { plan: WarmupLoopPlan; trace: WarmupTrace; skipped: LeadSkip };
  firstVisit: { plan: ApproachPlan; trace: ApproachTrace; shape: RouteShape };
}

const ms = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

/** The latest job for each comment draft on this account, keyed by draft id. */
export async function commentJobsForAccount(accountId: string): Promise<Record<string, CommentJobView>> {
  // Two equalities, no ordering: needs no composite index. Newest per draft is
  // picked in memory.
  const snap = await adminDb().collection('jobs').where('accountId', '==', accountId).where('kind', '==', 'comment').get();
  const latest = new Map<string, { at: number; data: Record<string, unknown>; id: string }>();
  for (const doc of snap.docs) {
    const data = doc.data();
    const draftId = typeof data.commentDraftId === 'string' ? data.commentDraftId : '';
    if (!draftId) continue;
    const at = ms(data.createdAt);
    const prev = latest.get(draftId);
    if (!prev || at > prev.at) latest.set(draftId, { at, data, id: doc.id });
  }

  const out: Record<string, CommentJobView> = {};
  for (const [draftId, { data: j, id }] of latest) {
    out[draftId] = {
      jobId: id,
      status: typeof j.status === 'string' ? j.status : '',
      error: typeof j.error === 'string' ? j.error : '',
      approachPlan: normalizeApproachPlan(j.approachPlan),
      approachTrace: normalizeApproachTrace(j.approachTrace),
      browse: {
        plan: normalizeBrowsePlan(j.browsePlan),
        trace: normalizeWarmupTrace(j.browseTrace),
        skipped: normalizeLeadSkip(j.browseMeta),
      },
      firstVisit: {
        plan: normalizeApproachPlan(j.firstVisitPlan),
        trace: normalizeApproachTrace(j.firstVisitTrace),
        shape: normalizeRouteShape(j.routeShape),
      },
    };
  }
  return out;
}
