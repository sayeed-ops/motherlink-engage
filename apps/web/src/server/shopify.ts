import 'server-only';

// Storing what the Shopify Community reader found.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT IS KEPT, AND WHAT IS DELIBERATELY NOT
//
// KEPT, permanently — one document per topic: the title, the excerpt, the
// counts, the screen's verdict. It is small, it is the deduplication key, and
// it is what stops a second run paying to think about a topic the first run
// already judged.
//
// NOT KEPT — thread bodies and comment text. Stage two fetches a discussion,
// analyses it, and persists the ANALYSIS plus the handful of quotes it cited.
// The bodies are never written.
//
// That is a deliberate departure from Covers, which stored every post of every
// thread in a subcollection and then exhausted the project's daily read quota,
// taking the whole application down — `requireCaller` reads a profile, so a
// read-blocked project renders as "Authentication failed" and looks deleted.
//
// The reason NOT to store-then-delete, which was the other option on the table:
// writes and deletes are both billed, a cleanup job is a thing that can be
// wrong, and clearing a discussion on the next run would strip the evidence out
// from under any draft still waiting for a person to review it. Re-reading one
// topic is a single JSON request. Holding it is a standing cost and a standing
// risk.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue, type Query } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import {
  defaultShopifyConfig,
  normaliseShopifyConfig,
  type ShopifyModuleConfig,
} from '@/modules/shopify/config';
import { screenTopic, type ScreenLimits, type ShopifyTopic, type SkipReason } from '@/modules/shopify/topics';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);
const topics = (projectId: string) => project(projectId).collection('shopifyTopics');

/** Firestore rejects a batch over 500 writes. Chunked rather than trusted: a
 *  wide selection across four pages a board is well past it. */
const BATCH_LIMIT = 400;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getShopifyConfig(projectId: string): Promise<ShopifyModuleConfig> {
  const snap = await project(projectId).collection('modules').doc('shopify').get();
  // Absent means the shipped defaults, not an error — a project that has never
  // opened the screen can still be fetched from.
  return snap.exists ? normaliseShopifyConfig(snap.data()) : defaultShopifyConfig();
}

