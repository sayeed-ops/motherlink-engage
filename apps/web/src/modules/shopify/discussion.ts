// A whole topic, as a conversation.
//
// PURE. `/t/{slug}/{id}.json` in, a readable discussion out. Nothing here
// fetches and nothing here is stored — stage two reads a discussion, thinks
// about it, and keeps the thinking. See server/shopify.ts for why the bodies
// never reach Firestore.
//
// ════════════════════════════════════════════════════════════════════════════
// THE UNIT OF MEANING IS THE THREAD, NOT THE POST
//
// Covers analysed one post at a time and its drafts kept dying on the same
// verdict: "generic advice that adds nothing to the thread". That was correct
// and it was unfixable at the post level, because whether a reply adds anything
// is a fact about what has ALREADY BEEN SAID.
//
// So this file's job is to hand the model the shape of the conversation: who
// asked what, what has been offered as an answer, which of it the community
// endorsed, and where it stops. Being unique is not the goal; knowing what you
// would be repeating is.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ WE READ THE FIRST PAGE OF A THREAD, NOT ALL OF IT — A DECISION, NOT A BUG
//
// `/t/{slug}/{id}.json` returns roughly the first 20 posts and the complete
// list of post ids. Anything past that needs further requests. We do not make
// them, so a long discussion is read PARTIALLY and says so: `truncated` is set
// from the id list rather than from what survived filtering, `postsSeen` and
// `postsTotal` are both stored on every reading, and the screen prints
// "19 of 24 posts read (partial)" rather than passing a first page off as the
// whole conversation.
//
// WHY THIS IS ACCEPTABLE TODAY. On the six marketing boards the median thread
// is well under twenty posts, so most readings are complete. Where it bites is
// exactly the threads most worth reading — the 100-post ones — and there the
// first page still contains the question, the early answers, and usually the
// accepted one.
//
// WHAT IT COSTS WHEN IT IS WRONG. A late correction is invisible: if the thread
// spent forty posts agreeing and then somebody demonstrated the advice was
// wrong, `alreadySaid` reports the agreement and misses the correction. That is
// the failure mode to watch, and it is why `truncated` is surfaced rather than
// logged.
//
// THE SEAM FOR FIXING IT: `fetchRemainingPosts` does not exist yet, and this is
// where it would go. Discourse serves the rest at
// `/t/{id}/posts.json?post_ids[]=…` in batches of about twenty, so full
// coverage of an N-post thread is ceil(N/20) requests instead of one. The
// pieces already in place for it: `postsTotal` and `truncated` say whether more
// exist, `post_stream.stream` carries every id, and `renderDiscussion` already
// budgets and ranks, so more posts arriving changes what it CHOOSES from and
// not how it chooses.
//
// It is deliberately not built because it is a cost decision rather than a
// technical one — a request per twenty posts against somebody else's server,
// on threads we may not reply to. Build it when a reading is found to have
// missed something that mattered, and let that be the reason.
// ════════════════════════════════════════════════════════════════════════════

import { normaliseId, normaliseSlug } from './categories';
import { htmlToText } from './text';

export interface DiscussionPost {
  postNumber: number;
  username: string;
  createdAtMs: number | null;
  /** Plain text, tags stripped and whitespace collapsed. */
  text: string;
  likeCount: number;
  /** Discourse's own mark: the community accepted this as the answer. */
  isAcceptedAnswer: boolean;
  /** True for the post that opened the topic. */
  isOriginalPost: boolean;
  /** Post number this replies to, when it replies to a specific post rather
   *  than to the topic. Usually null — see the reply_count note in topics.ts. */
  replyToNumber: number | null;
}

export interface Discussion {
  id: number;
  slug: string;
  title: string;
  categoryId: number;
  tags: string[];
  posts: DiscussionPost[];
  /** Posts the payload says exist, which can exceed `posts.length` — Discourse
   *  ships the first ~20 and leaves the rest to a second request. Reported so a
   *  partial read is visible as partial rather than passing for the whole
   *  conversation. */
  postsTotal: number;
  truncated: boolean;
  acceptedAnswerNumber: number | null;
}

const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

