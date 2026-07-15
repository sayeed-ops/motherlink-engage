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
