// What a Reddit reader must be able to tell us.
//
// PURE — no 'server-only', no fetch, no Firestore. The selection logic and its
// tests import these types, and both run outside a request. Same convention as
// lib/llm/types.ts and modules/reddit/subreddits.ts.
//
// DELIBERATELY SEPARATE FROM ./../rss.ts, and this is the whole point of the
// file. That path returns `score: 0`, `numComments: 0` and a hardcoded
// `isSelfPost: true` — its own comment says "RSS exposes none of these
// reliably" — because Reddit's JSON API 403s for that network and the official
// API is gated behind a policy a promotional use case will not pass. Every
// number comment karma needs is one RSS cannot supply, so it reads through an
// operator-supplied API instead. Sharing code or types with rss.ts would let
// those placeholder zeros leak into a system that treats them as measurements.

/** What kind of thing the post actually is.
 *
 *  `unknown` is honest rather than a default: a reader that cannot determine the
 *  type must say so, because the selection rule for media posts is REJECT and
 *  silently guessing `text` would post jokes into threads we cannot see. */
export type PostMediaKind = 'text' | 'link' | 'image' | 'video' | 'gallery' | 'poll' | 'unknown';

export type ListingSort = 'hot' | 'new' | 'rising' | 'top';

export interface PostSummary {
  redditPostId: string;
  subreddit: string;
  title: string;
  /** Selftext. Empty string for link/media posts — never null, so length checks
   *  never need a guard. */
  body: string;
  author: string;
  permalink: string;
  createdAtMs: number;
  score: number;
  numComments: number;
  /** 0..1, or null when the reader cannot supply it. Distinguishing "unknown"
   *  from "controversial" matters — see the temperature check in select.ts. */
  upvoteRatio: number | null;
  flair: string | null;
  media: PostMediaKind;
  isLocked: boolean;
  isArchived: boolean;
  isStickied: boolean;
  isNsfw: boolean;
  /** Randomised comment order. Destroys slot availability outright — there is no
   *  "position" to compete for, so every ranking signal we have is void. */
  isContestMode: boolean;
  isQuarantined: boolean;
  /** Already removed by a moderator or automod. */
  isRemoved: boolean;
  /** New-post score suppression. Velocity and slot signals are not merely noisy
   *  here, they are meaningless — `score` is not the real number. */
  isScoreHidden: boolean;
}

export interface ThreadComment {
  commentId: string;
  author: string;
  body: string;
  score: number;
  createdAtMs: number;
  /** Written by the post's author. Drives the "is the thread alive" signal. */
  isOp: boolean;
  /** Direct replies. A comment with replies is a conversation, not a drive-by. */
  replyCount: number;
}

/** A post plus the room around it, captured at one moment.
 *
 *  `fetchedAtMs` is load-bearing, not bookkeeping: a comment is composed from
 *  this snapshot and posted minutes later, so the staleness check needs to know
 *  how old the picture was. */
export interface ThreadSnapshot {
  post: PostSummary;
  /** TOP-LEVEL ONLY, sorted by score descending. Replies are counted, not
   *  fetched — the gap analysis asks "what has this room already said", and a
   *  sub-thread three levels down is not part of that answer. */
  comments: ThreadComment[];
  fetchedAtMs: number;
}

/**
 * The two questions the whole system asks of Reddit.
 *
 * Kept this narrow on purpose. Every implementation — the fixture one, Crawlzo,
 * and any future replacement — satisfies exactly this, so swapping them is a
 * one-line change and nothing downstream knows which is in use.
 *
 * SEARCH, NOT LISTING, and that is forced rather than chosen: Crawlzo has no
 * subreddit-listing endpoint and its `query` argument is required, so "what is
 * hot in r/x right now" is not expressible. We search each community for that
 * community's own keywords instead — which the Communities tab already stores,
 * and which suits the persona better anyway, since the account then only ever
 * sees posts about its own topics. See docs/CRAWLZO-API.md.
 */
export interface RedditReader {
  /** Recent posts in one subreddit matching one of the account's keywords.
   *
   *  Results carry NO comments — that costs a second call per post. This is why
   *  selection screens on listing data first; see screenListing in
   *  ../commentKarma/select.ts. */
  search(subreddit: string, query: string, opts?: SearchOptions): Promise<PostSummary[]>;
  /** One post and its top-level comments. Null when the post is gone (deleted,
   *  removed, or a bad id) — a normal outcome between search and read, not an
   *  error, though note Crawlzo bills for it. */
  getThread(redditPostId: string): Promise<ThreadSnapshot | null>;
}

export interface SearchOptions {
  sort?: ListingSort;
  /** Crawlzo's `time_filter`. 'day' plus our own age window is the useful pair. */
  time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  limit?: number;
}
