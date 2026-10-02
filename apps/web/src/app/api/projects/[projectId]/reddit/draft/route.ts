import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { DRAFT_PROMPT_VERSION } from '@/modules/reddit/prompts';
import { DeepSeekError } from '@/modules/reddit/deepseek';
import {
  draftProjectReply,
  parseJsonLoose,
  threadRefusal,
  ReplyPipelineError,
  type ReplyOutcome,
} from '@/modules/reddit/replyPipeline';
import { createCrawlzoReader } from '@/modules/reddit/reader/crawlzo';
import type { ThreadSnapshot } from '@/modules/forum/reader/types';
import { modelByRef } from '@/lib/llm/catalog';
import { callModel } from '@/server/llm';
import { resolveModelForRun, runActor, ModelUnavailableError } from '@/server/llm/resolve';
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
import { instructionsForDraft } from '@/server/draftingInstructions';
import { isBrandOpportunity, isGrowthOpportunity } from '@/modules/reddit/opportunity';
import type { RedditOpportunityAnalysis, RedditPost } from '@/modules/reddit/types';

// Serverless budget. This route makes one thread read and up to three model
// calls in sequence; the platform default cuts it off well before that and the
// caller sees a truncated request, not a model error.
// 60 is the Hobby ceiling — raising it further needs a paid plan.
export const maxDuration = 60;

// POST /api/projects/:projectId/reddit/draft
//
// Writes the reply. Requires drafts.generate — a separate permission from
// items.analyze because it is a separate spend.
//
// The reply is written by modules/reddit/replyPipeline.ts: read the live
// thread, sharpen the analysis angle against the comments, write three attempts
// sized to the thread, check them in code, pick one. This file supplies the
// thread, the model and somewhere to write the result — nothing here decides
// what a reply says.
//
// As with analyze, the server loads the analysis from Firestore rather than
// accepting it from the caller. That matters more here than anywhere else: the
// brand/growth gate below is driven by the analysis, so a client-supplied
// analysis would let a caller fabricate `mentionRecommendation: 'yes'` and
// draft a promotional reply for a post the model actually judged unsuitable.
// ML Studio takes the analysis straight from the request body.

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
  const isBrand = isBrandOpportunity(analysis);
  const isGrowth = isGrowthOpportunity(analysis);

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

  // The team's own drafting instructions, read FRESH on every run — switching
  // a block off and pressing Draft again is how you compare two wordings, so a
  // cached read would make the feature look broken. Empty when nobody has added
  // any, and the prompt is then byte-for-byte what it was before they existed.
  const instructions = await instructionsForDraft(projectId);

  // No requireJson: the pipeline asks for JSON, but parses whatever comes back
  // leniently, so a model without JSON mode still qualifies — as it always has
  // for drafting.
  let model;
  try {
    model = await resolveModelForRun(runActor(caller), projectId, config.draftModel ?? null);
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 409 });
    }
    throw err;
  }

  // The live thread, read NOW rather than at fetch time: the comments are what
  // the reply has to fit, and a post can be locked or removed in between.
  //
  // A post that is gone or closed is refused. A read that FAILED (no key, the
  // vendor down) is not: the reply is still written, as for a thread with no
  // comments, and the draft records that the thread was never seen.
  let thread: ThreadSnapshot | null = null;
  let threadError = '';
  try {
    thread = await createCrawlzoReader().getThread(post.redditPostId);
    if (!thread) return badRequest('This post is no longer on Reddit.');
  } catch (err) {
    threadError = err instanceof Error ? err.message : 'The thread could not be read.';
  }
  if (thread) {
    const refusal = threadRefusal(thread);
    if (refusal) return badRequest(refusal);
  }

  const jsonMode = modelByRef(model.ref)?.json === true;
  const usage = { inputTokens: 0, outputTokens: 0 };

  let outcome: ReplyOutcome;
  try {
    outcome = await draftProjectReply(
      {
        ask: async ({ system, user, temperature, maxTokens }) => {
          const res = await callModel(model, { system, user, temperature, maxTokens, json: jsonMode });
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
          return parseJsonLoose(res.content);
        },
      },
      {
        project: toRedditProject(proj, config),
        sources,
        post,
        analysis,
        instructions: instructions.active,
        thread,
      },
    );
  } catch (err) {
    if (err instanceof DeepSeekError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ReplyPipelineError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }

  const body = outcome.body;

  // What the reviewer needs to judge the reply against: what it was written to,
  // what the thread looked like, and what else was on the table.
  const pipeline = {
    threadRead: outcome.threadRead,
    threadError,
    commentsSeen: outcome.commentsSeen,
    angleOriginal: outcome.angle.original,
    angleRefined: outcome.angle.refined,
    angleChanged: outcome.angle.changed,
    angleNote: outcome.angle.note,
    posterWant: outcome.posterWant,
    delivered: outcome.delivered,
    room: outcome.room,
    flags: outcome.flags,
    pickReason: outcome.pickReason,
    alternates: outcome.alternates,
    rejected: outcome.rejected,
  };

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
    // WHAT THIS REPLY WAS WRITTEN UNDER. Two drafts on the same post are only
    // comparable if you can see which instructions each had; the prompt version
    // alone cannot say that, because the instructions are data, not code.
    instructionIds: instructions.instructionIds,
    instructionsFingerprint: instructions.fingerprint,
    pipeline,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    createdBy: caller.uid,
  });

  await setItemStatus(projectId, itemId, 'drafted');

  return NextResponse.json({
    draftId,
    draft: body,
    kind: isBrand ? 'brand' : 'growth',
    pipeline,
    meta: {
      model: model.providerModelId,
      promptVersion: DRAFT_PROMPT_VERSION,
      instructions: instructions.active.map((i) => ({ instructionId: i.instructionId, title: i.title, scope: i.scope })),
      instructionsFingerprint: instructions.fingerprint,
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
