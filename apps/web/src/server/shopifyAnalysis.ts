import 'server-only';

// Stage two: read the question a person picked, score the three kinds of reply,
// keep the analysis — and every earlier one.
//
// ════════════════════════════════════════════════════════════════════════════
// FETCH → THE OPENING POST → ONE MODEL CALL → STORE. THE REPLIES ARE NOT SENT.
//
// The topic is fetched whole (one JSON request — Discourse will not serve the
// first post alone), but only post #1 and the thread's numbers reach the
// model. The replies are read at draft time, by the call that writes against
// them. See modules/shopify/assess.ts for the reasoning and the rules.
//
// Bodies are still never written. What is kept is the analysis, a short quote
// of the question so a stored analysis can be recognised without the thread,
// and — once somebody drafts — the digest of the replies and up to six quotes
// it cited.
//
// ⚠️ A RE-ANALYSIS DOES NOT ERASE THE ONE BEFORE IT. "Think about it from a
// different angle" is a request to compare, and a screen that overwrote the
// first opinion with the second would leave nothing to compare against. The
// current analysis sits on `current`; the earlier ones, newest first, on
// `history` — five at most, each a few hundred bytes.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { fetchTopicRaw, ShopifyReadError } from '@/modules/shopify/reader';
import { openingPost, parseDiscussion, type Discussion } from '@/modules/shopify/discussion';
import {
  ASSESS_PROMPT_VERSION,
  buildAssessPrompt,
  isUnreadable,
  parseAssessment,
  scorableModes,
  SYSTEM_PROMPT,
  type Assessment,
  type Steer,
  type ThreadCounts,
} from '@/modules/shopify/assess';
import { matchSources, type PromptSource } from '@/modules/shopify/knowledge';
import type { ShopifyClientProfile } from '@/modules/shopify/client';
import type { ThreadDigest } from '@/modules/shopify/digest';
import type { StoredTopic } from './shopify';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);
const topics = (projectId: string) => project(projectId).collection('shopifyTopics');
const assessments = (projectId: string) => project(projectId).collection('shopifyAssessments');

export type AskModel = (input: {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
}) => Promise<{ content: string; model: string; usage?: { inputTokens: number; outputTokens: number } }>;

/** Quoted evidence. Capped hard: a citation, not a copy of the thread. */
export interface Evidence {
  postNumber: number;
  username: string;
  quote: string;
  likeCount: number;
  isAcceptedAnswer: boolean;
}

const MAX_EVIDENCE = 6;
const MAX_QUOTE_CHARS = 400;
const MAX_HISTORY = 5;

/** One analysis, and everything needed to judge it later. */
export interface AssessmentVersion {
  assessment: Assessment;
  /** The reviewer's steer that produced this one, or null for a plain run. */
  comment: string | null;
  /** The free matcher's shortlist — what the model was shown. */
  matchedSourceIds: string[];
  /** Brand can be drafted: the client can be named and a source matched. */
  brandSupported: boolean;
  counts: ThreadCounts;
  promptVersion: string;
  model: string;
  /** Measured, so "the analysis is cheaper now" is a number rather than a
   *  claim. Null when the provider did not report it. */
  usage: { inputTokens: number; outputTokens: number } | null;
  assessedAtMs: number;
  assessedBy: string;
}

export interface StoredAssessment {
  topicId: number;
  title: string;
  categoryId: number;
  url: string;
  askedBy: string;
  /** The first few sentences of the question, so the analysis can be
   *  recognised without the thread. */
  questionQuote: string;
  current: AssessmentVersion;
  /** Earlier analyses, newest first. */
  history: AssessmentVersion[];
  /** Written by the first draft — what the replies already say. Null until a
   *  reply has been asked for, because until then nobody has read them. */
  digest: ThreadDigest | null;
  digestAtMs: number | null;
  evidence: Evidence[];
  postsSeen: number | null;
  postsTotal: number | null;
  truncated: boolean;
  updatedAtMs: number;
}

const daysSince = (ms: number | null, nowMs: number): number | null =>
  ms === null ? null : Math.max(0, Math.floor((nowMs - ms) / 86_400_000));

const quote = (text: string): string =>
  text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : text;

export interface AssessRequest {
  topic: StoredTopic;
  board: string;
  client: ShopifyClientProfile;
  sources: readonly PromptSource[];
  steer: Steer | null;
  uid: string;
  nowMs: number;
}

export interface AssessOutcome {
  meta: Pick<StoredAssessment, 'topicId' | 'title' | 'categoryId' | 'url' | 'askedBy' | 'questionQuote'>;
  version: AssessmentVersion;
}

/**
 * Analyse one topic. Returns the analysis, or throws.
 *
 * A single topic failing must not take a run down — the caller catches per
 * topic, as the stage-one fetch does per board.
 */
