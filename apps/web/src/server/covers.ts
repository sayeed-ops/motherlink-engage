import 'server-only';

// Persisting a Covers harvest.
//
// Everything that DECIDES anything is pure and lives in modules/covers: what the
// HTML says (parse), what a post is about (entities), what a stored thread looks
// like (items), what the settings mean (config). This file reads and writes
// Firestore and nothing else — the same split as server/knowledge.ts and
// server/commentKarma.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// A RE-HARVEST MUST NOT UNDO A PERSON
//
// Items are keyed deterministically (`{projectId}_covers_{threadId}`) so reading
// a section twice yields one item, exactly as the Reddit path does. The rule
// borrowed with it is the important one: an existing item is NEVER overwritten
// wholesale, because `processingStatus` and `isFavorite` are decisions somebody
// made and `isFavorite` is a purge-retention flag — clobbering it back to false
// silently makes a kept thread eligible for deletion.
//
// What a re-harvest may update is the volatile half: reply and view counts, the
// last post time, the page count, and the entity roll-up. Those are measurements
// of the thread, not opinions about it.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { mergeEntities, type CoversEntities } from '@/modules/covers/entities';
import type { BuiltItem, CoversItemRecord, CoversPostRecord } from '@/modules/covers/items';
import {
  defaultCoversConfig,
  normaliseCoversConfig,
  type CoversModuleConfig,
} from '@/modules/covers/config';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);
const items = (projectId: string) => project(projectId).collection('items');

/** A thread-level line list is a summary, not a ledger — the per-post entities
 *  hold every quote. Without a cap it grows forever across re-harvests. */
const MAX_THREAD_LINES = 50;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getCoversConfig(projectId: string): Promise<CoversModuleConfig> {
  const snap = await project(projectId).collection('modules').doc('covers').get();
  // Absent means the shipped defaults, not an error. A project that has never
  // opened the screen can still be harvested from with sane roles already set.
  return snap.exists ? normaliseCoversConfig(snap.data()) : defaultCoversConfig();
}

/**
 * The rhythm of one section, measured at harvest time from EVERY listed thread.
 *
 * Stored rather than recomputed, because the sixty rows a listing gives are
 * thrown away after the harvest keeps the handful it opened — and a median taken
 * from four opened threads is not a measurement of a section. Written per
 * section, so a fast board and a slow one do not share a number.
 */
export async function saveSectionPace(projectId: string, section: string, paceMs: number | null): Promise<void> {
  if (paceMs === null) return;
  await project(projectId)
    .collection('modules')
    .doc('coversPace')
    .set({ [section]: { paceMs, measuredAt: FieldValue.serverTimestamp() } }, { merge: true });
}

export async function getSectionPace(projectId: string, section: string): Promise<number | null> {
  const snap = await project(projectId).collection('modules').doc('coversPace').get();
  const row = snap.data()?.[section] as { paceMs?: number } | undefined;
  const pace = row?.paceMs;
  return typeof pace === 'number' && pace > 0 ? pace : null;
}

