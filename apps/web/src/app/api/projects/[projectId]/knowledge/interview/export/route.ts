import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { addQuestions, getInterview, listQuestions, setInterviewCounts } from '@/server/interview';
import { loadLibrary } from '@/server/knowledge';
import { questionKey } from '@/modules/knowledge/importAnswers';

// GET  — export the client's structured knowledge as JSON
// POST — import a previously exported questionnaire
//
// ════════════════════════════════════════════════════════════════════════════
// EXPORT CARRIES EVIDENCE; IMPORT CARRIES ONLY QUESTIONS
//
// The export is everything: the interview, every question and answer, and the
// asset library with its claims and their quotes. It is what you hand to a
// client, or keep when a project is archived.
//
// The import deliberately restores only the QUESTIONS. Importing answers would
// put facts into the ledger whose quotes were never checked against a page this
// server read — the file could say anything, and a claim that arrived by file
// would be indistinguishable from one that was verified. So an imported
// questionnaire arrives unanswered and is researched here, against the real
// site, like any other.
// ════════════════════════════════════════════════════════════════════════════

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const [interview, questions, library] = await Promise.all([
    getInterview(projectId),
    listQuestions(projectId),
    loadLibrary(projectId),
  ]);

  return NextResponse.json({
    format: 'motherlink-engage/client-knowledge',
    version: 1,
    exportedAt: new Date().toISOString(),
    interview,
    questions,
    assets: library.assets,
    claims: library.claims,
  });
});

interface ImportBody {
  questions?: { category?: string; question?: string; rationale?: string; priority?: number }[];
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<ImportBody>(req);
  const incoming = Array.isArray(body.questions) ? body.questions : [];
  if (incoming.length === 0) return badRequest('That file has no questions in it.');

  const existing = await listQuestions(projectId);
  // The match key is shared with the answered-knowledge importer rather than
  // copied. Two importers disagreeing about whether a question is already
  // present would show one of them a duplicate the other cannot see.
  const asked = new Set(existing.map((q) => questionKey(q.question)));

  const fresh = incoming
    .map((q) => ({
      category: (q.category ?? 'Imported').trim() || 'Imported',
      question: (q.question ?? '').trim(),
      rationale: (q.rationale ?? '').trim().slice(0, 300),
      priority: Math.max(1, Math.min(5, Math.round(q.priority ?? 3))),
    }))
    .filter((q) => q.question.length > 5 && !asked.has(questionKey(q.question)))
    .slice(0, 300);

  const added = await addQuestions(projectId, fresh, 'operator');
  const all = await listQuestions(projectId);
  await setInterviewCounts(projectId, all.length);

  return NextResponse.json({
    added,
    skipped: incoming.length - added,
    total: all.length,
    note: 'Imported questions arrive unanswered — they are researched here, against the live site.',
  });
});
