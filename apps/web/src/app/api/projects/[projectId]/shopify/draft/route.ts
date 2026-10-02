import { NextResponse } from 'next/server';
import { adminDb } from '@/server/admin';
import { jobsForDrafts } from '@/server/shopifyPosting';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { getShopifyConfig } from '@/server/shopify';
import { getAssessment, saveDigest } from '@/server/shopifyAnalysis';
import { listShopifySources } from '@/server/shopifyKnowledge';
import { decideDraft, listDrafts, NoModeAvailableError, saveDraft, writeReply } from '@/server/shopifyDrafts';
import { fetchTopicRaw, ShopifyReadError } from '@/modules/shopify/reader';
import { parseDiscussion, renderDiscussion } from '@/modules/shopify/discussion';
import { toPromptSource } from '@/modules/shopify/knowledge';
import { canDescribeClient } from '@/modules/shopify/client';
import { REPLY_MODES, REPLY_PROMPT_VERSION, type ReplyMode } from '@/modules/shopify/reply';

// POST  /api/projects/:projectId/shopify/draft — write a reply for one thread
// GET   /api/projects/:projectId/shopify/draft — the drafts back
// PATCH /api/projects/:projectId/shopify/draft — approve or reject one
//
// ════════════════════════════════════════════════════════════════════════════
// ONE THREAD, ONE MODE, CHOSEN BY A PERSON. THE REPLIES ARE READ HERE. IT CANNOT POST.
//
// `items.analyze` to write (one model call, on this module's `draftModel`),
// `drafts.approve` to decide — the REVERSIBLE tier, never `drafts.publish`,
// because there is nothing to publish.
//
// The thread is RE-FETCHED here rather than stored — the storage posture — and
// that also means the reply is written against replies posted since the
// analysis, not a snapshot of the room from yesterday.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  topicId?: unknown;
  mode?: unknown;
  targetWords?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const topicId = Number(body.topicId);
  if (!Number.isInteger(topicId) || topicId <= 0) return badRequest('A topicId is required.');

  const mode = String(body.mode ?? 'open') as ReplyMode;
  if (!REPLY_MODES.includes(mode)) return badRequest(`mode must be one of: ${REPLY_MODES.join(', ')}.`);

  // ⚠️ THE ANALYSIS IS A PREREQUISITE. Each mode is briefed with the analysis's
  // reason and angle for THAT mode, and with what a good answer must cover.
  const stored = await getAssessment(projectId, topicId);
  if (!stored) return badRequest('Analyse this thread first — each reply is written from its analysis.');

  const config = await getShopifyConfig(projectId);

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, config.draftModel, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }

  let parsed;
  try {
    parsed = parseDiscussion(await fetchTopicRaw(topicId, stored.url.split('/').at(-2) ?? ''));
    if (!parsed) return badRequest('That thread could not be read back.');
  } catch (err) {
    if (err instanceof ShopifyReadError) return badRequest(err.message);
    throw err;
  }

  const words = Number(body.targetWords);
  const targetWords = Number.isFinite(words) && words > 0 ? Math.min(400, Math.max(30, Math.round(words))) : 120;

  try {
    const draft = await writeReply(
      {
        topicId,
        title: stored.title,
        url: stored.url,
        categoryId: stored.categoryId,
        mode,
        discussion: renderDiscussion(parsed),
        assessment: stored.current.assessment,
        assessedSourceIds: stored.current.assessment.scores.brand.sourceIds.length
          ? stored.current.assessment.scores.brand.sourceIds
          : stored.current.matchedSourceIds,
        client: config.client,
        targetWords,
      },
      (await listShopifySources(projectId)).map(toPromptSource),
      async (input) => {
        const res = await callModel(model, input);
        return { content: res.content, model: model.providerModelId, usage: res.usage };
      },
    );

    // An empty draft is a RECORDED DECISION, not an error: growth and brand
    // are told to write nothing rather than force a mention.
    await saveDraft(projectId, draft);
    // What the replies say, as this call read them — kept on the analysis so
    // the row can show what the reply was measured against.
    await saveDigest(projectId, topicId, parsed, draft.digest, draft.createdAtMs);

    return NextResponse.json({
      draft,
      empty: draft.text.trim().length === 0,
      forbiddenHits: draft.forbiddenHits,
    });
  } catch (err) {
    if (err instanceof NoModeAvailableError) return badRequest(err.message);
    throw err;
  }
});

export const GET = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'project.view');

  const url = new URL(req.url);
  const [config, sources, list] = await Promise.all([
    getShopifyConfig(projectId),
    listShopifySources(projectId),
    listDrafts(projectId, Number(url.searchParams.get('limit')) || 100),
  ]);

  return NextResponse.json({
    drafts: list,
    // The latest posting job for each draft that has been queued — its status,
    // error and permalink. One getAll over the ids the drafts point at.
    jobs: await jobsForDrafts(list as unknown as { draftId: string; postJobId?: string | null }[]),
    promptVersion: REPLY_PROMPT_VERSION,
    // What the screen needs to know which mode buttons to offer. Whether a
    // PARTICULAR thread has a supporting source is on its analysis.
    hasClientProfile: config.client.companyDescription.trim().length > 0,
    canNameClient: canDescribeClient(config.client),
    sourceCount: sources.length,
  });
});

interface PatchBody {
  draftId?: unknown;
  status?: unknown;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.approve');

  const body = await jsonBody<PatchBody>(req);
  const draftId = String(body.draftId ?? '').trim();
  if (!draftId) return badRequest('A draftId is required.');

  const status = String(body.status ?? '');
  if (status !== 'approved' && status !== 'rejected') return badRequest('status must be approved or rejected.');

  // A posted reply is on the forum; re-deciding it would only make the record lie.
  const current = await adminDb().collection('projects').doc(projectId).collection('shopifyDrafts').doc(draftId).get();
  if (current.data()?.status === 'posted') return badRequest('This reply has already been posted.');

  await decideDraft(projectId, draftId, status, caller.uid);
  return NextResponse.json({ ok: true, draftId, status });
});