export async function saveCoversConfig(
  projectId: string,
  raw: unknown,
  uid: string,
): Promise<CoversModuleConfig> {
  const config = normaliseCoversConfig(raw);
  await project(projectId)
    .collection('modules')
    .doc('covers')
    .set(
      { ...config, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      { merge: true },
    );
  return config;
}

// ---------------------------------------------------------------------------
// Writing a harvest
// ---------------------------------------------------------------------------

export interface SaveHarvestResult {
  itemsCreated: number;
  itemsUpdated: number;
  postsCreated: number;
  postsAlreadyHeld: number;
}

/**
 * Store what a harvest read.
 *
 * Posts are create-if-absent for the same reason items are: a post already held
 * may carry analysis state later, and re-reading page one of a thread must not
 * rewrite it. New posts — page five, or replies since the last read — are added
 * beside them, which is what makes the subcollection worth having.
 */
export async function saveHarvest(
  projectId: string,
  built: readonly BuiltItem[],
  createdBy: string,
): Promise<SaveHarvestResult> {
  const result: SaveHarvestResult = {
    itemsCreated: 0,
    itemsUpdated: 0,
    postsCreated: 0,
    postsAlreadyHeld: 0,
  };
  if (built.length === 0) return result;

  const refs = built.map((b) => items(projectId).doc(b.item.itemId));
  const existing = await db().getAll(...refs);
  const present = new Map(existing.filter((d) => d.exists).map((d) => [d.id, d.data() ?? {}]));

  for (const [i, entry] of built.entries()) {
    const ref = refs[i];
    const prior = present.get(entry.item.itemId);

    // Existing post ids in one query, so the union size below is a fact rather
    // than an estimate and no post is written twice.
    const heldSnap = await ref.collection('posts').select().get();
    const held = new Set(heldSnap.docs.map((d) => d.id));

    const fresh = entry.posts.filter((p) => !held.has(p.postId));
    result.postsCreated += fresh.length;
    result.postsAlreadyHeld += entry.posts.length - fresh.length;

    let batch = db().batch();
    let pending = 0;
    for (const post of fresh) {
      batch.set(ref.collection('posts').doc(post.postId), postDoc(post));
      if (++pending === 450) {
        await batch.commit();
        batch = db().batch();
        pending = 0;
      }
    }
    if (pending > 0) await batch.commit();

    const postsHeld = held.size + fresh.length;

    if (prior) {
      await ref.update(volatileFields(entry.item, prior, postsHeld));
      result.itemsUpdated++;
    } else {
      await ref.set({ ...itemDoc(entry.item, createdBy), postsHeld });
      result.itemsCreated++;
    }
  }

  return result;
}

function itemDoc(item: CoversItemRecord, createdBy: string): Record<string, unknown> {
  return {
    itemId: item.itemId,
    projectId: item.projectId,
    platform: 'covers',
    externalId: item.externalId,
    section: item.section,
    sport: item.sport,
    title: item.title,
    url: item.url,
    author: item.author,
    // Timestamp for the shared shape every item carries; the ms fields below are
    // arithmetic inputs (the harvest window), not display dates.
    createdAtSource: item.createdAtSourceMs !== null ? Timestamp.fromMillis(item.createdAtSourceMs) : null,
    postsOnSite: item.postsOnSite,
    views: item.views,
    pageCount: item.pageCount,
    firstPostAtMs: item.firstPostAtMs,
    lastPostAtMs: item.lastPostAtMs,
    entities: trimEntities(item.entities),
    fixtureKey: item.fixtureKey,
    fetchedAt: FieldValue.serverTimestamp(),
    lastHarvestedAt: FieldValue.serverTimestamp(),
    processingStatus: 'fetched',
    isFavorite: false,
    createdBy,
  };
}

/**
 * The half of an item a second read may change.
 *
 * `postsOnSite` and `views` are only written when this harvest actually measured
 * them — a thread reached by URL has neither, and writing null over a number
 * read an hour ago would turn a measurement into an absence.
 */
function volatileFields(
  item: CoversItemRecord,
  prior: Record<string, unknown>,
  postsHeld: number,
): Record<string, unknown> {
  const merged = mergeEntities([
    (prior.entities as CoversEntities | undefined) ?? { sport: item.sport, lexicon: false, teams: [], fixture: null, lines: [] },
    item.entities,
  ]);

  // The stored fixture wins, and this read's fills a null. mergeEntities is
  // deliberately conservative — it will not invent a fixture from a thread that
  // has drifted onto other games — so without this line a re-harvest of a game
  // thread whose later posts wander could blank a fixture that was correct.
  const fixture = (prior.entities as CoversEntities | undefined)?.fixture ?? item.entities.fixture ?? merged.fixture;

  const fields: Record<string, unknown> = {
    pageCount: Math.max(item.pageCount, Number(prior.pageCount ?? 0) || 0),
    postsHeld,
    entities: trimEntities({ ...merged, fixture }),
    fixtureKey: fixture?.key ?? null,
    lastHarvestedAt: FieldValue.serverTimestamp(),
  };

  if (item.postsOnSite !== null) fields.postsOnSite = item.postsOnSite;
  if (item.views !== null) fields.views = item.views;
  if (item.lastPostAtMs !== null) {
    fields.lastPostAtMs = Math.max(item.lastPostAtMs, Number(prior.lastPostAtMs ?? 0) || 0);
  }
  if (item.firstPostAtMs !== null && prior.firstPostAtMs == null) {
    fields.firstPostAtMs = item.firstPostAtMs;
  }

  return fields;
}

function trimEntities(e: CoversEntities): CoversEntities {
  return { ...e, lines: e.lines.slice(0, MAX_THREAD_LINES) };
}

function postDoc(post: CoversPostRecord): Record<string, unknown> {
  return {
    postId: post.postId,
    itemId: post.itemId,
    threadId: post.threadId,
    number: post.number,
    page: post.page,
    author: post.author,
    authorId: post.authorId,
    createdAt: post.createdAtMs !== null ? Timestamp.fromMillis(post.createdAtMs) : null,
    createdAtMs: post.createdAtMs,
    body: post.body,
    chars: post.chars,
    entities: post.entities,
    harvestedAt: FieldValue.serverTimestamp(),
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export interface StoredCoversItem {
  itemId: string;
  externalId: string;
  section: string;
  sport: string | null;
  title: string;
  url: string;
  author: string;
  createdAtSourceMs: number | null;
  postsOnSite: number | null;
  views: number | null;
  postsHeld: number;
  pageCount: number;
  firstPostAtMs: number | null;
  lastPostAtMs: number | null;
  entities: CoversEntities;
  fixtureKey: string | null;
  lastHarvestedAtMs: number | null;
}

/**
 * The harvested threads, newest post first.
 *
 * Ordered in memory rather than by Firestore, and deliberately: an orderBy on
 * `lastPostAtMs` with an equality filter on `platform` and `section` needs a
 * composite index per combination, and a harvest is tens of threads. When this
 * becomes thousands, the index is the fix — not a sort that silently truncates.
 */
export async function listCoversItems(
  projectId: string,
  opts: { section?: string; limit?: number } = {},
): Promise<StoredCoversItem[]> {
  let query = items(projectId).where('platform', '==', 'covers');
  if (opts.section) query = query.where('section', '==', opts.section);

  const snap = await query.limit(Math.max(1, Math.min(500, opts.limit ?? 200))).get();

  return snap.docs
    .map((d) => toStored(d.id, d.data()))
    .sort((a, b) => (b.lastPostAtMs ?? 0) - (a.lastPostAtMs ?? 0));
}

export async function getCoversItem(projectId: string, itemId: string): Promise<StoredCoversItem | null> {
  const snap = await items(projectId).doc(itemId).get();
  const data = snap.data();
  if (!snap.exists || !data || data.platform !== 'covers') return null;
  return toStored(snap.id, data);
}

export interface StoredCoversPost {
  postId: string;
  number: number | null;
  page: number | null;
  author: string;
  authorId: string;
  createdAtMs: number | null;
  body: string;
  chars: number;
  entities: CoversEntities;
}

/** One thread's posts, in thread order — by number when the page numbered them,
 *  by time otherwise. A post with neither sorts last rather than first, so an
 *  unparsed row never poses as the opening post. */
export async function listCoversPosts(projectId: string, itemId: string): Promise<StoredCoversPost[]> {
  const snap = await items(projectId).doc(itemId).collection('posts').get();

  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        postId: d.id,
        number: (data.number as number | null) ?? null,
        page: (data.page as number | null) ?? null,
        author: (data.author as string) ?? '',
        authorId: (data.authorId as string) ?? '',
        createdAtMs: (data.createdAtMs as number | null) ?? null,
        body: (data.body as string) ?? '',
        chars: (data.chars as number) ?? 0,
        entities: (data.entities as CoversEntities) ?? {
          sport: null,
          lexicon: false,
          teams: [],
          fixture: null,
          lines: [],
        },
      };
    })
    .sort((a, b) => rank(a) - rank(b));
}

