// A RedditReader backed by data you hand it, plus builders for making that data.
//
// Why this exists before the real client: selection, gap analysis and the gates
// are the parts most likely to be got subtly wrong, and none of them need a
// network. Building them against fixtures means they are testable from the
// first commit, in `node --test`, with no emulator and no API key — and it means
// the real reader can arrive late without holding anything up.
//
// PURE, like ./types.ts. Tests import the builders directly.

import type {
  PostSummary,
  RedditReader,
  SearchOptions,
  ThreadComment,
  ThreadSnapshot,
} from './types';

/** Fixed clock for fixtures. Tests pass explicit ages relative to a `now` they
 *  choose, so nothing here may read the real time — and `warmupWalk.ts` already
 *  learned that lesson the expensive way with a constant seed. */
export const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

/**
 * Build a post. Defaults describe the boring, eligible case — a text post, two
 * hours old, modestly upvoted, uncrowded — so a test only states the ONE thing
 * it is about:
 *
 *     makePost({ media: 'image' })        // the rejection under test
 *     makePost({ ageMinutes: 600 })       // too old
 */
export function makePost(over: Partial<PostSummary> & { ageMinutes?: number } = {}): PostSummary {
  const { ageMinutes, ...rest } = over;
  const createdAtMs =
    rest.createdAtMs ?? FIXTURE_NOW_MS - (ageMinutes ?? 120) * 60_000;

  return {
    redditPostId: 't3_fixture',
    subreddit: 'askreddit',
    title: 'What is something you wish you had learned earlier?',
    body: 'Been thinking about this a lot lately and wondered what other people would say.',
    author: 'some_user',
    permalink: '/r/askreddit/comments/fixture/what_is_something/',
    createdAtMs,
    score: 40,
    numComments: 12,
    upvoteRatio: 0.94,
    flair: null,
    media: 'text',
    isLocked: false,
    isArchived: false,
    isStickied: false,
    isNsfw: false,
    isContestMode: false,
    isQuarantined: false,
    isRemoved: false,
    isScoreHidden: false,
    ...rest,
  };
}

/** Build one top-level comment. */
export function makeComment(over: Partial<ThreadComment> = {}): ThreadComment {
  return {
    commentId: 't1_fixture',
    author: 'commenter',
    body: 'Learn to say no earlier than I did.',
    score: 8,
    createdAtMs: FIXTURE_NOW_MS - 60 * 60_000,
    isOp: false,
    replyCount: 0,
    ...over,
  };
}

/** Build a thread. Comments are sorted score-descending here rather than at the
 *  call site, so a test can list them in any order and still exercise the same
 *  ordering guarantee the interface promises. */
export function makeThread(
  post: PostSummary = makePost(),
  comments: ThreadComment[] = [],
  fetchedAtMs: number = FIXTURE_NOW_MS,
): ThreadSnapshot {
  return {
    post,
    comments: [...comments].sort((a, b) => b.score - a.score),
    fetchedAtMs,
  };
}

export interface FixtureData {
  /** subreddit (bare, lowercase) → the posts a search there should return.
   *  Keyed by subreddit rather than by (subreddit, query) because no test so far
   *  cares which keyword surfaced a post — only that it did. */
  listings?: Record<string, PostSummary[]>;
  /** redditPostId → the thread. */
  threads?: Record<string, ThreadSnapshot>;
}

/**
 * A reader over in-memory data.
 *
 * Unknown subreddit → empty listing; unknown post → null. Both mirror what the
 * real client must do, so code written against fixtures already handles the
 * cases that actually occur (a removed post, a sub with nothing fresh).
 */
export function createFixtureReader(data: FixtureData = {}): RedditReader {
  const listings = data.listings ?? {};
  const threads = data.threads ?? {};

  return {
    async search(subreddit: string, _query: string, opts: SearchOptions = {}): Promise<PostSummary[]> {
      return (listings[subreddit.toLowerCase()] ?? []).slice(0, opts.limit ?? 25);
    },
    async getThread(redditPostId: string): Promise<ThreadSnapshot | null> {
      return threads[redditPostId] ?? null;
    },
  };
}
