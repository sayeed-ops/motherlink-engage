import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { listTopics } from '@/server/shopify';
import { isUnreadable, listReadings, readTopic, saveReading } from '@/server/shopifyAnalysis';
import { ShopifyReadError } from '@/modules/shopify/reader';
import { UNDERSTAND_PROMPT_VERSION } from '@/modules/shopify/understand';

// POST /api/projects/:projectId/shopify/read — open the picked topics and read them
// GET  /api/projects/:projectId/shopify/read — the readings back
//
// ════════════════════════════════════════════════════════════════════════════
// THIS IS THE ONE THAT SPENDS MODEL CREDIT, AND IT ONLY EVER READS WHAT YOU PICKED
//
// `items.analyze` — the model-spend tier — because it is one call per topic.
// Stage one is `items.fetch` and free of models entirely; the two are separate
// routes and separate permissions so the expensive half is never triggered by
// pressing the cheap one.
//
// There is no selection heuristic here and no ranking: it reads the topics
// marked `selected`, which a person ticked. Nothing drafts and nothing posts.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

/** Topics per run. One request to the community and one model call each, so
 *  this is a bill and a courtesy at the same time. */
const MAX_TOPICS = 15;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  /** Read exactly these, ignoring what is ticked. The row-level button — a
   *  person pressing "Read" on one topic they are looking at. */
  topicIds?: unknown;
  /** Re-read topics already analysed at the current prompt version. Off by
   *  default: the marker exists so a second run does not pay twice for the
   *  same reading. */
  force?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const force = body.force === true;

  const explicit = Array.isArray(body.topicIds)
    ? body.topicIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  // Ticked, or exactly what was asked for. `selectedOnly` is a query filter,
  // not an array scan — see the note in server/shopify.ts about filtering after
  // a limit.
  const picked = explicit.length
    ? (await listTopics(projectId, { limit: 1000 })).filter((t) => explicit.includes(t.id))
    : await listTopics(projectId, { selectedOnly: true, limit: 200 });

  if (!picked.length) {
    return badRequest(
      explicit.length
        ? 'None of those topics are held. Fetch the board first.'
        : 'Nothing is picked. Tick the topics you want opened, then press Read.',
    );
  }

  // ⚠️ ALREADY READ AT THIS PROMPT VERSION IS NOT WORK TO REDO. A newer prompt
  // makes every older reading stale automatically, which is the whole reason
  // the version is stored beside the timestamp.
  const todo = force
    ? picked
    : picked.filter((t) => t.analysedAtMs === null || t.analysisPromptVersion !== UNDERSTAND_PROMPT_VERSION);

  const skippedAsFresh = picked.length - todo.length;
  if (!todo.length) {
    return NextResponse.json({
      read: 0,
      skippedAsFresh,
      unreadable: 0,
      failed: [],
      message: 'Everything picked has already been read at the current prompt version.',
    });
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

  const runId = crypto.randomUUID();
  const nowMs = Date.now();
  const capped = todo.slice(0, MAX_TOPICS);

  const results: { topicId: number; title: string; engagement: string; wouldRepeat: boolean }[] = [];
  const failed: { topicId: number; title: string; error: string }[] = [];
  let unreadable = 0;

  for (const topic of capped) {
    try {
      const reading = await readTopic(topic, async (input) => {
        const res = await callModel(model, input);
        return { content: res.content, model: model.providerModelId };
      }, runId);

      // ⚠️ AN UNREADABLE REPLY IS RECORDED, NOT DISCARDED AND NOT STORED AS A
      // THIN READING. A model answer we could not parse is a fact about the run
      // — treating it as "this thread had no concern" would make a broken
      // prompt look like a quiet forum.
      if (isUnreadable(reading.understanding)) {
        unreadable++;
        failed.push({ topicId: topic.id, title: topic.title, error: 'The model’s reply could not be read.' });
        continue;
      }

      await saveReading(projectId, reading, nowMs);
      results.push({
        topicId: topic.id,
        title: reading.title,
        engagement: reading.understanding.engagement,
        wouldRepeat: reading.wouldRepeat,
      });
    } catch (err) {
      failed.push({
        topicId: topic.id,
        title: topic.title,
        error: err instanceof ShopifyReadError ? err.message : 'That topic could not be read.',
      });
    }
  }

  return NextResponse.json({
    runId,
    read: results.length,
    skippedAsFresh,
    // Reported for the same reason a fetch reports its planned requests: a run
    // cut short by a cap should look cut short, not like a small success.
    notReached: Math.max(0, todo.length - capped.length),
    unreadable,
    results,
    failed,
    promptVersion: UNDERSTAND_PROMPT_VERSION,
  });
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);
  return NextResponse.json({
    readings: await listReadings(projectId, Number(url.searchParams.get('limit')) || 100),
    promptVersion: UNDERSTAND_PROMPT_VERSION,
  });
});
