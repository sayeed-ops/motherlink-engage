import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { buildDraftPrompt, DRAFT_PROMPT_VERSION } from '@/modules/reddit/prompts';
import { cleanDraft, DeepSeekError } from '@/modules/reddit/deepseek';
import { callModel } from '@/server/llm';
import { resolveModelForRun, ModelUnavailableError } from '@/server/llm/resolve';
import { adminDb } from '@/server/admin';
import {
  getProject,
  getRedditConfig,
  listSources,
  getItem,
  toRedditProject,
  createDraft,
  setItemStatus,
  getDraft,
  setDraftStatus,
} from '@/modules/reddit/store';
import type { RedditOpportunityAnalysis, RedditPost } from '@/modules/reddit/types';

// Serverless budget. The DeepSeek call is the whole cost of this route and a
// long reply can take tens of seconds; the platform default cuts it off well
// before that and the caller sees a truncated request, not a model error.
// 60 is the Hobby ceiling — raising it further needs a paid plan.
export const maxDuration = 60;

// POST /api/projects/:projectId/reddit/draft
//
// Writes the reply. Requires drafts.generate — a separate permission from
// items.analyze because it is a separate spend.
//
// As with analyze, the server loads the analysis from Firestore rather than
// accepting it from the caller. That matters more here than anywhere else: the
// brand/growth gate below is driven by the analysis, so a client-supplied
// analysis would let a caller fabricate `mentionRecommendation: 'yes'` and
// draft a promotional reply for a post the model actually judged unsuitable.
// ML Studio takes the analysis straight from the request body.

const GROWTH_MIN = 40;

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.generate');

  const { itemId, analysisId } = await jsonBody<{ itemId?: string; analysisId?: string }>(req);
  if (!itemId) return badRequest('An itemId is required.');
  if (!analysisId) return badRequest('An analysisId is required.');

  const analysisSnap = await adminDb()
    .collection('projects')
    .doc(projectId)
    .collection('analyses')
    .doc(analysisId)
    .get();

  if (!analysisSnap.exists) return badRequest('That analysis is not in this project.');

  const analysisRaw = analysisSnap.data() as Record<string, unknown>;
  if (analysisRaw.itemId !== itemId) {
    return badRequest('That analysis does not belong to that post.');
  }

  const [proj, config, sources, item] = await Promise.all([
    getProject(projectId),
    getRedditConfig(projectId),
    listSources(projectId),
    getItem(projectId, itemId),
  ]);

  if (!proj) return badRequest('Project not found.');
  if (!config) return badRequest('This project has no Reddit configuration yet.');
  if (!item) return badRequest('That post is not in this project.');

  const analysis = {
    ...analysisRaw,
    createdAt: (analysisRaw.createdAt as { toDate(): Date } | undefined)?.toDate() ?? new Date(),
  } as unknown as RedditOpportunityAnalysis;

  // Eligibility, ported verbatim. Draft for a brand opportunity (the mention
  // fits) OR a growth opportunity (a genuinely useful reply with no mention,
  // for account warming) — even when the brand decision is "skip". Block only
  // when it is neither.
  //
  // Growth <=> mentionRecommendation 'no' is structural, not incidental: it is
  // why a growth reply can never pitch the brand. Losing that invariant loses
  // the safety property.
  const isBrand =
    analysis.decision !== 'skip' &&
    (analysis.mentionRecommendation === 'yes' || analysis.mentionRecommendation === 'soft');
  const isGrowth = analysis.mentionRecommendation === 'no' && (analysis.growthScore ?? 0) >= GROWTH_MIN;

  if (!isBrand && !isGrowth) {
    return badRequest('This post is neither a brand nor a growth opportunity.');
  }

  const raw = item as Record<string, unknown>;
  const post = {
    ...raw,
    postId: raw.itemId,
    redditPostId: raw.externalId,
    createdAtReddit: (raw.createdAtSource as { toDate(): Date }).toDate(),
  } as unknown as RedditPost;

  const { system, user } = buildDraftPrompt(toRedditProject(proj, config), sources, post, analysis);

  // No requireJson here — a reply is prose, so every catalogue model qualifies.
  let model;
  try {
    model = await resolveModelForRun(caller.uid, projectId, config.draftModel ?? null);
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 409 });
    }
    throw err;
  }

  let content: string;
  let usage;
  try {
    // temperature 0.7 and no JSON mode: a reply is prose, not a schema.
    ({ content, usage } = await callModel(model, {
      system,
      user,
      temperature: 0.7,
      maxTokens: 500,
      json: false,
    }));
  } catch (err) {
    if (err instanceof DeepSeekError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const body = cleanDraft(content);
  if (!body) return NextResponse.json({ error: 'DeepSeek returned an empty draft.' }, { status: 502 });

  const draftId = await createDraft(projectId, {
    itemId,
    analysisId,
    body,
    // Preserve the pristine first generation so later edits can be trained
    // against exactly what the model wrote.
    aiOriginalBody: body,
    reviewerNotes: '',
    revisionOf: null,
    model: model.providerModelId,
    promptVersion: DRAFT_PROMPT_VERSION,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    createdBy: caller.uid,
  });

  await setItemStatus(projectId, itemId, 'drafted');

  return NextResponse.json({
    draftId,
    draft: body,
    kind: isBrand ? 'brand' : 'growth',
    meta: {
      model: model.providerModelId,
      promptVersion: DRAFT_PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  });
});

// PATCH /api/projects/:projectId/reddit/draft
//
// Move a draft through review: mark it posted (a human posted it by hand) or
// reject it with optional reviewer notes.
//
// Gated on drafts.generate, the same permission that created the draft — the
// person working the queue records what happened to their own drafts. The
// irreversible, account-attributed publish path is separate and does not exist
// yet (OVERVIEW: publishing moves last). This is bookkeeping, not posting.
//
// 'publish' is intentionally NOT accepted here: only draft/posted/rejected.

const DRAFT_STATUSES = ['draft', 'posted', 'rejected'] as const;

interface DraftPatch {
  draftId?: string;
  status?: (typeof DRAFT_STATUSES)[number];
  reviewerNotes?: string;
}

export const PATCH = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'drafts.generate');

  const { draftId, status, reviewerNotes } = await jsonBody<DraftPatch>(req);
  if (!draftId) return badRequest('A draftId is required.');
  if (!status || !DRAFT_STATUSES.includes(status)) return badRequest('Unknown draft status.');
  if (reviewerNotes !== undefined && typeof reviewerNotes !== 'string') {
    return badRequest('reviewerNotes must be a string.');
  }

  // Prove the draft is in this project — update() on a missing doc would 500.
  const draft = await getDraft(projectId, draftId);
  if (!draft) return badRequest('That draft is not in this project.');

  await setDraftStatus(projectId, draftId, status, reviewerNotes);

  // Mirror ML Studio: marking a draft posted stamps the post as handled, so the
  // ANSWERED ledger and the post's own status agree.
  if (status === 'posted' && typeof draft.itemId === 'string') {
    await setItemStatus(projectId, draft.itemId, 'drafted');
  }

  return NextResponse.json({ ok: true });
});
