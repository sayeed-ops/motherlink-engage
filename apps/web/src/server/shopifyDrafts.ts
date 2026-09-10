import 'server-only';

// Writing a reply for one thread, in one mode.
//
// ════════════════════════════════════════════════════════════════════════════
// ONE THREAD, ONE MODE, ONE CALL — CHOSEN BY A PERSON
//
// No batch, no ranking, no "draft everything that qualified". Covers had that
// and the operator's verdict was that pressing Draft could not say what it was
// about to work on. The row carries the button; the button carries the mode.
//
// ⚠️ NOTHING HERE POSTS. There is no job kind for this platform, no queue, and
// no writing code in the tree. A draft is text a person copies — the status
// enum stops at `approved` for the same reason Covers' did.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { listSources } from '@/modules/reddit/store';
import { findForbidden, type ShopifyClientProfile } from '@/modules/shopify/client';
import {
  availableModes,
  buildReplyPrompt,
  isEmpty,
  parseReply,
  REPLY_PROMPT_VERSION,
  SYSTEM_BY_MODE,
  type PromptSource,
  type ReplyDraft,
  type ReplyMode,
} from '@/modules/shopify/reply';
import type { Understanding } from '@/modules/shopify/understand';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);
const drafts = (projectId: string) => project(projectId).collection('shopifyDrafts');

export type AskModel = (input: {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: boolean;
}) => Promise<{ content: string; model: string }>;

/**
 * Which knowledge sources speak to this thread.
 *
 * ⚠️ FREE, AND DELIBERATELY NOT A MODEL CALL. Reddit hands every source to the
 * analyser and lets it choose; that works because a Reddit run analyses one
 * post at a time with a small library. Here the same question is answered by
 * word overlap first, so the expensive call sees a shortlist rather than the
 * whole store — and so the BRAND GATE can be evaluated before deciding whether
 * to spend anything at all.
 *
 * Overlap is measured against the thread's own words: the concern the reading
 * produced, plus the concepts the room raised. Matching on the title alone
 * would miss a thread whose subject only becomes clear in the replies.
 */