export function parseDiscussion(raw: unknown): Discussion | null {
  const d = raw as Record<string, unknown>;
  const id = normaliseId(d?.id);
  if (id === null) return null;

  const stream = (d.post_stream ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(stream.posts) ? stream.posts : [];

  const posts: DiscussionPost[] = [];
  let accepted: number | null = null;

  for (const row of rows) {
    const p = row as Record<string, unknown>;
    const postNumber = typeof p.post_number === 'number' ? p.post_number : 0;
    const text = htmlToText(p.cooked);

    // ⚠️ A MODERATED POST IS DROPPED, NOT KEPT AS ITS PLACEHOLDER. Discourse
    // replaces hidden posts with "This post was flagged by the community and is
    // temporarily hidden" — real text, in a real post, saying nothing about the
    // subject. Seen live on a topic in the SEO board. Feeding it to a model as
    // a community opinion is how a thread's tone gets read wrong.
    if (!text || /^This post was flagged by the community/i.test(text)) continue;

    const isAccepted = p.accepted_answer === true;
    if (isAccepted && accepted === null) accepted = postNumber;

    posts.push({
      postNumber,
      username: String(p.username ?? '').trim() || 'unknown',
      createdAtMs: ms(p.created_at),
      text,
      likeCount: typeof p.like_count === 'number' ? Math.max(0, p.like_count) : 0,
      isAcceptedAnswer: isAccepted,
      isOriginalPost: postNumber === 1,
      replyToNumber: typeof p.reply_to_post_number === 'number' ? p.reply_to_post_number : null,
    });
  }

  posts.sort((a, b) => a.postNumber - b.postNumber);

  const declared = typeof d.posts_count === 'number' ? d.posts_count : posts.length;
  const streamIds = Array.isArray(stream.stream) ? stream.stream.length : declared;

  return {
    id,
    slug: normaliseSlug(d.slug),
    title: String(d.title ?? '').trim(),
    categoryId: normaliseId(d.category_id) ?? 0,
    tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : [],
    posts,
    postsTotal: Math.max(declared, streamIds),
    // Compared against the STREAM rather than posts.length, so dropping a
    // moderated post does not make a complete read look truncated.
    truncated: rows.length < streamIds,
    acceptedAnswerNumber: accepted,
  };
}

/**
 * The conversation as text a model can read.
 *
 * Capped, because a 200-post thread would otherwise be one enormous prompt with
 * the same idea restated forty times. When it does not fit, the OPENING POST
 * and the ACCEPTED ANSWER are always kept — they are the question and the
 * community's own verdict on it — and the rest is taken from the most-liked
 * posts, which is the closest thing the board has to a measure of what it found
 * useful.
 *
 * The alternative, taking the first N posts, would systematically hand over the
 * fastest replies rather than the best ones.
 */
export function renderDiscussion(d: Discussion, maxChars = 14_000): string {
  const head = `Title: ${d.title}\n${d.postsTotal} posts${d.truncated ? ' (partial read)' : ''}\n`;

  const must = d.posts.filter((p) => p.isOriginalPost || p.isAcceptedAnswer);
  const rest = d.posts
    .filter((p) => !p.isOriginalPost && !p.isAcceptedAnswer)
    .sort((a, b) => b.likeCount - a.likeCount || a.postNumber - b.postNumber);

  const chosen = new Map<number, DiscussionPost>();
  let used = head.length;

  for (const p of [...must, ...rest]) {
    const block = renderPost(p);
    // The opening post and the accepted answer go in whatever the budget says;
    // a summary missing the question is not a shorter summary, it is a
    // different and useless one.
    const mandatory = p.isOriginalPost || p.isAcceptedAnswer;
    if (!mandatory && used + block.length > maxChars) continue;
    chosen.set(p.postNumber, p);
    used += block.length;
  }

  const ordered = [...chosen.values()].sort((a, b) => a.postNumber - b.postNumber);
  const omitted = d.posts.length - ordered.length;

  return (
    head +
    ordered.map(renderPost).join('') +
    (omitted > 0 ? `\n[${omitted} further ${omitted === 1 ? 'reply' : 'replies'} not shown]\n` : '')
  );
}

function renderPost(p: DiscussionPost): string {
  const marks = [
    p.isOriginalPost ? 'ASKED' : null,
    p.isAcceptedAnswer ? 'ACCEPTED ANSWER' : null,
    p.likeCount > 0 ? `${p.likeCount} likes` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `\n#${p.postNumber} ${p.username}${marks ? ` (${marks})` : ''}\n${p.text}\n`;
}