const rank = (p: { number: number | null; createdAtMs: number | null }): number =>
  p.number ?? p.createdAtMs ?? Number.MAX_SAFE_INTEGER;

function toStored(itemId: string, data: FirebaseFirestore.DocumentData): StoredCoversItem {
  const created = data.createdAtSource as Timestamp | null | undefined;
  const harvested = data.lastHarvestedAt as Timestamp | null | undefined;

  return {
    itemId,
    externalId: (data.externalId as string) ?? '',
    section: (data.section as string) ?? '',
    sport: (data.sport as string | null) ?? null,
    title: (data.title as string) ?? '',
    url: (data.url as string) ?? '',
    author: (data.author as string) ?? '',
    createdAtSourceMs: created ? created.toMillis() : null,
    postsOnSite: (data.postsOnSite as number | null) ?? null,
    views: (data.views as number | null) ?? null,
    postsHeld: (data.postsHeld as number) ?? 0,
    pageCount: (data.pageCount as number) ?? 1,
    firstPostAtMs: (data.firstPostAtMs as number | null) ?? null,
    lastPostAtMs: (data.lastPostAtMs as number | null) ?? null,
    entities: (data.entities as CoversEntities) ?? {
      sport: null,
      lexicon: false,
      teams: [],
      fixture: null,
      lines: [],
    },
    fixtureKey: (data.fixtureKey as string | null) ?? null,
    lastHarvestedAtMs: harvested ? harvested.toMillis() : null,
  };
}
