import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/server/admin';
import type { Project, RedditModuleConfig } from '@/lib/types';
import type { NormalizedRedditPost, RedditProject, RedditSource } from './types';

// Server-side persistence for the Reddit module.
//
// This is the layer that does not exist in ML Studio. There, the browser writes
// everything with the client SDK — saveFetchedPosts, createAnalysis,
// createDraft all run in the tab, under rules that say
// `allow read, write: if isSignedIn()`. Any user could write any client's data,
// and the API routes held no database credentials at all.
//
// Here writes happen only after a route handler has verified the caller's token
// and checked their permission on this specific project.

const db = () => adminDb();

const project = (projectId: string) => db().collection('projects').doc(projectId);

/** Delete a pile of refs in batches of 450 (Firestore caps a batch at 500). */
async function batchDelete(refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += 450) {
    const batch = db().batch();
    for (const ref of refs.slice(i, i + 450)) batch.delete(ref);
    await batch.commit();
  }
}

// ---------------------------------------------------------------------------
// Prompt adapter
// ---------------------------------------------------------------------------

/**
 * Build the RedditProject shape the prompts expect from Engage's split model.
 *
 * prompts.ts is copied BYTE-IDENTICAL from ML Studio and takes a flat
 * RedditProject. Engage splits that into Project (client identity) plus
 * modules/reddit (platform config). Adapting here — rather than editing
 * prompts.ts — is what keeps the prompt text bit-for-bit identical, which is
 * the whole basis of parity testing: same prompt in, comparable analysis out.
 */
