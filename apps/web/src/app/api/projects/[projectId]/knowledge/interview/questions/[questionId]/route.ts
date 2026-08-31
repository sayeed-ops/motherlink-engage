import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import {
  deleteQuestion,
  getQuestion,
  setQuestionReview,
  updateAnswerFields,
} from '@/server/interview';
import { approveAnswer } from '@/server/approveAnswer';
import type { ResearchAnswer } from '@/modules/knowledge/interview';

// PATCH  — approve / edit / reject / merge / later on one researched answer
// DELETE — remove a question entirely
//
// ════════════════════════════════════════════════════════════════════════════
// APPROVAL IS THE ONLY DOOR INTO THE LIBRARY
//
// Research produces proposals and nothing else. Nothing it finds is retrievable,
// citable or visible to the reply pipeline until a person presses approve here —
// which is the same rule ingestion follows, for the same reason: a hundred
// automated answers that nobody read would be a knowledge base with the client's
// name on it and nobody's judgement in it.
//
// The claims that come through this door keep the evidence they were researched
// with: every one was quote-checked against a page the server actually read, and
// they land in the ledger with that page as their source and today as their
// verification date.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 60;

type Ctx = { params: Promise<{ projectId: string; questionId: string }> };

type Action = 'approve' | 'reject' | 'later' | 'edit' | 'merge';

interface Body {
  action?: Action;
  /** For `edit`: the fields the operator changed. */
  answer?: Partial<ResearchAnswer>;
  /** For `merge`: which asset to fold this into. Defaults to the dedupe hint. */
  assetId?: string;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, questionId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const action = body.action;
  const actor = { uid: caller.uid, name: caller.profile.displayName };

  const question = await getQuestion(projectId, questionId);
  if (!question) return NextResponse.json({ error: 'No such question.' }, { status: 404 });

  // --- the two that need no answer ------------------------------------------
  if (action === 'reject' || action === 'later') {
    await setQuestionReview(projectId, questionId, action === 'reject' ? 'rejected' : 'later', null, actor);
    return NextResponse.json({ questionId, review: action === 'reject' ? 'rejected' : 'later' });
  }

  if (!question.answer) {
    return badRequest('That question has no researched answer to act on.');
  }

  // --- edit: change the proposal, do not publish it --------------------------
  if (action === 'edit') {
    if (!body.answer) return badRequest('Nothing to change.');

    // Claims are NOT editable here, and that is deliberate. A claim's text is
    // bound to a quote that was verified against a page; letting it be rewritten
    // in a review form would produce an assertion nobody checked, wearing the
    // evidence of one that was. Drop a claim you do not want; do not reword it.
    const { claims: _ignored, ...safe } = body.answer;
    await updateAnswerFields(projectId, questionId, safe);
    return NextResponse.json({ questionId, edited: Object.keys(safe) });
  }

  // --- merge: fold into an existing asset ------------------------------------
  if (action === 'merge') {
    const target = body.assetId ?? question.dedupe?.assetId;
    if (!target) return badRequest('Say which asset to merge into.');

    const outcome = await approveAnswer(projectId, question, actor, target);
    if (outcome.action === 'skipped') {
      return NextResponse.json({ error: outcome.reason }, { status: 404 });
    }

    return NextResponse.json({
      questionId,
      review: 'approved',
      assetId: outcome.assetId,
      merged: outcome.action === 'merged' ? outcome.claims : 0,
    });
  }

  // --- approve: a new asset --------------------------------------------------
  //
  // Everything about what an approved answer BECOMES lives in
  // server/approveAnswer.ts, shared with the bulk route. Two approval paths that
  // each build their own asset drift, and the field they drift on is
  // `textSource` — the one that says whether this server ever read the page.
  if (action === 'approve') {
    const outcome = await approveAnswer(projectId, question, actor, null);
    if (outcome.action === 'skipped') return badRequest(outcome.reason);

    return NextResponse.json({
      questionId,
      review: 'approved',
      assetId: outcome.assetId,
      claims: outcome.claims,
    });
  }

  return badRequest('Action must be approve, edit, reject, merge or later.');
});

export const DELETE = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId, questionId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  await deleteQuestion(projectId, questionId);
  return NextResponse.json({ questionId, deleted: true });
});
