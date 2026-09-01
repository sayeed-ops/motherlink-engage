import 'server-only';

// Wiping Covers knowledge so a test can start from zero — and nothing else.
//
// ════════════════════════════════════════════════════════════════════════════
// EVERY DELETE IS A POSITIVE MATCH. NOTHING IS DELETED BY EXCLUSION.
//
// `items`, `analyses`, `drafts`, `draftFeedback` and `outcomes` are SHARED
// collections holding both platforms' documents, discriminated by a `platform`
// field. The only safe query is `where('platform','==','covers')`.
//
// "Delete everything that is not Reddit" is the shape of this mistake, and it is
// unavailable twice over: Firestore cannot match a MISSING field with `!=`, so
// any legacy document written before the discriminator existed would be invisible
// to the filter and swept up by a client-side "not reddit" test. A positive match
// cannot make that error — a document without `platform: 'covers'` is simply not
// selected, whatever else is true about it.
//
// The collections that are Covers-only (`assets`, `claims`, `discoveries`,
// `interview`) carry no discriminator because nothing else has ever written to
// them — verified: no file under modules/reddit or app/api/.../reddit imports
// the knowledge module, and tests/unit/redditFrozen.test.mjs fails if that
// changes.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT IS NEVER DELETED, AND WHY EACH ONE MATTERS
//
//   harvested items + posts   reading Covers costs somebody else's bandwidth and
//                             the conversation map is rebuilt from them
//   the conversation map      it describes the AUDIENCE, not the client; swapping
//                             clients changes nothing about it (own checkbox,
//                             defaulted off)
//   modules/covers config     section roles are an operator decision about the
//                             forum, not client knowledge
//   policy/covers             jurisdictions and disclosure come from a licence
//                             and counsel, and re-confirming them is not free
//   everything Reddit         sources, items, drafts, analyses, config
// ════════════════════════════════════════════════════════════════════════════

import { adminDb } from './admin';
import type { Query } from 'firebase-admin/firestore';

const project = (projectId: string) => adminDb().collection('projects').doc(projectId);

/** The three independent scopes. Separate so one default cannot over-delete. */
export interface ResetScope {
  /** assets, claims, discoveries, the interview and its questions. */
  clientKnowledge: boolean;
  /** analyses, drafts, draftFeedback, outcomes — Covers rows only. */
  pipelineOutput: boolean;
  /** The conversation map. DEFAULTS OFF everywhere — see the header. */
  conversationMap: boolean;
}

export const DEFAULT_SCOPE: ResetScope = {
  clientKnowledge: true,
  pipelineOutput: true,
  conversationMap: false,
};

export function normaliseScope(raw: unknown): ResetScope {
  const o = (raw ?? {}) as Partial<ResetScope>;
  return {
    clientKnowledge: o.clientKnowledge !== false,
    pipelineOutput: o.pipelineOutput !== false,
    // The one that must be asked for explicitly rather than defaulted in.
    conversationMap: o.conversationMap === true,
  };
}

export interface ResetPreview {
  /** The project's own name — the confirmation phrase. Returned so the screen
   *  can SHOW what to type rather than asking for something the reader has to
   *  go and find. */
  projectName: string;
  /** What this reset would delete, by collection. */
  deleting: { label: string; collection: string; count: number }[];
  /**
   * What it leaves alone, counted.
   *
   * ⚠️ SHOWN NEXT TO THE DELETIONS, NOT IN A FOOTNOTE. The fear a destructive
   * action has to answer is "will this touch Reddit", and the only convincing
   * answer is the Reddit numbers on the same screen, before confirmation and
   * again after.
   */
  preserving: { label: string; collection: string; count: number }[];
  totalDeleting: number;
}

const countOf = async (q: Query): Promise<number> => (await q.count().get()).data().count;

/** Covers rows in a collection shared with Reddit. Positive match, always. */
const coversIn = (projectId: string, name: string): Query =>
  project(projectId).collection(name).where('platform', '==', 'covers');

const redditIn = (projectId: string, name: string): Query =>
  project(projectId).collection(name).where('platform', '==', 'reddit');

