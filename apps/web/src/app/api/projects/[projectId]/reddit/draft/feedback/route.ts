import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { adminDb } from '@/server/admin';
import { getDraft, updateDraftBody, setDraftStatus, createDraftFeedback } from '@/modules/reddit/store';
import { DRAFT_REASON_TAGS, type DraftReasonTag } from '@/modules/reddit/types';

// POST /api/projects/:projectId/reddit/draft/feedback
//
// One endpoint for the two feedback events that train the model:
//   kind 'edit'   — save an edited draft body.
//   kind 'reject' — reject the draft (with a reason).
//
// Anyone with drafts.generate may edit or reject (they already own the queue).
// The TRAINING capture is narrower: a feedback record is written ONLY when the
// caller also holds drafts.train, gave a reason, and did not flag the edit as
// minor. That is the "don't let random employees train the model" gate — the
// edit still lands for everyone; only trusted writers' rationale enters the
// dataset. requireProjectPermission returns the caller's held permissions, so
// the train check costs no extra read.

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  draftId?: string;
  kind?: 'edit' | 'reject';
  body?: string;
  reasonTags?: string[];
  reasonText?: string;
  minor?: boolean;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  const held = await requireProjectPermission(caller, projectId, 'drafts.generate');
  const canTrain = held.includes('drafts.train');

  const b = await jsonBody<Body>(req);
  if (!b.draftId) return badRequest('A draftId is required.');
  if (b.kind !== 'edit' && b.kind !== 'reject') return badRequest('kind must be "edit" or "reject".');

  const draft = await getDraft(projectId, b.draftId);
  if (!draft) return badRequest('That draft is not in this project.');
  if (draft.status !== 'draft') {
    return badRequest('Only an open draft can be edited or rejected.');
  }

  const prevBody = typeof draft.body === 'string' ? draft.body : '';
  const reasonText = typeof b.reasonText === 'string' ? b.reasonText.trim().slice(0, 2000) : '';
  const reasonTags = Array.isArray(b.reasonTags)
    ? [...new Set(b.reasonTags.filter((t): t is DraftReasonTag => (DRAFT_REASON_TAGS as readonly string[]).includes(t)))]
    : [];

  let editedBody: string | null = null;

  if (b.kind === 'edit') {
    const next = typeof b.body === 'string' ? b.body.trim() : '';
    if (!next) return badRequest('The edited draft cannot be empty.');
    if (next.length > 10000) return badRequest('The draft is too long (10,000 char max).');
    if (next === prevBody && !reasonText && !reasonTags.length) {
      return badRequest('Nothing changed.');
    }
    editedBody = next;
    await updateDraftBody(projectId, b.draftId, next);
  } else {
    await setDraftStatus(projectId, b.draftId, 'rejected', reasonText);
  }

  // Capture the training example — trusted writer, has a reason, not marked minor.
  const hasReason = reasonTags.length > 0 || reasonText.length > 0;
  let feedbackCaptured = false;
  if (canTrain && !b.minor && hasReason) {
    // Best-effort context: the subreddit and the angle the model was given. A
    // failure here must not fail the edit — context is a nice-to-have.
    let subreddit = '';
    let suggestedAngle = '';
    try {
      const pdoc = adminDb().collection('projects').doc(projectId);
      if (typeof draft.itemId === 'string') {
        subreddit = ((await pdoc.collection('items').doc(draft.itemId).get()).data()?.subreddit as string) ?? '';
      }
      if (typeof draft.analysisId === 'string') {
        const an = (await pdoc.collection('analyses').doc(draft.analysisId).get()).data();
        suggestedAngle = (an?.suggestedAngle as string) || (an?.growthAngle as string) || '';
      }
    } catch {
      /* context is optional */
    }

    await createDraftFeedback(projectId, {
      draftId: b.draftId,
      itemId: (draft.itemId as string) ?? '',
      analysisId: (draft.analysisId as string) ?? '',
      kind: b.kind,
      originalBody: prevBody,
      editedBody,
      reasonTags,
      reasonText,
      subreddit,
      suggestedAngle,
      model: (draft.model as string) ?? '',
      promptVersion: (draft.promptVersion as string) ?? '',
      trainingApproved: true,
      createdBy: caller.uid,
      createdByName: caller.profile.displayName,
    });
    feedbackCaptured = true;
  }

  return NextResponse.json({ ok: true, feedbackCaptured });
});
