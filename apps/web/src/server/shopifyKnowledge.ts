import 'server-only';

// Shopify's own knowledge list — `projects/{id}/shopifySources`.
//
// The decisions are in modules/shopify/knowledge.ts; this file stores them.
// Reads are ONE collection get: the list is tens of documents, and the screen,
// the analysis and the draft all want the whole of it.

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { listSources as listRedditSources } from '@/modules/reddit/store';
import {
  planCopyFromReddit,
  planImport,
  type CopyPlan,
  type RedditSourceLike,
  type ShopifySource,
  type SourceInput,
  type SourceOrigin,
} from '@/modules/shopify/knowledge';

const db = () => adminDb();
const col = (projectId: string) => db().collection('projects').doc(projectId).collection('shopifySources');

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function toSource(id: string, d: FirebaseFirestore.DocumentData): ShopifySource {
  return {
    sourceId: id,
    type: d.type === 'pasted_text' ? 'pasted_text' : 'url',
    title: String(d.title ?? ''),
    url: typeof d.url === 'string' && d.url ? d.url : null,
    summary: String(d.summary ?? ''),
    keyPoints: strings(d.keyPoints),
    answerAngles: strings(d.answerAngles),
    relatedProblems: strings(d.relatedProblems),
    origin: d.origin === 'json' || d.origin === 'reddit' ? d.origin : 'manual',
    copiedFromSourceId: typeof d.copiedFromSourceId === 'string' ? d.copiedFromSourceId : null,
    createdAtMs: Number(d.createdAtMs) || 0,
    updatedAtMs: Number(d.updatedAtMs) || 0,
    editedAtMs: typeof d.editedAtMs === 'number' ? d.editedAtMs : null,
  };
}

export async function listShopifySources(projectId: string): Promise<ShopifySource[]> {
  const snap = await col(projectId).get();
  return snap.docs.map((d) => toSource(d.id, d.data())).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** Firestore rejects a batch over 500 writes; an import is capped at 100. */
async function writeAll(
  projectId: string,
  rows: readonly (SourceInput & { copiedFromSourceId?: string | null })[],
  origin: SourceOrigin,
  uid: string,
): Promise<number> {
  if (!rows.length) return 0;
  const batch = db().batch();
  const now = Date.now();
  rows.forEach((row, i) => {
    const ref = col(projectId).doc();
    batch.set(ref, {
      ...row,
      sourceId: ref.id,
      origin,
      copiedFromSourceId: row.copiedFromSourceId ?? null,
      editedAtMs: null,
      // +i keeps an import's order stable on a list sorted by creation time.
      createdAtMs: now + i,
      updatedAtMs: now + i,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  return rows.length;
}

export interface AddResult {
  created: number;
  duplicates: string[];
}

/**
 * Add sources, by hand or from pasted JSON.
 *
 * One request and one batch for an import, where Reddit's screen loops a POST
 * per row from the browser: a paste of forty that fails at row twenty-one then
 * leaves twenty imported and nothing saying which. A batch is all or nothing.
 */
export async function addShopifySources(
  projectId: string,
  rows: readonly SourceInput[],
  origin: 'manual' | 'json',
  uid: string,
): Promise<AddResult> {
  const plan = planImport(rows, await listShopifySources(projectId));
  const created = await writeAll(projectId, plan.toAdd, origin, uid);
  return { created, duplicates: plan.duplicates };
}

export class SourceNotFoundError extends Error {}

export async function updateShopifySource(projectId: string, sourceId: string, input: SourceInput): Promise<ShopifySource> {
  const ref = col(projectId).doc(sourceId);
  const snap = await ref.get();
  if (!snap.exists) throw new SourceNotFoundError('That source is not held.');
  const now = Date.now();
  // `origin` and `copiedFromSourceId` survive an edit on purpose — the second
  // is what stops the next Copy from Reddit bringing the original back.
  await ref.set({ ...input, updatedAtMs: now, editedAtMs: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return toSource(sourceId, { ...snap.data(), ...input, updatedAtMs: now, editedAtMs: now });
}

export async function deleteShopifySource(projectId: string, sourceId: string): Promise<void> {
  // Drafts keep the id in `usedSourceIds`. Intentional, as on Reddit: a draft
  // records what the model was given, and deleting the source must not rewrite
  // what an old draft was based on.
  await col(projectId).doc(sourceId).delete();
}

export interface CopyResult extends Omit<CopyPlan, 'toAdd'> {
  added: number;
  redditTotal: number;
}

/** Copy Reddit's sources across — adding what is missing, touching nothing held. */
export async function copySourcesFromReddit(projectId: string, uid: string): Promise<CopyResult> {
  const [reddit, existing] = await Promise.all([listRedditSources(projectId), listShopifySources(projectId)]);
  const plan = planCopyFromReddit(reddit as unknown as RedditSourceLike[], existing);
  const added = await writeAll(projectId, plan.toAdd, 'reddit', uid);
  return { added, alreadyHeld: plan.alreadyHeld, unusable: plan.unusable, redditTotal: reddit.length };
}