export async function previewCoversReset(
  projectId: string,
  scope: ResetScope,
): Promise<ResetPreview> {
  const p = project(projectId);
  const projectName = String((await p.get()).data()?.name ?? '');

  const [assets, claims, discoveries, questions, interview] = await Promise.all([
    countOf(p.collection('assets')),
    countOf(p.collection('claims')),
    countOf(p.collection('discoveries')),
    countOf(p.collection('interview').doc('current').collection('questions')),
    p.collection('interview').doc('current').get().then((d) => (d.exists ? 1 : 0)),
  ]);

  const [analyses, drafts, feedback, outcomes] = await Promise.all([
    countOf(coversIn(projectId, 'analyses')),
    countOf(coversIn(projectId, 'drafts')),
    countOf(coversIn(projectId, 'draftFeedback')),
    countOf(coversIn(projectId, 'outcomes')),
  ]);

  const [map, coversItems, sources, redditItems, redditDrafts, redditAnalyses] = await Promise.all([
    p.collection('modules').doc('coversMap').get().then((d) => (d.exists ? 1 : 0)),
    countOf(coversIn(projectId, 'items')),
    countOf(p.collection('sources')),
    countOf(redditIn(projectId, 'items')),
    countOf(redditIn(projectId, 'drafts')),
    countOf(redditIn(projectId, 'analyses')),
  ]);

  const deleting: ResetPreview['deleting'] = [];

  if (scope.clientKnowledge) {
    deleting.push(
      { label: 'Client assets', collection: 'assets', count: assets },
      { label: 'Verified claims', collection: 'claims', count: claims },
      { label: 'Discovered pages', collection: 'discoveries', count: discoveries },
      { label: 'Interview', collection: 'interview/current', count: interview },
      { label: 'Interview questions', collection: 'interview/current/questions', count: questions },
    );
  }

  if (scope.pipelineOutput) {
    deleting.push(
      { label: 'Covers analyses', collection: 'analyses (platform=covers)', count: analyses },
      { label: 'Covers drafts', collection: 'drafts (platform=covers)', count: drafts },
      { label: 'Covers review feedback', collection: 'draftFeedback (platform=covers)', count: feedback },
      { label: 'Covers outcomes', collection: 'outcomes (platform=covers)', count: outcomes },
    );
  }

  if (scope.conversationMap) {
    deleting.push({ label: 'Conversation map', collection: 'modules/coversMap', count: map });
  }

  const preserving: ResetPreview['preserving'] = [
    { label: 'Harvested Covers threads', collection: 'items (platform=covers)', count: coversItems },
    ...(scope.conversationMap
      ? []
      : [{ label: 'Conversation map', collection: 'modules/coversMap', count: map }]),
    { label: 'Reddit knowledge sources', collection: 'sources', count: sources },
    { label: 'Reddit items', collection: 'items (platform=reddit)', count: redditItems },
    { label: 'Reddit drafts', collection: 'drafts (platform=reddit)', count: redditDrafts },
    { label: 'Reddit analyses', collection: 'analyses (platform=reddit)', count: redditAnalyses },
  ];

  return {
    projectName,
    deleting,
    preserving,
    totalDeleting: deleting.reduce((a, d) => a + d.count, 0),
  };
}

/**
 * Delete a query's documents in batches.
 *
 * Paged rather than read-all-then-delete: an `analyses` collection runs to
 * thousands of documents and holding them all in memory to delete them is a
 * failure mode that only appears on the biggest project, which is the one that
 * can least afford it.
 */
async function deleteQuery(q: Query, pageSize = 300): Promise<number> {
  let removed = 0;

  for (;;) {
    const snap = await q.limit(pageSize).get();
    if (snap.empty) return removed;

    const batch = adminDb().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();

    removed += snap.size;
    if (snap.size < pageSize) return removed;
  }
}

/**
 * Delete an asset's `snapshot` subcollection before the asset itself.
 *
 * Firestore does not cascade. Deleting the parent leaves the subcollection
 * orphaned and invisible — it does not error, it just quietly keeps the client's
 * help-centre text in the database after a reset that reported success.
 */
async function deleteAssetsWithSnapshots(projectId: string): Promise<number> {
  const assets = project(projectId).collection('assets');
  let removed = 0;

  for (;;) {
    const snap = await assets.limit(100).get();
    if (snap.empty) return removed;

    for (const doc of snap.docs) {
      await deleteQuery(doc.ref.collection('snapshot'));
    }

    const batch = adminDb().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();

    removed += snap.size;
    if (snap.size < 100) return removed;
  }
}

export interface ResetResult {
  deleted: Record<string, number>;
  /** Re-counted AFTER the delete, so "Reddit untouched" is an observation rather
   *  than a promise. */
  redditAfter: { sources: number; items: number; drafts: number; analyses: number };
}

export async function executeCoversReset(
  projectId: string,
  scope: ResetScope,
): Promise<ResetResult> {
  const p = project(projectId);
  const deleted: Record<string, number> = {};

  if (scope.clientKnowledge) {
    deleted.assets = await deleteAssetsWithSnapshots(projectId);
    deleted.claims = await deleteQuery(p.collection('claims'));
    deleted.discoveries = await deleteQuery(p.collection('discoveries'));
    deleted.interviewQuestions = await deleteQuery(
      p.collection('interview').doc('current').collection('questions'),
    );
    const interview = p.collection('interview').doc('current');
    if ((await interview.get()).exists) {
      await interview.delete();
      deleted.interview = 1;
    } else {
      deleted.interview = 0;
    }
  }

  if (scope.pipelineOutput) {
    deleted.analyses = await deleteQuery(coversIn(projectId, 'analyses'));
    deleted.drafts = await deleteQuery(coversIn(projectId, 'drafts'));
    deleted.draftFeedback = await deleteQuery(coversIn(projectId, 'draftFeedback'));
    deleted.outcomes = await deleteQuery(coversIn(projectId, 'outcomes'));
  }

  if (scope.conversationMap) {
    const ref = p.collection('modules').doc('coversMap');
    if ((await ref.get()).exists) {
      await ref.delete();
      deleted.conversationMap = 1;
    } else {
      deleted.conversationMap = 0;
    }
  }

  const [sources, items, drafts, analyses] = await Promise.all([
    countOf(p.collection('sources')),
    countOf(redditIn(projectId, 'items')),
    countOf(redditIn(projectId, 'drafts')),
    countOf(redditIn(projectId, 'analyses')),
  ]);

  return { deleted, redditAfter: { sources, items, drafts, analyses } };
}
