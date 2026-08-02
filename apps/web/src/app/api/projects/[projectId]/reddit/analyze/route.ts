import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { buildAnalysisPrompt, ANALYSIS_PROMPT_VERSION } from '@/modules/reddit/prompts';
import { callDeepSeek, DeepSeekError, DEEPSEEK_MODEL } from '@/modules/reddit/deepseek';
import {
  getProject,
  getRedditConfig,
  listSources,
  getItem,
  toRedditProject,
  createAnalysis,
  setItemStatus,
} from '@/modules/reddit/store';
import type { AnalysisDecision, AnalysisMention, AnalysisRisk, RedditPost } from '@/modules/reddit/types';

// Serverless budget — the DeepSeek call dominates. See the draft route.
export const maxDuration = 60;

// POST /api/projects/:projectId/reddit/analyze
//
// Scores one post against the client's knowledge base.
//
// Differs from ML Studio's analyze-post in two ways that matter:
//
//   1. It requires items.analyze on THIS project. ML Studio's is open to the
//      internet — anyone can burn your prepaid DeepSeek credit.
//   2. The client sends an itemId, not the post. ML Studio accepts the whole
//      { project, sources, post } from the browser, so a caller can analyse
//      arbitrary text against arbitrary "sources" — or quietly swap the
//      knowledge base. Here the server loads all three from Firestore, so the
//      analysis is provably about a post we actually fetched for this client.
//
// The prompt itself and the DeepSeek parameters are unchanged.

interface AnalysisJson {
  decision: AnalysisDecision;
  score: number;
  reason: string;
  relevantSourceIds: string[];
  riskLevel: AnalysisRisk;
  mentionRecommendation: AnalysisMention;
  suggestedAngle: string;
  growthScore?: number;
  growthAngle?: string;
}

/** Runtime guard. The model is capable of returning almost anything. */
function isAnalysisJson(x: unknown): x is AnalysisJson {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    (o.decision === 'reply' || o.decision === 'maybe' || o.decision === 'skip') &&
    typeof o.score === 'number' &&
    typeof o.reason === 'string' &&
    Array.isArray(o.relevantSourceIds) &&
    o.relevantSourceIds.every((s) => typeof s === 'string') &&
    (o.riskLevel === 'low' || o.riskLevel === 'medium' || o.riskLevel === 'high') &&
    (o.mentionRecommendation === 'yes' ||
      o.mentionRecommendation === 'soft' ||
      o.mentionRecommendation === 'no') &&
    typeof o.suggestedAngle === 'string'
  );
}

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.analyze');

  const { itemId } = await jsonBody<{ itemId?: string }>(req);
  if (!itemId) return badRequest('An itemId is required.');

  const [proj, config, sources, item] = await Promise.all([
    getProject(projectId),
    getRedditConfig(projectId),
    listSources(projectId),
    getItem(projectId, itemId),
  ]);

  if (!proj) return badRequest('Project not found.');
  if (!config) return badRequest('This project has no Reddit configuration yet.');
  if (!item) return badRequest('That post is not in this project.');

  const raw = item as Record<string, unknown>;
  const post = {
    ...raw,
    postId: raw.itemId,
    redditPostId: raw.externalId,
    // Firestore Timestamp -> Date. The prompt renders a relative age from it,
    // so getting this wrong would silently change the prompt text.
    createdAtReddit: (raw.createdAtSource as { toDate(): Date }).toDate(),
  } as unknown as RedditPost;

  const { system, user } = buildAnalysisPrompt(toRedditProject(proj, config), sources, post);

  let content: string;
  let usage;
  try {
    ({ content, usage } = await callDeepSeek({
      system,
      user,
      temperature: 0.2,
      maxTokens: 800,
      json: true,
    }));
  } catch (err) {
    if (err instanceof DeepSeekError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return NextResponse.json(
      { error: 'DeepSeek output was not valid JSON.', raw: content.slice(0, 500) },
      { status: 502 },
    );
  }

  if (!isAnalysisJson(parsed)) {
    return NextResponse.json(
      { error: 'DeepSeek output did not match the analysis schema.', raw: parsed },
      { status: 502 },
    );
  }

  // The model occasionally scores outside the rubric.
  const score = Math.max(1, Math.min(100, Math.round(parsed.score)));

  // Growth fields are lenient by design: default rather than fail. Analyses
  // written before prompt v3 have no growthScore at all, and that absence is
  // meaningful — those posts simply never surface in the Growth bucket.
  const growthScore =
    typeof parsed.growthScore === 'number'
      ? Math.max(1, Math.min(100, Math.round(parsed.growthScore)))
      : 0;
  const growthAngle = typeof parsed.growthAngle === 'string' ? parsed.growthAngle : '';

  const analysis = { ...parsed, score, growthScore, growthAngle };

  // Persisted here, by the server. In ML Studio the browser does this.
  const analysisId = await createAnalysis(projectId, {
    itemId,
    ...analysis,
    model: DEEPSEEK_MODEL,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    createdBy: caller.uid,
  });

  await setItemStatus(projectId, itemId, 'analyzed');

  return NextResponse.json({
    analysisId,
    analysis,
    meta: {
      model: DEEPSEEK_MODEL,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  });
});
