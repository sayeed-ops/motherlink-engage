import { NextResponse } from 'next/server';
import { withAuth, jsonBody } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import {
  corpusFromDiscoveries,
  discoveryFinder,
  getInterview,
  getQuestion,
  listQuestions,
  recordAnswer,
  researchQuestion,
  type ResearchDeps,
} from '@/server/interview';
import { listAssets } from '@/server/knowledge';
import { decideDedupe, nextToResearch } from '@/modules/knowledge/interview';
import type { ResearchSource } from '@/modules/knowledge/interviewPrompts';

// POST /api/projects/:projectId/knowledge/interview/research
//
// Research a BATCH of questions and file the answers for review.
//
// ════════════════════════════════════════════════════════════════════════════
// BATCHED, BECAUSE A HUNDRED QUESTIONS IS NOT ONE REQUEST
//
// Each question reads up to three pages and makes a model call. A hundred of
// those is tens of minutes, which no serverless function survives — so the
// client calls this repeatedly with a small batch and shows progress between
// calls. That is not a workaround for a platform limit; it is what makes the
// progress display possible at all, and it means an interrupted run has already
// banked everything it finished.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface Body {
  /** Research exactly these. Absent means "the next few pending ones". */
  questionIds?: string[];
  /** Only from this category. Ignored when questionIds is given. */
  category?: string;
  limit?: number;
}

/** Questions per call. Three page reads and a completion each, paced by the
 *  fetcher's own timeouts — comfortably inside the duration budget with room
 *  for a slow client site. */
const DEFAULT_BATCH = 5;

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'knowledge.manage');

  const interview = await getInterview(projectId);
  if (!interview) {
    return NextResponse.json({ error: 'Generate the questionnaire first.' }, { status: 400 });
  }

  const body = await jsonBody<Body>(req).catch(() => ({}) as Body);
  const limit = Math.max(1, Math.min(10, body.limit ?? DEFAULT_BATCH));

  // --- pick the batch --------------------------------------------------------
  let batch;
  if (Array.isArray(body.questionIds) && body.questionIds.length > 0) {
    const picked = await Promise.all(body.questionIds.slice(0, limit).map((id) => getQuestion(projectId, id)));
    batch = picked.filter((q): q is NonNullable<typeof q> => !!q);
  } else {
    const all = await listQuestions(projectId);
    const scoped = body.category ? all.filter((q) => q.category === body.category) : all;
    batch = nextToResearch(scoped, limit);
  }

  if (batch.length === 0) {
    return NextResponse.json({ researched: 0, remaining: 0, results: [], done: true });
  }

  // --- the corpus and the model ---------------------------------------------
  const corpus = await corpusFromDiscoveries(projectId);
  if (corpus.length === 0) {
    return NextResponse.json(
      {
        error:
          'There are no discovered pages to research against. Run Discover pages first — research can only read what has been enumerated on the approved domains.',
      },
      { status: 400 },
    );
  }

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  const deps: ResearchDeps = {
    finder: discoveryFinder(corpus),
    ask: async (input) => {
      const result = await callModel(model, input);
      return { content: result.content, model: model.providerModelId };
    },
    // One cache for the whole batch. Five questions about withdrawals hit the
    // same help page, and paying to fetch it five times would be the single
    // most avoidable cost in this feature.
    cache: new Map<string, ResearchSource | null>(),
    nowMs: Date.now(),
  };

  // --- research, and check each answer against what we already know ----------
  const assets = await listAssets(projectId);
  const existing = assets.map((a) => ({
    assetId: a.assetId,
    title: a.title,
    sourceUrl: a.sourceUrl,
    triggers: a.triggers,
  }));

  const results = [];
  for (const question of batch) {
    try {
      const outcome = await researchQuestion(interview.clientName, question, deps);

      // The duplicate check runs BEFORE review, not after. An operator deciding
      // whether to approve needs to know they are looking at a fifth angle on a
      // feature the library already has — otherwise the questionnaire quietly
      // becomes a way to create five assets for one page.
      const dedupe = outcome.answer ? decideDedupe(outcome.answer, existing) : null;

      await recordAnswer(projectId, question.questionId, {
        status: outcome.status,
        review: outcome.status === 'answered' ? 'pending' : 'none',
        answer: outcome.answer,
        dedupe,
        note: outcome.note,
        notFoundReason: outcome.reason,
        sourcesRead: outcome.sourcesRead,
      });

      results.push({
        questionId: question.questionId,
        question: question.question,
        category: question.category,
        status: outcome.status,
        reason: outcome.reason,
        note: outcome.note,
        sourcesRead: outcome.sourcesRead,
        claims: outcome.answer?.claims.length ?? 0,
        rejectedClaims: outcome.rejected,
        dedupe,
      });
    } catch {
      // One question failing must not lose the batch. It stays pending and the
      // next run picks it up.
      results.push({
        questionId: question.questionId,
        question: question.question,
        category: question.category,
        status: 'pending' as const,
        reason: null,
        note: 'This one errored and will be retried.',
        sourcesRead: [],
        claims: 0,
        rejectedClaims: 0,
        dedupe: null,
      });
    }
  }

  const after = await listQuestions(projectId);
  const remaining = after.filter((q) => q.status === 'pending').length;

  // Reported separately from the run onwards. A batch where every question came
  // back "blocked" has measured our access, not the client — and the operator
  // needs to see that in the progress line rather than after scrolling forty
  // identical warnings.
  const blockedNow = results.filter((r) => r.reason === 'blocked').length;

  return NextResponse.json({
    researched: results.length,
    blocked: blockedNow,
    remaining,
    done: remaining === 0,
    totals: {
      blocked: after.filter((q) => q.notFoundReason === 'blocked').length,
      notCovered: after.filter((q) => q.notFoundReason === 'not-covered').length,
      noCandidate: after.filter((q) => q.notFoundReason === 'no-candidate').length,
    },
    results,
  });
});
