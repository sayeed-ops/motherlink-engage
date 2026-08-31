import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import {
  addQuestions,
  clearGeneratedQuestions,
  getInterview,
  listQuestions,
  saveInterview,
  setInterviewCounts,
} from '@/server/interview';
import { buildQuestionsPrompt, parseQuestions } from '@/modules/knowledge/interviewPrompts';
import { coverage } from '@/modules/knowledge/interview';
import { normaliseDomain } from '@/modules/knowledge/discovery';
import { getRedditConfig } from '@/modules/reddit/store';

// GET  — the interview, its questions and where coverage is thin
// POST — generate (or regenerate) the questionnaire
//
// ════════════════════════════════════════════════════════════════════════════
// GENERATION IS NOT RESEARCH
//
// This route produces QUESTIONS. It reads no pages, makes no claims and writes
// nothing to the asset library. A generated questionnaire is a list of things
// nobody has looked up yet, and every one of them is equally likely to come back
// NOT FOUND.
//
// Keeping the two apart is what makes the not-found answers meaningful: the
// questions were written before anyone knew what the site contained, so an
// unanswered one is evidence about the client rather than a gap in our
// imagination.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  clientName?: string;
  domains?: string[];
  industry?: string;
  count?: number;
  /** Regenerate only these categories, leaving the rest of the questionnaire. */
  onlyCategories?: string[];
  /** Remove the previously generated questions first. Operator-written, gap and
   *  opportunity questions are never touched. */
  replace?: boolean;
}

/** A hundred questions does not fit in one completion at a usable quality, so
 *  they are generated in passes and de-duplicated against what already exists. */
const PER_PASS = 35;

export const GET = withAuth<Ctx>(async (_req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const [interview, questions] = await Promise.all([getInterview(projectId), listQuestions(projectId)]);

  return NextResponse.json({
    interview,
    questions,
    coverage: coverage(questions),
    counts: {
      total: questions.length,
      pending: questions.filter((q) => q.status === 'pending').length,
      answered: questions.filter((q) => q.status === 'answered').length,
      notFound: questions.filter((q) => q.status === 'not-found').length,
      awaitingReview: questions.filter((q) => q.review === 'pending').length,
      approved: questions.filter((q) => q.review === 'approved').length,
    },
  });
});

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const body = await jsonBody<Body>(req);
  const existing = await getInterview(projectId);

  const clientName = (body.clientName ?? existing?.clientName ?? '').trim();
  const industry = (body.industry ?? existing?.industry ?? '').trim();
  const domains = (Array.isArray(body.domains) ? body.domains : (existing?.domains ?? []))
    .map((d) => normaliseDomain(String(d)))
    .filter(Boolean);

  if (!clientName) return badRequest('The client needs a name.');
  if (!industry) {
    return badRequest(
      'Describe what this client does, in a sentence. The questionnaire is built from it, which is what keeps this from being betting-specific.',
    );
  }

  const target = Math.max(20, Math.min(150, body.count ?? 100));

  let model;
  try {
    const config = await getRedditConfig(projectId);
    model = await resolveModelForRun(runActor(caller), projectId, config?.analysisModel ?? null, {
      requireJson: true,
    });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  if (body.replace) await clearGeneratedQuestions(projectId);

  const priorQuestions = await listQuestions(projectId);
  const asked = priorQuestions.map((q) => q.question);
  const categories = new Set<string>(body.onlyCategories?.length ? body.onlyCategories : []);

  let added = 0;
  const notes: string[] = [];

  while (added < target) {
    const want = Math.min(PER_PASS, target - added);
    const { system, user } = buildQuestionsPrompt({
      clientName,
      industry,
      domains,
      count: want,
      onlyCategories: body.onlyCategories?.length ? body.onlyCategories : undefined,
      existing: asked,
    });

    let parsed;
    try {
      const result = await callModel(model, { system, user, temperature: 0.4, maxTokens: 4000, json: true });
      parsed = parseQuestions(JSON.parse(result.content));
    } catch {
      notes.push('One generation pass failed; the questionnaire is shorter than asked for.');
      break;
    }

    // Filter against what we already have as well as what this pass produced —
    // the model is told what has been asked, and it repeats itself anyway.
    const seen = new Set(asked.map(normalise));
    const fresh = parsed.questions.filter((q) => {
      const key = normalise(q.question);
      if (seen.has(key)) return false;
      seen.add(key);
      asked.push(q.question);
      return true;
    });

    for (const c of parsed.categories) categories.add(c);
    for (const q of fresh) categories.add(q.category);

    if (fresh.length === 0) {
      // Nothing new twice in a row means the model has run out of distinct
      // questions for this client. Stopping is the right answer; looping would
      // spend money to produce rephrasings.
      notes.push('The model stopped producing new questions before reaching the target.');
      break;
    }

    added += await addQuestions(projectId, fresh, 'generated');
  }

  await saveInterview(projectId, { clientName, domains, industry, categories: [...categories] }, {
    uid: caller.uid,
    name: caller.profile.displayName,
  });

  const all = await listQuestions(projectId);
  await setInterviewCounts(projectId, all.length, [...categories]);

  return NextResponse.json({
    added,
    total: all.length,
    categories: [...categories],
    notes,
  });
});

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
