import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { addQuestions, listQuestions, setInterviewCounts } from '@/server/interview';

// POST — add questions by hand, or ask for one because a live thread needed it.
//
// TWO ORIGINS, ONE ROUTE. An operator typing a question and the opportunity
// system asking for one are the same act — putting a research task in the queue
// — and they should not diverge into two code paths that drift. The `origin`
// field is what distinguishes them afterwards, and `provokedBy` records which
// thread asked, so a question raised by a real conversation can be traced back
// to it once it is answered.

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  questions?: { category?: string; question?: string; rationale?: string; priority?: number }[];
  /** 'operator' (default) or 'opportunity'. */
  origin?: string;
  /** The thread that could not be matched, for an opportunity-raised question. */
  provokedBy?: string;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const incoming = Array.isArray(body.questions) ? body.questions : [];

  const questions = incoming
    .map((q) => ({
      category: (q.category ?? 'Operator').trim() || 'Operator',
      question: (q.question ?? '').trim(),
      rationale: (q.rationale ?? '').trim().slice(0, 300),
      priority: Math.max(1, Math.min(5, Math.round(q.priority ?? 4))),
    }))
    .filter((q) => q.question.length > 5)
    .slice(0, 50);

  if (questions.length === 0) return badRequest('No usable questions were given.');

  const origin = body.origin === 'opportunity' ? 'opportunity' : 'operator';
  const added = await addQuestions(projectId, questions, origin, body.provokedBy?.trim() || null);

  const all = await listQuestions(projectId);
  await setInterviewCounts(projectId, all.length);

  return NextResponse.json({ added, total: all.length }, { status: 201 });
});