export function toRedditProject(p: Project, config: RedditModuleConfig): RedditProject {
  return {
    projectId: p.projectId,
    name: p.name,
    websiteUrl: p.clientWebsiteUrl,
    companyDescription: config.companyDescription,
    targetCustomer: config.targetCustomer,
    productService: config.productService,
    targetSubreddits: config.targetSubreddits,
    keywords: config.keywords,
    brandMentionStyle: config.brandMentionStyle,
    forbiddenPhrases: config.forbiddenPhrases,
    status: p.status,
    createdBy: p.createdBy,
    createdByName: p.createdByName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getProject(projectId: string): Promise<Project | null> {
  const snap = await project(projectId).get();
  return snap.exists ? ({ projectId: snap.id, ...snap.data() } as Project) : null;
}

export async function getRedditConfig(projectId: string): Promise<RedditModuleConfig | null> {
  const snap = await project(projectId).collection('modules').doc('reddit').get();
  return snap.exists ? (snap.data() as RedditModuleConfig) : null;
}

export async function listSources(projectId: string): Promise<RedditSource[]> {
  const snap = await project(projectId).collection('sources').get();
  return snap.docs.map((d) => ({ sourceId: d.id, ...d.data() }) as RedditSource);
}

export async function getItem(projectId: string, itemId: string) {
  const snap = await project(projectId).collection('items').doc(itemId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveResult {
  created: number;
  skipped: number;
  total: number;
}

/**
 * Save fetched posts as items.
 *
 * Two behaviours ported deliberately:
 *
 * 1. The deterministic id `${projectId}_${externalId}` — dedupe depends on it,
 *    and so does re-fetch preserving state.
 * 2. Existing docs are NOT overwritten, so processingStatus and isFavorite
 *    survive a re-fetch. isFavorite in particular is a purge-retention flag:
 *    clobbering it back to false would silently make favourited posts eligible
 *    for deletion on the next purge.
 *
 * Improved on ML Studio: it does a getDoc + setDoc per post, serially — 2
 * round-trips each, so ~400 calls for a 200-post fetch. This reads existing ids
 * in ONE query and writes in batches of 500.
 */
export async function saveFetchedItems(
  projectId: string,
  posts: NormalizedRedditPost[],
  createdBy: string,
): Promise<SaveResult> {
  if (posts.length === 0) return { created: 0, skipped: 0, total: 0 };

  const items = project(projectId).collection('items');
  const ids = posts.map((p) => `${projectId}_${p.redditPostId}`);

  // getAll takes the whole set in one round-trip rather than N.
  const existing = await db().getAll(...ids.map((id) => items.doc(id)));
  const present = new Set(existing.filter((d) => d.exists).map((d) => d.id));

  let created = 0;
  let batch = db().batch();
  let pending = 0;

  for (let i = 0; i < posts.length; i++) {
    const id = ids[i];
    if (present.has(id)) continue;

    const p = posts[i];
    batch.set(items.doc(id), {
      itemId: id,
      projectId,
      platform: 'reddit',
      externalId: p.redditPostId,
      subreddit: p.subreddit,
      title: p.title,
      body: p.body,
      author: p.author,
      url: p.url,
      permalink: p.permalink,
      isSelfPost: p.isSelfPost,
      score: p.score,
      numComments: p.numComments,
      createdAtSource: Timestamp.fromMillis(p.createdAtRedditMs),
      fetchedAt: FieldValue.serverTimestamp(),
      processingStatus: 'fetched',
      isFavorite: false,
      createdBy,
    });

    created++;
    pending++;

    // Firestore caps a batch at 500 writes.
    if (pending === 500) {
      await batch.commit();
      batch = db().batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();

  return { created, skipped: posts.length - created, total: posts.length };
}

export async function createAnalysis(
  projectId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const ref = project(projectId).collection('analyses').doc();
  await ref.set({
    analysisId: ref.id,
    projectId,
    platform: 'reddit',
    ...data,
    // No updatedAt: an analysis is immutable. Re-analysing writes a new one, so
    // the record of what the model said at a given prompt version is preserved.
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function createDraft(projectId: string, data: Record<string, unknown>): Promise<string> {
  const ref = project(projectId).collection('drafts').doc();
  await ref.set({
    draftId: ref.id,
    projectId,
    platform: 'reddit',
    status: 'draft',
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function setItemStatus(projectId: string, itemId: string, status: string) {
  await project(projectId).collection('items').doc(itemId).update({ processingStatus: status });
}

/**
 * Favourite / unfavourite a post.
 *
 * isFavorite is a purge-retention flag (see saveFetchedItems): a favourited
 * post survives the clean-history purge. The write is server-only here — in ML
 * Studio the browser called updateDoc directly, under rules that let any signed
 * in user flip any client's flags.
 */
export async function setItemFavorite(projectId: string, itemId: string, isFavorite: boolean) {
  await project(projectId).collection('items').doc(itemId).update({ isFavorite });
}

export async function getDraft(projectId: string, draftId: string) {
  const snap = await project(projectId).collection('drafts').doc(draftId).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Record<string, unknown>) : null;
}

/**
 * Move a draft through its lifecycle: draft -> posted (marked by hand) or
 * draft -> rejected (with optional reviewer notes).
 *
 * 'posted' feeds the ANSWERED ledger the queue reads (a post with a posted
 * draft is answered, and stays answered across re-fetches because posted drafts
 * survive the purge). Marking posted stamps postedAt; this is the MANUAL path —
 * a human copied the reply and posted it themselves — so it carries no account
 * attribution, unlike the agent path which sets postedByAccountId/permalink.
 */
export async function setDraftStatus(
  projectId: string,
  draftId: string,
  status: 'draft' | 'posted' | 'rejected',
  reviewerNotes?: string,
) {
  const patch: Record<string, unknown> = { status, updatedAt: FieldValue.serverTimestamp() };
  if (typeof reviewerNotes === 'string') patch.reviewerNotes = reviewerNotes;
  if (status === 'posted') patch.postedAt = FieldValue.serverTimestamp();
  await project(projectId).collection('drafts').doc(draftId).update(patch);
}

// ---------------------------------------------------------------------------
// Lifecycle: purge, clean, delete
// ---------------------------------------------------------------------------

export interface PurgeResult {
  deletedItems: number;
  deletedAnalyses: number;
  keptFavorites: number;
  keptDrafted: number;
}

/**
 * Keep a project's item list fresh: after a fetch/search, delete every stored
 * item EXCEPT the ones worth keeping —
 *   1. items in `keepItemIds` (this run's fresh result set),
 *   2. favourited items (isFavorite === true),
 *   3. items that already have a draft (a reply was generated for them).
 * Analyses belonging to deleted items go too. Drafts are never touched, and any
 * item a draft points at is kept by rule 3.
 *
 * Ported verbatim from ML Studio's purgeUnkeptPosts, with two things that
 * matter kept intact:
 *   - `onlySubreddits` scopes the candidates, so a run that only refreshed some
 *     subreddits (or where one errored) never deletes another subreddit's items.
 *     The fetch cycle passes only the subreddits that actually returned posts.
 *   - The protections (favourite, has-draft) are evaluated HERE from Firestore,
 *     never from the caller. The client supplies only which ids are fresh and
 *     which subreddits are in scope; it cannot talk the server into deleting a
 *     favourited or answered post.
 */
export async function purgeUnkeptItems(
  projectId: string,
  keepItemIds: string[],
  opts: { onlySubreddits?: string[] } = {},
): Promise<PurgeResult> {
  const scope = opts.onlySubreddits
    ? new Set(opts.onlySubreddits.map((s) => s.replace(/^\/?r\//i, '').toLowerCase()))
    : null;
  if (scope && scope.size === 0) {
    return { deletedItems: 0, deletedAnalyses: 0, keptFavorites: 0, keptDrafted: 0 };
  }

  const proj = project(projectId);
  const [itemsSnap, draftsSnap, analysesSnap] = await Promise.all([
    proj.collection('items').get(),
    proj.collection('drafts').get(),
    proj.collection('analyses').get(),
  ]);

  const draftedItemIds = new Set(draftsSnap.docs.map((d) => d.data().itemId as string));
  const fresh = new Set(keepItemIds);

  let keptFavorites = 0;
  let keptDrafted = 0;
  const toDelete = itemsSnap.docs.filter((d) => {
    const data = d.data();
    // Case-insensitive subreddit match, in memory — items may store a name in
    // any case, and a Firestore equality filter could not normalise it.
    if (scope && !scope.has(String(data.subreddit ?? '').toLowerCase())) return false;
    const isFav = data.isFavorite === true;
    const hasDraft = draftedItemIds.has(d.id);
    const isFresh = fresh.has(d.id);
    // Tally only the extra history retained (not this run's own batch), so the
    // numbers read as "kept N favourites + M answered" rather than the batch size.
    if (!isFresh && isFav) keptFavorites++;
    if (!isFresh && !isFav && hasDraft) keptDrafted++;
    return !isFav && !hasDraft && !isFresh;
  });

  const deleteIds = new Set(toDelete.map((d) => d.id));
  const analysesToDelete = analysesSnap.docs.filter((d) => deleteIds.has(d.data().itemId as string));

  await batchDelete([...toDelete.map((d) => d.ref), ...analysesToDelete.map((d) => d.ref)]);

  return {
    deletedItems: toDelete.length,
    deletedAnalyses: analysesToDelete.length,
    keptFavorites,
    keptDrafted,
  };
}

export interface CleanResult {
  items: number;
  analyses: number;
  drafts: number;
  postedDraftsKept: number;
}

/**
 * Clear a project's fetched items and analyses, and any draft that was NOT
 * marked posted. Keeps the project, its Reddit config, knowledge sources,
 * members, and drafts with status 'posted' — the ANSWERED ledger, which lets a
 * re-fetched post still show as answered. Ported from cleanupProjectHistory.
 */
export async function cleanProjectHistory(projectId: string): Promise<CleanResult> {
  const proj = project(projectId);
  const [itemsSnap, analysesSnap, draftsSnap] = await Promise.all([
    proj.collection('items').get(),
    proj.collection('analyses').get(),
    proj.collection('drafts').get(),
  ]);

  const nonPosted = draftsSnap.docs.filter((d) => d.data().status !== 'posted');

  await batchDelete([
    ...itemsSnap.docs.map((d) => d.ref),
    ...analysesSnap.docs.map((d) => d.ref),
    ...nonPosted.map((d) => d.ref),
  ]);

  return {
    items: itemsSnap.size,
    analyses: analysesSnap.size,
    drafts: nonPosted.length,
    postedDraftsKept: draftsSnap.size - nonPosted.length,
  };
}

export interface DeleteResult {
  sources: number;
  items: number;
  analyses: number;
  drafts: number;
  members: number;
}

/**
 * Delete a project and everything under it.
 *
 * Engage nests all of a client's data under projects/{id}/ (members, modules,
 * sources, items, analyses, drafts), so one recursiveDelete removes the entire
 * subtree — no orphans. This closes the ML Studio defect where
 * deleteProjectCascade left drafts and jobs behind. Counts are gathered first
 * for the audit log. (Top-level jobs/accounts are not per-project and untouched.)
 */
export async function deleteProjectDeep(projectId: string): Promise<DeleteResult> {
  const proj = project(projectId);
  const [sources, items, analyses, drafts, members] = await Promise.all([
    proj.collection('sources').count().get(),
    proj.collection('items').count().get(),
    proj.collection('analyses').count().get(),
    proj.collection('drafts').count().get(),
    proj.collection('members').count().get(),
  ]);

  await db().recursiveDelete(proj);

  return {
    sources: sources.data().count,
    items: items.data().count,
    analyses: analyses.data().count,
    drafts: drafts.data().count,
    members: members.data().count,
  };
}