export async function assessTopic(req: AssessRequest, ask: AskModel): Promise<AssessOutcome> {
  const { topic, nowMs } = req;
  const discussion = parseDiscussion(await fetchTopicRaw(topic.id, topic.slug));
  const opening = discussion ? openingPost(discussion) : null;
  if (!discussion || !opening) throw new ShopifyReadError('That topic came back with no readable opening post.');

  const counts: ThreadCounts = {
    // From the payload just fetched, not the listing — the listing may be a
    // day old, and "nobody has replied" must not be said of a thread that has.
    replies: Math.max(0, discussion.postsTotal - 1),
    views: topic.views,
    likes: topic.likeCount,
    solved: discussion.acceptedAnswerNumber !== null || topic.hasAcceptedAnswer,
    closed: topic.closed,
    daysOld: daysSince(topic.createdAtMs, nowMs),
    daysSinceLastPost: daysSince(topic.lastPostedAtMs, nowMs),
  };

  const title = discussion.title || topic.title;
  // Matched against the QUESTION, the only text the analysis has. The draft
  // re-matches against what the analysis understood, so a source added after
  // this runs can still support a Brand reply.
  const matched = matchSources(req.sources, `${title} ${opening.text}`);
  const able = scorableModes(req.client, matched.length);

  const { content, model, usage } = await ask({
    system: SYSTEM_PROMPT,
    user: buildAssessPrompt({
      title,
      board: req.board,
      question: opening.text,
      askedBy: opening.username,
      counts,
      client: req.client,
      sources: matched,
      steer: req.steer,
    }),
    temperature: 0.2,
    maxTokens: 1200,
    json: true,
  });

  const assessment = parseAssessment(content, {
    client: req.client,
    offeredSourceIds: matched.map((s) => s.sourceId),
  });

  return {
    meta: {
      topicId: topic.id,
      title,
      categoryId: discussion.categoryId || topic.categoryId,
      url: `https://community.shopify.com/t/${discussion.slug || topic.slug}/${topic.id}`,
      askedBy: opening.username,
      questionQuote: quote(opening.text),
    },
    version: {
      assessment,
      comment: req.steer?.comment.trim() || null,
      matchedSourceIds: matched.map((s) => s.sourceId),
      brandSupported: able.brandSupported,
      counts,
      promptVersion: ASSESS_PROMPT_VERSION,
      model,
      usage: usage ?? null,
      assessedAtMs: nowMs,
      assessedBy: req.uid,
    },
  };
}

/**
 * Store an analysis. The previous `current` moves onto `history`.
 *
 * In a transaction, so two people re-analysing one thread at once cannot both
 * read the same `current` and each push it — one history entry lost, one
 * duplicated.
 */
export async function saveAssessment(projectId: string, outcome: AssessOutcome): Promise<StoredAssessment> {
  const ref = assessments(projectId).doc(String(outcome.meta.topicId));
  const nowMs = outcome.version.assessedAtMs;

  const stored = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() as StoredAssessment) : null;
    const next: StoredAssessment = {
      ...outcome.meta,
      current: outcome.version,
      history: prev ? [prev.current, ...(prev.history ?? [])].slice(0, MAX_HISTORY) : [],
      // The digest describes the REPLIES, which a re-analysis does not read, so
      // it survives one.
      digest: prev?.digest ?? null,
      digestAtMs: prev?.digestAtMs ?? null,
      evidence: prev?.evidence ?? [],
      postsSeen: prev?.postsSeen ?? null,
      postsTotal: prev?.postsTotal ?? null,
      truncated: prev?.truncated ?? false,
      updatedAtMs: nowMs,
    };
    tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() });
    tx.set(
      topics(projectId).doc(String(outcome.meta.topicId)),
      { analysedAtMs: nowMs, analysisPromptVersion: ASSESS_PROMPT_VERSION, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return next;
  });

  return stored;
}

export async function listAssessments(projectId: string, limit = 200): Promise<StoredAssessment[]> {
  const snap = await assessments(projectId)
    .orderBy('updatedAtMs', 'desc')
    .limit(Math.max(1, Math.min(500, limit)))
    .get();
  return snap.docs.map((d) => d.data() as StoredAssessment);
}

export async function getAssessment(projectId: string, topicId: number): Promise<StoredAssessment | null> {
  const snap = await assessments(projectId).doc(String(topicId)).get();
  return snap.exists ? (snap.data() as StoredAssessment) : null;
}

/** Record what the replies say, as the latest draft read them. */
export async function saveDigest(
  projectId: string,
  topicId: number,
  discussion: Discussion,
  digest: ThreadDigest,
  nowMs: number,
): Promise<void> {
  await assessments(projectId)
    .doc(String(topicId))
    .set(
      {
        digest,
        digestAtMs: nowMs,
        evidence: pickEvidence(discussion, digest),
        postsSeen: discussion.posts.length,
        postsTotal: discussion.postsTotal,
        truncated: discussion.truncated,
        updatedAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/**
 * The posts worth keeping beside the digest: the question, the accepted
 * answer, whatever the digest cited, then the most-liked. Chosen from the
 * THREAD, not from the model's reply — a post number it invented has no text
 * to quote, so it is absent rather than fabricated.
 */
function pickEvidence(d: Discussion, digest: ThreadDigest): Evidence[] {
  const byNumber = new Map(d.posts.map((p) => [p.postNumber, p]));
  const chosen = new Map<number, Evidence>();

  const add = (n: number) => {
    if (chosen.size >= MAX_EVIDENCE) return;
    const p = byNumber.get(n);
    if (!p || chosen.has(n)) return;
    chosen.set(n, {
      postNumber: p.postNumber,
      username: p.username,
      quote: quote(p.text),
      likeCount: p.likeCount,
      isAcceptedAnswer: p.isAcceptedAnswer,
    });
  };

  const opening = openingPost(d);
  if (opening) add(opening.postNumber);
  if (d.acceptedAnswerNumber !== null) add(d.acceptedAnswerNumber);
  for (const o of digest.offered) add(o.postNumber);
  for (const p of [...d.posts].sort((a, b) => b.likeCount - a.likeCount)) add(p.postNumber);

  return [...chosen.values()].sort((a, b) => a.postNumber - b.postNumber);
}

export { isUnreadable };