export async function saveShopifyConfig(
  projectId: string,
  raw: unknown,
  uid: string,
): Promise<ShopifyModuleConfig> {
  const config = normaliseShopifyConfig(raw);
  await project(projectId)
    .collection('modules')
    .doc('shopify')
    .set({ ...config, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
  return config;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface StoredTopic extends ShopifyTopic {
  /** The screen's verdict at the last fetch. Stored so the queue can show why
   *  something was set aside without re-deriving it, and so a widened limit is
   *  visibly a NEW verdict rather than a silent change of mind. */
  skipReasons: SkipReason[];
  /** When we first and last saw it in a listing. `firstSeenAt` survives every
   *  re-fetch; it is what makes "new since yesterday" answerable. */
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  /** Set by the operator, ticking rows for a stage-two read. */
  selected: boolean;
  /** ⚠️ A MARKER WITH A VERSION, NOT A FLAG.
   *
   *  Covers wrote analyses append-only with no deduplication, so a second run
   *  over the same board produced a second opinion beside the first and the
   *  screen showed whichever it read last. Here "analysed" is a timestamp plus
   *  the prompt that produced it: when the prompt improves, every older
   *  analysis is automatically stale and re-analysis has a rule rather than
   *  being a judgement call. Null means never analysed. */
  analysedAtMs: number | null;
  analysisPromptVersion: string | null;
}

export interface SaveTopicsResult {
  created: number;
  updated: number;
}

/**
 * Store a listing read.
 *
 * ⚠️ OPERATOR STATE SURVIVES A RE-FETCH. `selected`, `firstSeenAtMs` and the
 * analysis markers are written on create and never on update, so re-reading a
 * board cannot untick a row somebody chose or erase the record that it was
 * already analysed. Covers established the same rule for `isFavorite` and
 * `processingStatus`, and it is the difference between a fetch being safe to
 * press twice and being something to think about first.
 *
 * The counts and the screen verdict DO update, because those are facts about
 * the board that change: a topic gains replies, and a topic that has gone quiet
 * since the last read should say so.
 */
export async function saveTopics(
  projectId: string,
  found: readonly ShopifyTopic[],
  limits: ScreenLimits,
  nowMs: number,
): Promise<SaveTopicsResult> {
  if (!found.length) return { created: 0, updated: 0 };

  const col = topics(projectId);
  let created = 0;
  let updated = 0;

  for (let i = 0; i < found.length; i += BATCH_LIMIT) {
    const chunk = found.slice(i, i + BATCH_LIMIT);
    const refs = chunk.map((t) => col.doc(String(t.id)));
    const present = await db().getAll(...refs);
    const batch = db().batch();

    chunk.forEach((topic, n) => {
      const ref = refs[n];
      const exists = present[n].exists;
      const { reasons } = screenTopic(topic, nowMs, limits);

      const facts = {
        ...topic,
        skipReasons: reasons,
        lastSeenAtMs: nowMs,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (exists) {
        batch.set(ref, facts, { merge: true });
        updated++;
      } else {
        batch.set(ref, {
          ...facts,
          firstSeenAtMs: nowMs,
          selected: false,
          analysedAtMs: null,
          analysisPromptVersion: null,
          createdAt: FieldValue.serverTimestamp(),
        });
        created++;
      }
    });

    await batch.commit();
  }

  return { created, updated };
}

export interface ListTopicsOptions {
  categoryId?: number;
  /** Only rows nothing objected to. The rejected ones are still stored and
   *  still listable — see the note in modules/shopify/topics.ts about why a
   *  board that shows only survivors cannot be argued with. */
  worthReadingOnly?: boolean;
  selectedOnly?: boolean;
  limit?: number;
}

/** Firestore's page cap for this collection. Deliberately small: the six
 *  default boards hold ~450 topics between them and a screen nobody scrolls
 *  past the first hundred rows of does not need a thousand. */
export const TOPIC_LIMIT_DEFAULT = 200;
export const TOPIC_LIMIT_CEILING = 1000;

/**
 * The stored listing, ranked.
 *
 * ⚠️ EVERY PREDICATE FIRESTORE CAN EVALUATE IS IN THE QUERY, and the ordering
 * with it, so `limit` truncates the ranked relevant set. Filtering after
 * `.limit()` bills for documents it then discards AND is wrong — the limit
 * lands before the predicate, so one board's topics sitting behind another's
 * render as an empty list rather than a truncated one. That cost a day on
 * Covers; see modules/covers/queries.ts.
 */
export async function listTopics(projectId: string, opts: ListTopicsOptions = {}): Promise<StoredTopic[]> {
  let q: Query = topics(projectId);
  if (opts.categoryId !== undefined) q = q.where('categoryId', '==', opts.categoryId);
  if (opts.selectedOnly) q = q.where('selected', '==', true);
  // An empty array means nothing objected. Firestore can test that directly.
  if (opts.worthReadingOnly) q = q.where('skipReasons', '==', []);

  const limit = Math.max(1, Math.min(TOPIC_LIMIT_CEILING, opts.limit ?? TOPIC_LIMIT_DEFAULT));
  const snap = await q.orderBy('lastPostedAtMs', 'desc').limit(limit).get();

  return snap.docs.map((d) => toStored(d.data()));
}

/** Tick or untick rows for a stage-two read. Returns how many actually changed,
 *  so the screen can say "12 selected" from the write rather than from what it
 *  hoped the write did. */
export async function setSelected(
  projectId: string,
  topicIds: readonly number[],
  selected: boolean,
): Promise<number> {
  const ids = [...new Set(topicIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;

  const col = topics(projectId);
  let changed = 0;

  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const chunk = ids.slice(i, i + BATCH_LIMIT);
    const refs = chunk.map((id) => col.doc(String(id)));
    const present = await db().getAll(...refs);
    const batch = db().batch();

    present.forEach((snap, n) => {
      // A topic we have never seen cannot be selected. Creating a row here
      // would put a document with no title and no counts into the queue.
      if (!snap.exists || snap.data()?.selected === selected) return;
      batch.set(refs[n], { selected, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      changed++;
    });

    if (changed) await batch.commit();
  }

  return changed;
}

function toStored(data: FirebaseFirestore.DocumentData): StoredTopic {
  return {
    id: Number(data.id) || 0,
    slug: String(data.slug ?? ''),
    title: String(data.title ?? ''),
    excerpt: String(data.excerpt ?? ''),
    categoryId: Number(data.categoryId) || 0,
    tags: Array.isArray(data.tags) ? data.tags.filter((t: unknown): t is string => typeof t === 'string') : [],

    replyCount: Number(data.replyCount) || 0,
    postsCount: Number(data.postsCount) || 0,
    // Recomputed rather than read, so a document written before `replies`
    // existed reports the right number instead of zero.
    replies: Math.max(0, (Number(data.postsCount) || 0) - 1),
    views: Number(data.views) || 0,
    likeCount: Number(data.likeCount) || 0,

    createdAtMs: data.createdAtMs ?? null,
    lastPostedAtMs: data.lastPostedAtMs ?? null,

    hasAcceptedAnswer: data.hasAcceptedAnswer === true,
    closed: data.closed === true,
    archived: data.archived === true,
    pinned: data.pinned === true,
    visible: data.visible !== false,

    skipReasons: Array.isArray(data.skipReasons) ? data.skipReasons : [],
    firstSeenAtMs: data.firstSeenAtMs ?? null,
    lastSeenAtMs: data.lastSeenAtMs ?? null,
    selected: data.selected === true,
    analysedAtMs: data.analysedAtMs ?? null,
    analysisPromptVersion: data.analysisPromptVersion ?? null,
  };
}
