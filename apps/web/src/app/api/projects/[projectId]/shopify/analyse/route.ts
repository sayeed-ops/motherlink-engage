import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { getShopifyConfig, listTopics } from '@/server/shopify';
import { assessTopic, getAssessment, isUnreadable, listAssessments, saveAssessment } from '@/server/shopifyAnalysis';
import { listShopifySources } from '@/server/shopifyKnowledge';
import { ShopifyReadError } from '@/modules/shopify/reader';
import { toPromptSource } from '@/modules/shopify/knowledge';
import { ASSESS_PROMPT_VERSION } from '@/modules/shopify/assess';

// POST /api/projects/:projectId/shopify/analyse — score the picked questions
// GET  /api/projects/:projectId/shopify/analyse — the analyses back
//
// ════════════════════════════════════════════════════════════════════════════
// THE QUESTION ONLY, AND ONLY WHAT A PERSON PICKED
//
// `items.analyze` — the model-spend tier — one call per topic, on the model
// chosen in this module's settings (`analysisModel`), never a hardcoded one.
// There is no selection heuristic: it analyses the topics marked `selected`,
// or exactly the ids sent.
//
// With a `comment`, it RE-analyses one topic with the reviewer's steer. The
// previous analysis is handed to the model so it knows what it is being asked
// to reconsider, and is kept on `history` rather than overwritten.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

/** Topics per run. One request to the community and one model call each. */
const MAX_TOPICS = 15;
const MAX_COMMENT_CHARS = 1000;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  topicIds?: unknown;
  /** Re-analyse topics already analysed at the current prompt version. */
  force?: unknown;
  /** "Think about it from a different angle" — one topic only. */
  comment?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, MAX_COMMENT_CHARS) : '';
  const explicit = Array.isArray(body.topicIds)
    ? [...new Set(body.topicIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];

  if (comment && explicit.length !== 1) {
    return badRequest('A comment re-analyses one thread at a time — send exactly one topicId with it.');
  }

  const steerFrom = comment ? await getAssessment(projectId, explicit[0]) : null;
  if (comment && !steerFrom) {
    return badRequest('Analyse this thread first — a comment asks the analysis to reconsider, so there has to be one.');
  }
  // A steer is always a fresh run; so is an explicit re-run with force.
  const force = body.force === true || !!comment;

  const picked = explicit.length
    ? (await listTopics(projectId, { limit: 1000 })).filter((t) => explicit.includes(t.id))
    : await listTopics(projectId, { selectedOnly: true, limit: 200 });

  if (!picked.length) {
    return badRequest(
      explicit.length
        ? 'None of those topics are held. Fetch the board first.'
        : 'Nothing is picked. Tick the topics you want analysed, then press Analyse.',
    );
  }

  // Already analysed at this prompt version is not work to redo. A newer
  // prompt makes every older analysis stale automatically.
  const todo = force
    ? picked
    : picked.filter((t) => t.analysedAtMs === null || t.analysisPromptVersion !== ASSESS_PROMPT_VERSION);

  const skippedAsFresh = picked.length - todo.length;
  if (!todo.length) {
    return NextResponse.json({
      analysed: 0,
      skippedAsFresh,
      notReached: 0,
      unreadable: 0,
      results: [],
      failed: [],
      message: 'Everything picked has already been analysed at the current prompt version. Use Re-analyse on a row to redo one.',
    });
  }

  const config = await getShopifyConfig(projectId);

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, config.analysisModel, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }

  const sources = (await listShopifySources(projectId)).map(toPromptSource);
  const boardName = (id: number) => config.categories.find((c) => c.id === id)?.name ?? '';

  const capped = todo.slice(0, MAX_TOPICS);
  const results: { topicId: number; title: string; suggested: string }[] = [];
  const failed: { topicId: number; title: string; error: string }[] = [];
  let unreadable = 0;

  for (const topic of capped) {
    try {
      const outcome = await assessTopic(
        {
          topic,
          board: boardName(topic.categoryId),
          client: config.client,
          sources,
          steer: steerFrom ? { comment, previous: steerFrom.current.assessment } : null,
          uid: caller.uid,
          nowMs: Date.now(),
        },
        async (input) => {
          const res = await callModel(model, input);
          return { content: res.content, model: model.providerModelId, usage: res.usage };
        },
      );

      // ⚠️ AN UNREADABLE ANSWER IS REPORTED, NOT STORED. Storing it would
      // replace a good analysis with an empty one and push the good one into
      // history, which reads as the model changing its mind.
      if (isUnreadable(outcome.version.assessment)) {
        unreadable++;
        failed.push({ topicId: topic.id, title: topic.title, error: 'The model’s answer could not be read.' });
        continue;
      }

      await saveAssessment(projectId, outcome);
      results.push({ topicId: topic.id, title: outcome.meta.title, suggested: outcome.version.assessment.suggested });
    } catch (err) {
      failed.push({
        topicId: topic.id,
        title: topic.title,
        error: err instanceof ShopifyReadError ? err.message : 'That topic could not be analysed.',
      });
    }
  }

  return NextResponse.json({
    analysed: results.length,
    skippedAsFresh,
    // A run cut short by the cap should look cut short, not like a small success.
    notReached: Math.max(0, todo.length - capped.length),
    unreadable,
    results,
    failed,
    model: model.ref,
    promptVersion: ASSESS_PROMPT_VERSION,
  });
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);
  return NextResponse.json({
    assessments: await listAssessments(projectId, Number(url.searchParams.get('limit')) || 200),
    promptVersion: ASSESS_PROMPT_VERSION,
  });
});
