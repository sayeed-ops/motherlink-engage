import { NextResponse } from 'next/server';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
import { getShopifyConfig } from '@/server/shopify';
import { getReading } from '@/server/shopifyAnalysis';
import {
  decideDraft,
  listDrafts,
  loadSources,
  NoModeAvailableError,
  saveDraft,
  writeReply,
} from '@/server/shopifyDrafts';
import { fetchTopicRaw, ShopifyReadError } from '@/modules/shopify/reader';
import { parseDiscussion, renderDiscussion } from '@/modules/shopify/discussion';
import { REPLY_MODES, REPLY_PROMPT_VERSION, type ReplyMode } from '@/modules/shopify/reply';

// A note on how the screen knows which buttons to offer: the GET below returns
// `hasClientProfile` and `sourceCount`, which is enough to disable Growth and
// Brand project-wide. Whether a PARTICULAR thread has a supporting source is
// answered here, on the attempt, with a message that says what to do about it —
// asking per row would be one request per row for a question most rows share.

// POST  /api/projects/:projectId/shopify/draft — write a reply for one thread
// GET   /api/projects/:projectId/shopify/draft — the drafts back
// PATCH /api/projects/:projectId/shopify/draft — approve or reject one
//
// ════════════════════════════════════════════════════════════════════════════
// ONE THREAD, ONE MODE, CHOSEN BY A PERSON. AND IT CANNOT POST.
//
// `items.analyze` to write (one model call), `drafts.approve` to decide —
// the REVERSIBLE tier, never `drafts.publish`, because there is nothing to
// publish. No job kind exists for this platform. Approving records that
// somebody read it and agreed; the text is then copied by hand.
// ════════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

type Ctx = { params: Promise<{ projectId: string }> };

interface PostBody {
  topicId?: unknown;
  mode?: unknown;
  /** Roughly how long. The thread's own register is the better guide, but an
   *  operator who wants two sentences should be able to ask for two. */
  targetWords?: unknown;
}

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const body = await jsonBody<PostBody>(req);
  const topicId = Number(body.topicId);
  if (!Number.isInteger(topicId) || topicId <= 0) return badRequest('A topicId is required.');

  const mode = String(body.mode ?? 'open') as ReplyMode;
  if (!REPLY_MODES.includes(mode)) {
    return badRequest(`mode must be one of: ${REPLY_MODES.join(', ')}.`);
  }

  // ⚠️ THE READING IS A PREREQUISITE, NOT AN OPTIONAL EXTRA. Every mode's
  // prompt is built around what the thread already contains — for Open that is
  // the bar to beat, for the others it is what not to repeat. Drafting without
  // it would produce exactly the generic reply this module exists to avoid.
  const reading = await getReading(projectId, topicId);
  if (!reading) {
    return badRequest('Read this thread first — a reply is written against what the thread already says.');
  }

  const config = await getShopifyConfig(projectId);

  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, null, { requireJson: true });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Re-fetched rather than stored. This is the whole storage posture: the
  // thread lives in memory for the length of the call and is never written.
  let discussion: string;
  try {
    const parsed = parseDiscussion(await fetchTopicRaw(topicId, reading.url.split('/').at(-2) ?? ''));
    if (!parsed) return badRequest('That thread could not be read back.');
    discussion = renderDiscussion(parsed);
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
        title: reading.title,
        url: reading.url,
        categoryId: reading.categoryId,
        mode,
        discussion,
        understanding: reading.understanding,
        client: config.client,
        targetWords,
      },
      await loadSources(projectId),
      async (input) => {
        const res = await callModel(model, input);
        return { content: res.content, model: model.providerModelId };
      },
    );

    // An empty draft is a RECORDED DECISION, not an error: growth and brand are
    // both told to write nothing rather than force a mention, and storing that
    // is how "we looked and declined" survives.
    await saveDraft(projectId, draft);

    return NextResponse.json({
      draft,
      empty: draft.text.trim().length === 0,
      // Surfaced rather than buried. A forbidden phrase that slipped through
      // is the first thing a reviewer needs to see.
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
  const [config, sources] = await Promise.all([getShopifyConfig(projectId), loadSources(projectId)]);

  return NextResponse.json({
    drafts: await listDrafts(projectId, Number(url.searchParams.get('limit')) || 100),
    promptVersion: REPLY_PROMPT_VERSION,
    // What the screen needs to know which mode buttons to offer, without
    // asking per row.
    hasClientProfile: config.client.companyDescription.trim().length > 0,
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
  // Only the two a person chooses. `pending` is where a draft starts and is not
  // a decision anybody makes.
  if (status !== 'approved' && status !== 'rejected') {
    return badRequest('status must be approved or rejected.');
  }

  await decideDraft(projectId, draftId, status, caller.uid);
  return NextResponse.json({ ok: true, draftId, status });
});
