// A topic as the listing reports it, and the free screen over it.
//
// PURE. This is the whole of stage one: what a board's JSON says about a topic
// before anything has opened it.
//
// ════════════════════════════════════════════════════════════════════════════
// THE POINT OF THIS FILE IS THAT IT IS FREE
//
// Covers read 294 whole threads — 600KB of HTML each — stored every post, and
// THEN discovered that 93% of them were not worth answering. The screening was
// right; it just happened after the bill.
//
// Discourse hands us the deciding facts in the listing itself: how many
// replies, how many views, when it was last posted in, whether it is closed,
// and — the one Covers never had — whether the question already has an
// ACCEPTED ANSWER. A solved question is not an opportunity, and here we can
// know that without opening anything.
//
// So nothing in this file fetches, and nothing calls a model. Everything it
// rejects is rejected for free.
// ════════════════════════════════════════════════════════════════════════════

import { normaliseId, normaliseSlug } from './categories';
import { decodeEntities } from './text';

/** One topic, as stage one knows it. No bodies, no comments — the listing does
 *  not carry them and this stage does not want them. */
export interface ShopifyTopic {
  id: number;
  slug: string;
  title: string;
  /** Discourse's own preview of the first post. Usually a couple of sentences,
   *  and it is the only body text stage one ever sees. */
  excerpt: string;
  categoryId: number;
  tags: string[];

  /**
   * ⚠️ NOT THE NUMBER OF REPLIES. Use `replies` below.
   *
   * Discourse counts only posts that reply to ANOTHER POST here — the
   * `reply_to_post_number` chain. Almost nobody does that; they reply to the
   * topic. So a 23-post discussion reports `reply_count: 0`, and "About the SEO
   * category" reports 8 against a `posts_count` of 7, which is more replies
   * than there are posts.
   *
   * Kept because it is a real signal about threading depth, and named exactly
   * what the payload calls it so nobody re-derives the wrong meaning from a
   * friendlier name. Verified against the live board 2026-09-10.
   */
  replyCount: number;
  /** Posts in the topic, including the first. This is the conversation's size. */
  postsCount: number;
  /** `postsCount` minus the original post — what a person means by "replies".
   *  Derived here so no screen or prompt has to remember the trap above. */
  replies: number;
  views: number;
  likeCount: number;

  createdAtMs: number | null;
  lastPostedAtMs: number | null;

  /** ⚠️ THE MOST USEFUL FIELD IN THE PAYLOAD. Discourse marks the reply that
   *  solved a question. Somewhere already answered is a place to learn from and
   *  a poor place to add to. */
  hasAcceptedAnswer: boolean;

  closed: boolean;
  archived: boolean;
  pinned: boolean;
  visible: boolean;
}

/** `/c/{slug}/{id}/l/{sort}.json` → our shape. Rows we cannot address are
 *  dropped, not defaulted. */
export function parseTopicList(raw: unknown): { topics: ShopifyTopic[]; moreUrl: string | null } {
  const list = (raw as { topic_list?: { topics?: unknown[]; more_topics_url?: unknown } })?.topic_list;
  const rows = list?.topics;
  if (!Array.isArray(rows)) return { topics: [], moreUrl: null };

  const topics: ShopifyTopic[] = [];
  for (const row of rows) {
    const t = parseTopic(row);
    if (t) topics.push(t);
  }

  const more = typeof list?.more_topics_url === 'string' ? list.more_topics_url : null;
  return { topics, moreUrl: more };
}

const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

export function parseTopic(row: unknown): ShopifyTopic | null {
  const r = row as Record<string, unknown>;
  const id = normaliseId(r.id);
  const slug = normaliseSlug(r.slug);
  if (id === null || !slug) return null;

  return {
    id,
    slug,
    title: String(r.title ?? '').trim(),
    // ⚠️ DECODED, NOT TIDIED. Discourse ships the excerpt as HTML with entities
    // encoded and a trailing ellipsis it added itself. The ellipsis stays — it
    // is Discourse's own mark that the text is cut — but the entities are
    // decoded, because React escapes what it renders and an undecoded excerpt
    // reached the screen as "these models reco&hellip;". Caught in a browser;
    // no API-level test could see it.
    excerpt: decodeEntities(String(r.excerpt ?? '')).trim(),
    categoryId: normaliseId(r.category_id) ?? 0,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],

    replyCount: int(r.reply_count),
    postsCount: int(r.posts_count),
    // A topic always has its opening post, so anything beyond the first is a
    // response. Clamped at 0 because a malformed payload reporting 0 posts must
    // not produce -1 replies.
    replies: Math.max(0, int(r.posts_count) - 1),
    views: int(r.views),
    likeCount: int(r.like_count),

    createdAtMs: ms(r.created_at),
    lastPostedAtMs: ms(r.last_posted_at) ?? ms(r.bumped_at),

    hasAcceptedAnswer: r.has_accepted_answer === true,
    closed: r.closed === true,
    archived: r.archived === true,
    pinned: r.pinned === true,
    // Absent reads as visible: Discourse omits the flag on ordinary topics and
    // treating "not stated" as hidden would empty the board.
    visible: r.visible !== false,
  };
}