export function matchSources(
  sources: readonly PromptSource[],
  haystack: string,
  limit = 6,
): PromptSource[] {
  const hay = ` ${haystack.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

  const scored = sources.map((s) => {
    // Terms come from the fields a person wrote to describe when the source
    // applies — not from its summary, which is prose and matches everything.
    const terms = [s.title, ...s.keyPoints, ...s.answerAngles]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t));

    const unique = [...new Set(terms)];
    const hits = unique.filter((t) => hay.includes(` ${t} `)).length;
    // Normalised, or a source with fifty key points wins every thread by
    // volume rather than by fit.
    return { source: s, score: unique.length ? hits / Math.sqrt(unique.length) : 0, hits };
  });

  return scored
    .filter((s) => s.hits >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.source);
}

const STOPWORDS = new Set([
  'this','that','with','from','your','have','they','what','when','which','their','there','about','would',
  'could','should','other','than','then','them','were','been','being','into','more','most','some','such',
  'only','also','very','just','like','over','after','before','because','while','where','both','each',
  'shopify','store','stores','product','products','page','pages','customer','customers','help','need',
]);

export interface DraftRequest {
  topicId: number;
  title: string;
  url: string;
  categoryId: number;
  mode: ReplyMode;
  discussion: string;
  understanding: Understanding;
  client: ShopifyClientProfile;
  targetWords: number;
}

export interface StoredDraft extends ReplyDraft {
  draftId: string;
  topicId: number;
  title: string;
  url: string;
  categoryId: number;
  /** Phrases the client forbade that appeared anyway. Non-empty is not a
   *  failure to hide — it is the single most important thing on the review
   *  screen, and the draft is stored WITH it rather than discarded. */
  forbiddenHits: string[];
  status: 'pending' | 'approved' | 'rejected';
  promptVersion: string;
  model: string;
  createdAtMs: number;
}

export class NoModeAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoModeAvailableError';
  }
}

/** Every source this project holds, in prompt shape. Reads the SAME
 *  project-level collection Reddit fills — one client, one knowledge base. */
export async function loadSources(projectId: string): Promise<PromptSource[]> {
  const rows = await listSources(projectId);
  return rows.map((r) => {
    const s = r as unknown as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      sourceId: String(s.sourceId ?? ''),
      title: String(s.title ?? ''),
      summary: String(s.summary ?? ''),
      keyPoints: arr(s.keyPoints),
      answerAngles: arr(s.answerAngles),
    };
  });
}

/**
 * Write one reply.
 *
 * The mode is checked against what is actually possible before anything is
 * spent: asking for `brand` on a thread no source speaks to is a 400, not a
 * reply that names the client on no evidence.
 */
export async function writeReply(
  req: DraftRequest,
  sources: readonly PromptSource[],
  ask: AskModel,
): Promise<StoredDraft> {
  const hasClientProfile = req.client.companyDescription.trim().length > 0;
  const matched = req.mode === 'open' ? [] : matchSources(sources, `${req.title} ${req.understanding.concern} ${req.understanding.alreadySaid.join(' ')}`);

  const allowed = availableModes({
    hasClientProfile,
    matchedSourceCount: matched.length,
    understanding: req.understanding,
  });

  if (!allowed.includes(req.mode)) {
    throw new NoModeAvailableError(
      req.mode === 'brand'
        ? 'No knowledge source speaks to this thread, so a reply here cannot name the client. Add a source, or use Open or Growth.'
        : 'This project has no client description yet. Fill in Client details, or use Open — it needs nothing.',
    );
  }

  const { content, model } = await ask({
    system: SYSTEM_BY_MODE[req.mode],
    user: buildReplyPrompt({
      mode: req.mode,
      title: req.title,
      discussion: req.discussion,
      understanding: req.understanding,
      client: req.mode === 'open' ? undefined : req.client,
      sources: req.mode === 'open' ? undefined : matched,
      targetWords: req.targetWords,
    }),
    // Warmer than analysis: this is writing, and a reply at temperature 0.2
    // reads like a template. Still low enough not to invent.
    temperature: 0.6,
    maxTokens: 1400,
    json: true,
  });

  const draft = parseReply(content, req.mode);

  return {
    ...draft,
    // A model may echo an id it was never given. Filtered against what it was
    // actually handed, so a citation always points at a real source.
    usedSourceIds: draft.usedSourceIds.filter((id) => matched.some((m) => m.sourceId === id)),
    draftId: db().collection('_').doc().id,
    topicId: req.topicId,
    title: req.title,
    url: req.url,
    categoryId: req.categoryId,
    // ⚠️ CHECKED, NOT TRUSTED TO THE PROMPT. The forbidden list is in the
    // prompt as well, but an instruction is a request and this is the rule.
    forbiddenHits: findForbidden(draft.text, req.client.forbiddenPhrases),
    status: 'pending',
    promptVersion: REPLY_PROMPT_VERSION,
    model,
    createdAtMs: Date.now(),
  };
}

/** One document per draft, appended — a thread may legitimately have an Open
 *  and a Brand draft side by side, and comparing them is the point. */
export async function saveDraft(projectId: string, draft: StoredDraft): Promise<void> {
  await drafts(projectId).doc(draft.draftId).set({ ...draft, updatedAt: FieldValue.serverTimestamp() });
}

export async function listDrafts(projectId: string, limit = 100): Promise<StoredDraft[]> {
  const snap = await drafts(projectId)
    .orderBy('createdAtMs', 'desc')
    .limit(Math.max(1, Math.min(500, limit)))
    .get();
  return snap.docs.map((d) => d.data() as StoredDraft);
}

export async function decideDraft(
  projectId: string,
  draftId: string,
  status: 'approved' | 'rejected',
  uid: string,
): Promise<void> {
  await drafts(projectId).doc(draftId).set(
    { status, decidedBy: uid, decidedAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export { isEmpty };
