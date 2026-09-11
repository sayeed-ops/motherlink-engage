import 'server-only';

// Writing a reply for one thread, in one mode.
//
// ════════════════════════════════════════════════════════════════════════════
// ONE THREAD, ONE MODE, ONE CALL — CHOSEN BY A PERSON. THE REPLIES ARE READ HERE.
//
// No batch, no ranking, no "draft everything that qualified". The row carries
// the button; the button carries the mode. This is the first call that sees
// the replies — the analysis read only the question — and it reports what they
// say (the digest) in the same answer as the reply it writes.
//
// ⚠️ NOTHING HERE POSTS. There is no job kind for this platform, no queue, and
// no writing code in the tree. A draft is text a person copies.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { findForbidden, type ShopifyClientProfile } from '@/modules/shopify/client';
import { matchSources, type PromptSource } from '@/modules/shopify/knowledge';
import type { Assessment } from '@/modules/shopify/assess';
import {
  availableModes,
  buildReplyPrompt,
  isEmpty,
  parseReply,
  REPLY_PROMPT_VERSION,
  SYSTEM_BY_MODE,
  type ReplyDraft,
  type ReplyMode,
} from '@/modules/shopify/reply';
import type { AskModel } from './shopifyAnalysis';

const db = () => adminDb();
const drafts = (projectId: string) => db().collection('projects').doc(projectId).collection('shopifyDrafts');

/** Most sources a Brand or Growth prompt is handed. A shortlist, never the list. */
const MAX_PROMPT_SOURCES = 6;

export interface DraftRequest {
  topicId: number;
  title: string;
  url: string;
  categoryId: number;
  mode: ReplyMode;
  /** The whole conversation, rendered and budgeted. */
  discussion: string;
  assessment: Assessment;
  /** The sources the analysis judged Brand on. */
  assessedSourceIds: readonly string[];
  client: ShopifyClientProfile;
  targetWords: number;
}

export interface StoredDraft extends ReplyDraft {
  draftId: string;
  topicId: number;
  title: string;
  url: string;
  categoryId: number;
  /** Phrases the client forbade that appeared anyway. Stored WITH the draft
   *  and shown first — never used to discard it silently. */
  forbiddenHits: string[];
  status: 'pending' | 'approved' | 'rejected';
  promptVersion: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAtMs: number;
}

export class NoModeAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoModeAvailableError';
  }
}

/**
 * The sources a Growth or Brand reply may draw on.
 *
 * The ones the analysis judged Brand on come first — that is what the score
 * was about — and then whatever the free matcher finds against the analysis's
 * own reading of the question, so a source added since the analysis still
 * counts. Ids that no longer exist (a source deleted since) simply drop out.
 */
export function supportingSources(
  held: readonly PromptSource[],
  assessedIds: readonly string[],
  haystack: string,
): PromptSource[] {
  const byId = new Map(held.map((s) => [s.sourceId, s]));
  const chosen = new Map<string, PromptSource>();
  for (const id of assessedIds) {
    const s = byId.get(id);
    if (s) chosen.set(id, s);
  }
  for (const s of matchSources(held, haystack, MAX_PROMPT_SOURCES)) {
    if (chosen.size >= MAX_PROMPT_SOURCES) break;
    chosen.set(s.sourceId, s);
  }
  return [...chosen.values()].slice(0, MAX_PROMPT_SOURCES);
}

/**
 * Write one reply.
 *
 * The mode is checked against what is actually possible before anything is
 * spent: asking for `brand` on a thread no source speaks to is a 400, not a
 * reply that names the client on no evidence.
 */
export async function writeReply(req: DraftRequest, held: readonly PromptSource[], ask: AskModel): Promise<StoredDraft> {
  const a = req.assessment;
  const sources =
    req.mode === 'open' ? [] : supportingSources(held, req.assessedSourceIds, `${req.title} ${a.question} ${a.needs}`);

  const allowed = availableModes({ client: req.client, supportingSourceCount: sources.length });
  if (!allowed.includes(req.mode)) {
    throw new NoModeAvailableError(
      req.mode === 'brand'
        ? req.client.companyDescription.trim() && req.client.productService.trim()
          ? 'No knowledge source speaks to this thread, so a reply here cannot name the client. Add a source on the Knowledge tab, or use Open or Growth.'
          : 'A reply may only name the client once "What the company does" and "What they sell" are filled in on Client details.'
        : 'This project has no client description yet. Fill in Client details, or use Open — it needs nothing.',
    );
  }

  const { content, model, usage } = await ask({
    system: SYSTEM_BY_MODE[req.mode],
    user: buildReplyPrompt({
      mode: req.mode,
      title: req.title,
      discussion: req.discussion,
      assessment: a,
      client: req.mode === 'open' ? undefined : req.client,
      sources: req.mode === 'open' ? undefined : sources,
      targetWords: req.targetWords,
    }),
    // Warmer than analysis: this is writing, and a reply at 0.2 reads like a
    // template. Still low enough not to invent.
    temperature: 0.6,
    // The digest of the replies comes back in the same answer as the reply.
    maxTokens: 2200,
    json: true,
  });

  const draft = parseReply(content, req.mode);

  return {
    ...draft,
    // A model may echo an id it was never given. Filtered against what it was
    // actually handed, so a citation always points at a real source.
    usedSourceIds: draft.usedSourceIds.filter((id) => sources.some((s) => s.sourceId === id)),
    draftId: db().collection('_').doc().id,
    topicId: req.topicId,
    title: req.title,
    url: req.url,
    categoryId: req.categoryId,
    // ⚠️ CHECKED, NOT TRUSTED TO THE PROMPT. An instruction is a request; this
    // is the rule.
    forbiddenHits: findForbidden(draft.text, req.client.forbiddenPhrases),
    status: 'pending',
    promptVersion: REPLY_PROMPT_VERSION,
    model,
    usage: usage ?? null,
    createdAtMs: Date.now(),
  };
}

/** One document per draft, appended — a thread may carry an Open and a Brand
 *  draft side by side, and comparing them is the point. */
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
