import { NextResponse } from 'next/server';
import { withAuth } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { addQuestions, corpusFromDiscoveries, getInterview, listQuestions, setInterviewCounts } from '@/server/interview';
import { buildGapPrompt, parseGapQuestions } from '@/modules/knowledge/interviewPrompts';

// POST /api/projects/:projectId/knowledge/interview/gap
//
// The second pass: what did we find that nobody thought to ask about?
//
// ════════════════════════════════════════════════════════════════════════════
// THE HUNDRED QUESTIONS ARE A FLOOR, NOT A CEILING
//
// The questionnaire is written before anyone has looked at the site, so it can
// only cover what was expected of a company of this kind. The most valuable
// thing a client has is regularly the thing nobody knew existed — a tool, a
// published dataset, a documented behaviour that has no equivalent at their
// competitors and therefore no equivalent in anyone's prior.
//
// This pass looks at the pages discovery actually found, next to the categories
// the questionnaire covered, and asks what fell between them. An empty answer is
// a real and good outcome: it means the questionnaire covered the site.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 120;

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const interview = await getInterview(projectId);
  if (!interview) return NextResponse.json({ error: 'Generate the questionnaire first.' }, { status: 400 });

  const [corpus, questions] = await Promise.all([corpusFromDiscoveries(projectId), listQuestions(projectId)]);
  if (corpus.length === 0) {
    return NextResponse.json(
      { error: 'Run Discover pages first — there is nothing to compare the questionnaire against.' },
      { status: 400 },
    );
  }

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }

  const { system, user } = buildGapPrompt({
    clientName: interview.clientName,
    categories: interview.categories,
    askedSamples: questions.map((q) => q.question),
    pages: corpus,
  });

  let found;
  try {
    const result = await callModel(model, { system, user, temperature: 0.3, maxTokens: 3000, json: true });
    found = parseGapQuestions(JSON.parse(result.content));
  } catch {
    return NextResponse.json({ error: 'The gap pass did not return usable JSON.' }, { status: 502 });
  }

  // Anything already asked is not a gap, whatever the model thinks.
  const asked = new Set(questions.map((q) => q.question.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()));
  const fresh = found.filter((q) => !asked.has(q.question.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()));

  const added = await addQuestions(projectId, fresh, 'gap');
  const all = await listQuestions(projectId);
  await setInterviewCounts(projectId, all.length);

  return NextResponse.json({
    added,
    total: all.length,
    questions: fresh.map((q) => ({ category: q.category, question: q.question, rationale: q.rationale })),
    note: added === 0 ? 'Nothing new — the questionnaire already covers what was found on the site.' : '',
  });
});
