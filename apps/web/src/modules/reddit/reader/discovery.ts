// Finding posts WITHOUT a keyword — what is actually happening in a community
// right now.
//
// PURE. Types and the one screen that free data can honestly support.
//
// WHY THIS EXISTS. Crawlzo has exactly two endpoints and `query` is REQUIRED on
// the search one (vendor documentation, §1). So "what is rising in r/budget
// right now" is not expressible through Crawlzo at all — not a design
// preference, a hard limit of the read path. Searching each community for its
// own keywords was the workaround, and it has a real cost: the account only ever
// sees posts that matched a phrase somebody typed into a settings box, which is
// not how a person reads a subreddit and cannot find the thread that is taking
// off right now for reasons nobody predicted.
//
// Reddit's own RSS feeds — /r/x/rising/.rss, /hot/.rss, /new/.rss — need no
// query and no key. They are how this system sees the room.
//
// WHAT RSS CANNOT TELL US, AND WHY THAT SHAPES THIS FILE. No score, no comment
// count, no upvote ratio, no media type, no lock/NSFW/quarantine flags. The
// existing `../rss.ts` fills those with `score: 0`, `numComments: 0` and a
// hardcoded `isSelfPost: true`, and the standing rule in this repo is that those
// placeholders must never reach code that reads them as measurements.
//
// So DiscoveredPost has no such fields at all. Not zeroed — ABSENT. A screen
// cannot accidentally read a fabricated zero as "this post has no comments", and
// the type system makes the mistake unwriteable rather than merely discouraged.
// Everything that needs a number comes from the paid reddit-post-v2 call.

/** Which of Reddit's own orderings to read.
 *
 *  `rising` is the one this system wants: posts gaining attention NOW, which is
 *  precisely the window where a comment can still reach the top. `hot` is
 *  already-arrived and more crowded. `new` is mostly too young to judge. */
export type ListingFeed = 'rising' | 'hot' | 'new';

export const LISTING_FEEDS: readonly ListingFeed[] = ['rising', 'hot', 'new'];

/**
 * A post seen in a feed, carrying ONLY what a feed can honestly supply.
 *
 * Compare PostSummary in ./types.ts, which has fifteen more fields — every one
 * of them a measurement, and every one of them requiring the paid call.
 */
export interface DiscoveredPost {
  /** Bare base-36 id. reddit-post-v2 accepts it without the subreddit. */
  redditPostId: string;
  subreddit: string;
  title: string;
  permalink: string;
  createdAtMs: number;
  author: string;
}

export interface RedditDiscovery {
  /** Recent posts from one community's own feed. No query, no key, not billed. */
  list(subreddit: string, feed: ListingFeed, limit?: number): Promise<DiscoveredPost[]>;
}

/** The only rejection free feed data can support. */
export type DiscoveryReject = 'too-young' | 'too-old' | 'no-timestamp';

export interface DiscoveryLimits {
  minAgeMinutes: number;
  maxAgeHours: number;
}

/**
 * Screen a feed entry on age, and ONLY on age.
 *
 * This is the whole free screen in feed mode, and it is deliberately far weaker
 * than screenListing(). Everything else that function decides — media type,
 * crowding, lock, NSFW, contest mode, the velocity baseline — needs numbers RSS
 * does not have, and guessing any of them from a title would be exactly the
 * fabrication this file exists to avoid.
 *
 * The consequence is honest and worth stating plainly: feed mode pays for more
 * reads that turn out to be rejects. It buys the thing search mode cannot
 * provide at any price — seeing what the community is actually reading.
 */
export function screenDiscovered(
  post: DiscoveredPost,
  nowMs: number,
  limits: DiscoveryLimits,
): DiscoveryReject | null {
  if (!post.createdAtMs) return 'no-timestamp';
  const ageHours = Math.max((nowMs - post.createdAtMs) / 3_600_000, 0);
  if (ageHours * 60 < limits.minAgeMinutes) return 'too-young';
  if (ageHours > limits.maxAgeHours) return 'too-old';
  return null;
}

/**
 * The age window this community's OWN PACE implies.
 *
 * The problem it solves, seen live on 2026-08-16: one window cannot serve two
 * communities. r/AskReddit's `new` feed is 25 posts under twenty minutes old —
 * every one "too young". r/budget's rising feed has a MEDIAN post age of 75
 * hours — every one "too old". The same two numbers cannot be right for both,
 * and no amount of tuning by hand fixes it, because the operator would have to
 * re-tune per community and then again as each community's traffic changed.
 *
 * So it is measured instead of configured — the same move this codebase makes
 * everywhere else (comment length is copied from the thread, velocity is judged
 * against the subreddit's own median). The feed is already fetched, free, on
 * every scan, and the median age of what a community is currently showing IS
 * its pace.
 *
 * The shape: enter early relative to that pace, and leave before the thread is
 * old relative to it.
 *
 * THE UPPER BOUND IS CAPPED BY THE ACCOUNT'S OWN maxAgeHours AND NEVER EXCEEDS
 * IT. That is not caution, it is a correctness requirement: the enqueue
 * re-checks staleness against the account setting, so a draft written outside
 * it would be refused at approval and the operator would watch good comments
 * die between two rules that disagreed. The lower bound has no such constraint
 * — nothing downstream rejects a thread for being young — so it is free to go
 * far below the account value, which is exactly what a firehose community needs.
 */
export function paceWindow(
  posts: DiscoveredPost[],
  accountLimits: DiscoveryLimits,
  nowMs: number,
): DiscoveryLimits & { medianAgeHours: number } {
  const ages = posts
    .map((p) => (p.createdAtMs ? (nowMs - p.createdAtMs) / 3_600_000 : NaN))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);

  // Too little to measure: the account's own numbers stand, unchanged.
  if (ages.length < 5) return { ...accountLimits, medianAgeHours: 0 };

  const median = ages[Math.floor(ages.length / 2)];
  return {
    // Early relative to the room, floored at two minutes — below that the post
    // has no comments to profile and no votes to read.
    minAgeMinutes: Math.max(2, Math.round(median * 60 * 0.05)),
    maxAgeHours: Math.max(0.1, Math.min(accountLimits.maxAgeHours, median * 1.2)),
    medianAgeHours: Math.round(median * 10) / 10,
  };
}

/** Does this title invite an answer? Title-only, because a feed has no body and
 *  no flair.
 *
 *  Used to RANK, never to reject. A post whose title is not a question may still
 *  have a body full of one, and rejecting it on the title alone would throw away
 *  good threads to save a call. Age is the only thing free data may decide. */
export function titleInvitesAnswer(title: string): boolean {
  const t = title.trim();
  if (t.endsWith('?')) return true;
  return /^(how|what|why|when|where|which|should|is|are|do|does|did|can|could|would|has|have|anyone|am i|looking for|need help|help|advice)\b/i.test(
    t,
  );
}

/**
 * Order the survivors for the paid reads.
 *
 * Takes no clock: both keys are relative to each other, so "now" would change
 * nothing about the order.
 *
 * Freshness inside the window first — the earlier a comment lands on a rising
 * thread the longer it has to compound, and Reddit's confidence sort makes that
 * compounding steep — with question-shaped titles preferred at equal age,
 * because they are the threads most likely to have a gap worth filling.
 */
export function rankDiscovered(posts: DiscoveredPost[]): DiscoveredPost[] {
  return [...posts].sort((a, b) => {
    const invites = Number(titleInvitesAnswer(b.title)) - Number(titleInvitesAnswer(a.title));
    if (invites !== 0) return invites;
    return b.createdAtMs - a.createdAtMs;
  });
}