// ---------------------------------------------------------------------------
// The free screen
// ---------------------------------------------------------------------------

export type SkipReason =
  /** Already solved. Present as a fact in the listing, not a guess. */
  | 'answered'
  /** Locked or filed away — nothing can be added. */
  | 'closed'
  /** A pinned board notice, not a conversation. */
  | 'pinned'
  /** Hidden by moderation. */
  | 'hidden'
  /** Nobody has said anything for long enough that a reply arrives alone. */
  | 'quiet'
  /** Nobody has replied at all, and nobody is reading it either. */
  | 'ignored';

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  answered: 'Already has an accepted answer',
  closed: 'Closed or archived',
  pinned: 'A pinned board notice',
  hidden: 'Hidden by moderation',
  quiet: 'Nothing said here for a long time',
  ignored: 'No replies and almost no views',
};

export interface ScreenLimits {
  /** Days since the last post before a topic reads as finished. */
  quietAfterDays: number;
  /** Below this many views AND with no replies, nobody is in the room. */
  ignoredBelowViews: number;
  /** Whether a solved question is skipped. Configurable because a solved
   *  question is still worth READING to learn what the board accepts — the
   *  operator may want them in view even though they are poor targets. */
  skipAnswered: boolean;
}

export const DEFAULT_LIMITS: ScreenLimits = {
  // Shopify's marketing boards are slow: the six default categories hold ~450
  // topics between them, and a thread can sit a fortnight and still get a
  // useful reply. Covers' equivalent window was hours, because a game thread
  // dies when the game ends. Same check, a different room.
  quietAfterDays: 60,
  ignoredBelowViews: 30,
  skipAnswered: true,
};

export interface Screened {
  topic: ShopifyTopic;
  /** Empty means nothing objected. It is not a recommendation — a topic that
   *  survives the screen is one a PERSON should look at, which is the whole of
   *  stage one's opinion. */
  reasons: SkipReason[];
}

/**
 * What is worth a person's attention, and why not.
 *
 * ⚠️ EVERY TOPIC GETS A VERDICT, INCLUDING THE REJECTED ONES. The reasons are
 * returned rather than filtered away, because a board that shows only survivors
 * cannot be argued with: "why is this queue empty" is unanswerable unless the
 * rejections are on the screen with their reasons attached. Covers learned this
 * the expensive way — 95% of its posts were rejected on an age rule that no
 * screen ever mentioned.
 */
export function screenTopic(topic: ShopifyTopic, nowMs: number, limits: ScreenLimits = DEFAULT_LIMITS): Screened {
  const reasons: SkipReason[] = [];

  if (limits.skipAnswered && topic.hasAcceptedAnswer) reasons.push('answered');
  if (topic.closed || topic.archived) reasons.push('closed');
  if (topic.pinned) reasons.push('pinned');
  if (!topic.visible) reasons.push('hidden');

  const last = topic.lastPostedAtMs;
  if (last !== null && nowMs - last > limits.quietAfterDays * 86_400_000) reasons.push('quiet');

  // ⚠️ `replies`, NOT `replyCount` — see the field comment. Screening on
  // reply_count would have called a 23-post discussion unanswered and skipped
  // the busiest threads on the board.
  //
  // Both halves matter. A topic with no replies but two thousand views is a
  // question everybody has and nobody answered, which is the best thing on the
  // board — not the worst.
  if (topic.replies === 0 && topic.views < limits.ignoredBelowViews) reasons.push('ignored');

  return { topic, reasons };
}

export const isWorthReading = (s: Screened): boolean => s.reasons.length === 0;
