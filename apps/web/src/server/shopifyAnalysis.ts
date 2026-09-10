import 'server-only';

// Stage two: open the topics a person picked, read the conversation, keep the
// reading.
//
// ════════════════════════════════════════════════════════════════════════════
// FETCH → ANALYSE → STORE THE ANALYSIS. THE BODIES ARE NEVER WRITTEN.
//
// One request to the community, one model call, one small document. The thread
// text exists in memory for the length of the call and is then gone.
//
// What IS kept, beside the reading: the quoted evidence — the opening post and
// the handful of replies the analysis actually cites. That is what makes a
// stored reading reviewable without holding the thread, and it is the piece
// store-then-delete would have taken away from anyone reviewing a decision made
// on the previous run.
//
// ⚠️ NOTHING HERE DRAFTS AND NOTHING HERE POSTS. There is no job kind for this
// platform, no draft state, and no writing code in the tree. Stage two ends
// with a reading a person can act on themselves.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { fetchTopicRaw, ShopifyReadError } from '@/modules/shopify/reader';
import { parseDiscussion, renderDiscussion, type Discussion } from '@/modules/shopify/discussion';
import {
  buildUnderstandPrompt,
  isUnreadable,
  parseUnderstanding,
  SYSTEM_PROMPT,
  UNDERSTAND_PROMPT_VERSION,
  wouldRepeat,
  type Understanding,
} from '@/modules/shopify/understand';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);
const topics = (projectId: string) => project(projectId).collection('shopifyTopics');
const readings = (projectId: string) => project(projectId).collection('shopifyReadings');

/** Ask a model. Injected so this file is testable and so the route owns
 *  credential resolution — same shape as the Covers generator's `AskModel`. */
export type AskModel = (input: {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
}) => Promise<{ content: string; model: string }>;

/** Quoted evidence, kept so a reading can be checked. Capped hard: this is a
 *  citation, not a copy of the thread. */
export interface Evidence {
  postNumber: number;
  username: string;
  /** Trimmed to a couple of sentences. Enough to recognise the post and go
   *  read it; not enough to be a stored copy of somebody's content. */
  quote: string;
  likeCount: number;
  isAcceptedAnswer: boolean;
}

const MAX_EVIDENCE = 6;
const MAX_QUOTE_CHARS = 400;

export interface Reading {
  topicId: number;
  title: string;
  categoryId: number;
  url: string;
  understanding: Understanding;
  evidence: Evidence[];
  /** What the thread looked like when we read it — so a reading against a
   *  12-post thread is not mistaken for one against 60 later. */
  postsSeen: number;
  postsTotal: number;
  truncated: boolean;
  /** Free arithmetic over the reading, not a second model call. */
  wouldRepeat: boolean;
  promptVersion: string;
  model: string;
  runId: string;
}

/**
 * Read one topic.
 *
 * Returns the reading, or throws. A single topic failing must not take a run
 * down — the caller catches per topic, for the same reason the stage-one fetch
 * reports a failed board and carries on.
 */
export async function readTopic(
  topic: { id: number; slug: string; title: string; categoryId: number },
  ask: AskModel,
  runId: string,
): Promise<Reading> {
  const raw = await fetchTopicRaw(topic.id, topic.slug);
  const discussion = parseDiscussion(raw);
  if (!discussion || discussion.posts.length === 0) {
    throw new ShopifyReadError('That topic came back with no readable posts.');
  }

  const { content, model } = await ask({
    system: SYSTEM_PROMPT,
    user: buildUnderstandPrompt(renderDiscussion(discussion)),
    temperature: 0.2,
    maxTokens: 1600,
    json: true,
  });

  const understanding = parseUnderstanding(content);

  return {
    topicId: topic.id,
    title: discussion.title || topic.title,
    categoryId: discussion.categoryId || topic.categoryId,
    url: `https://community.shopify.com/t/${discussion.slug || topic.slug}/${topic.id}`,
    understanding,
    // Evidence is chosen from the thread, not from the model's reply: a model
    // that hallucinated a post number cannot invent a quote to go with it.
    evidence: pickEvidence(discussion, understanding),
    postsSeen: discussion.posts.length,
    postsTotal: discussion.postsTotal,
    truncated: discussion.truncated,
    wouldRepeat: wouldRepeat(understanding),
    promptVersion: UNDERSTAND_PROMPT_VERSION,
    model,
    runId,
  };
}

/**
 * The posts worth keeping beside the reading.
 *
 * The opening post always, the accepted answer always, then whatever the
 * analysis actually cited, then the most-liked replies to fill the remainder.
 * A citation the model invented — a post number that is not in the thread — is
 * silently absent rather than fabricated.
 */
function pickEvidence(d: Discussion, u: Understanding): Evidence[] {
  const byNumber = new Map(d.posts.map((p) => [p.postNumber, p]));
  const chosen = new Map<number, Evidence>();

  const add = (n: number) => {
    if (chosen.size >= MAX_EVIDENCE) return;
    const p = byNumber.get(n);
    if (!p || chosen.has(n)) return;
    chosen.set(n, {
      postNumber: p.postNumber,
      username: p.username,
      quote: p.text.length > MAX_QUOTE_CHARS ? `${p.text.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : p.text,
      likeCount: p.likeCount,
      isAcceptedAnswer: p.isAcceptedAnswer,
    });
  };

  const opening = d.posts.find((p) => p.isOriginalPost);
  if (opening) add(opening.postNumber);
  if (d.acceptedAnswerNumber !== null) add(d.acceptedAnswerNumber);
  for (const o of u.offered) add(o.postNumber);
  for (const p of [...d.posts].sort((a, b) => b.likeCount - a.likeCount)) add(p.postNumber);

  return [...chosen.values()].sort((a, b) => a.postNumber - b.postNumber);
}

/**
 * Store a reading, and mark the topic analysed.
 *
 * ⚠️ ONE DOCUMENT PER TOPIC, REPLACED — not appended. Covers wrote analyses
 * append-only with no deduplication, so a re-run left a second opinion beside
 * the first and the screen showed whichever it read last. Re-reading a topic
 * here overwrites its reading, and the marker on the topic carries the prompt
 * version so an older reading is visibly stale rather than merely old.
 */
export async function saveReading(projectId: string, reading: Reading, nowMs: number): Promise<void> {
  const batch = db().batch();

  batch.set(readings(projectId).doc(String(reading.topicId)), {
    ...reading,
    readAtMs: nowMs,
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.set(
    topics(projectId).doc(String(reading.topicId)),
    {
      analysedAtMs: nowMs,
      analysisPromptVersion: reading.promptVersion,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

export async function listReadings(projectId: string, limit = 100): Promise<Reading[]> {
  const snap = await readings(projectId)
    .orderBy('readAtMs', 'desc')
    .limit(Math.max(1, Math.min(500, limit)))
    .get();
  return snap.docs.map((d) => d.data() as Reading);
}

export async function getReading(projectId: string, topicId: number): Promise<Reading | null> {
  const snap = await readings(projectId).doc(String(topicId)).get();
  return snap.exists ? (snap.data() as Reading) : null;
}

export { isUnreadable };
