import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { listQuestions } from '@/server/interview';
import { listAssets } from '@/server/knowledge';
import { approveMany } from '@/server/approveAnswer';

// POST /api/projects/:projectId/knowledge/interview/approve
//
// Approve a set of researched or imported answers in one action.
//
// ════════════════════════════════════════════════════════════════════════════
// THE CALLER NAMES THE QUESTIONS. THERE IS NO "APPROVE EVERYTHING" FLAG.
//
// A bulk write into the library is exactly the action that should not be
// available as one word. The browser sends the ids it is SHOWING — the queue the
// operator is looking at, after their own filters — so what gets approved is
// what they can see. A server-side "all pending" switch would approve rows that
// scrolled off, rows added by a run finishing in another tab, and rows a filter
// was deliberately hiding.
//
// Everything a `pending` question is not — already approved, rejected, or with
// no answer at all — is skipped and counted rather than refused, so one stale id
// in a list of eighty does not fail the batch.
// ════════════════════════════════════════════════════════════════════════════

// Eighty answers, each a Firestore write plus its claims, sequentially so the
// duplicate check can see what the previous one created.
export const maxDuration = 300;

/** One request should not be able to rewrite an entire library. */
const MAX_PER_CALL = 200;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  questionIds?: unknown;
  /** Fold answers that cite a page the library already covers into that asset,
   *  rather than creating a near-duplicate. Default on. */
  dedupe?: boolean;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const ids = Array.isArray(body.questionIds)
    ? body.questionIds.filter((v): v is string => typeof v === 'string')
    : [];

  if (ids.length === 0) return badRequest('Name the questions to approve.');
  if (ids.length > MAX_PER_CALL) {
    return badRequest(`That is ${ids.length} questions. Approve at most ${MAX_PER_CALL} at a time.`);
  }

  const all = await listQuestions(projectId);

  // Order by the ids as sent, so the queue's own order decides which answer
  // creates an asset and which folds into it. That is the operator's ordering,
  // by priority, and it puts the important answer first.
  const byId = new Map(all.map((q) => [q.questionId, q]));
  const questions = ids.map((id) => byId.get(id)).filter((q) => q !== undefined);

  const alreadyDone = questions.filter((q) => q.review === 'approved').length;
  const pending = questions.filter((q) => q.review !== 'approved');

  const assets = await listAssets(projectId);
  const index = assets
    // A retired asset is out of use; folding a fresh answer into one would put
    // the answer somewhere retrieval will not look.
    .filter((a) => a.status !== 'retired')
    .map((a) => ({ assetId: a.assetId, title: a.title, sourceUrl: a.sourceUrl, triggers: a.triggers }));

  const result = await approveMany(
    projectId,
    pending,
    index,
    { uid: caller.uid, name: caller.profile.displayName },
    { dedupe: body.dedupe !== false },
  );

  return NextResponse.json({
    requested: ids.length,
    notFound: ids.length - questions.length,
    alreadyApproved: alreadyDone,
    created: result.created,
    merged: result.merged,
    skipped: result.skipped,
    // Only the ones that did nothing, and why. Eighty successes need no list.
    skippedReasons: result.outcomes
      .filter((o) => o.action === 'skipped')
      .slice(0, 20)
      .map((o) => ({ questionId: o.questionId, reason: o.reason })),
  });
});
