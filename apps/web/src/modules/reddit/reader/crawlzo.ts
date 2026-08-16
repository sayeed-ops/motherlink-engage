import 'server-only';

// The Crawlzo implementation of RedditReader. See docs/CRAWLZO-API.md.
//
// NOT the RSS path. `../rss.ts` goes to Reddit directly through a residential
// proxy because Reddit blocks that network, and it comes back with `score: 0`,
// `numComments: 0` and a hardcoded `isSelfPost: true`. This goes to a vendor who
// has already solved that, and every number it returns is real. The two share no
// code on purpose — placeholder zeros must never reach a system that treats them
// as measurements.
//
// EVERY CALL IS BILLED, including 404s. Two habits follow from that and are
// enforced here rather than left to callers:
//   - `post_id` over `url` (resolves without the subreddit, so no wasted lookup)
//   - the cheapest thread that answers the question: depth 1, no "more" rounds

import type {
  PostMediaKind,
  PostSummary,
  RedditReader,
  SearchOptions,
  ThreadComment,
  ThreadSnapshot,
} from './types';

const BASE = 'https://scrape.crawlzo.com/v1/scrapers';

/** Their error is structured; ours needs to say whether retrying is sane. */
export class CrawlzoError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'CrawlzoError';
  }
}

function apiKey(): string {
  const key = process.env.CRAWLZO_API_KEY?.trim();
  if (!key) {
    // Deliberately says what to DO. This is a deploy-time environment variable,
    // so no amount of admin rights fixes it from inside the app.
    throw new CrawlzoError(
      'UNCONFIGURED',
      false,
      'CRAWLZO_API_KEY is not set, so Reddit cannot be read. Set it in the deployment environment (and apps/web/.env.local for local dev), then restart.',
    );
  }
  return key;
}

interface Envelope<T> {
  success: boolean;
  status?: { code?: string; message?: string; retryable?: boolean };
  error?: { type?: string; detail?: string } | null;
  data: T | null;
}

async function call<T>(scraper: string, body: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(`${BASE}/${scraper}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey() },
    body: JSON.stringify(body),
    // Their docs are explicit that both endpoints are stateless and uncached.
    // Say so, rather than letting Next decide to cache a live scrape.
    cache: 'no-store',
  });

  let env: Envelope<T>;
  try {
    env = (await res.json()) as Envelope<T>;
  } catch {
    throw new CrawlzoError('BAD_RESPONSE', true, `Crawlzo returned non-JSON (HTTP ${res.status}).`);
  }

  if (env.success && env.data) return env.data;

  const code = env.status?.code ?? `HTTP_${res.status}`;
  const detail = env.error?.detail ?? env.status?.message ?? 'no detail';

  // A post that vanished between search and read is an ordinary outcome, not a
  // failure — it just costs money. Null, not an exception.
  if (code === 'NOT_FOUND') return null;

  throw new CrawlzoError(code, env.status?.retryable ?? res.status >= 500, `Crawlzo ${code}: ${detail}`);
}

/** Their `body_type` → ours.
 *
 *  `crosspost` becomes `unknown` rather than being resolved through
 *  `crosspost_parent_post`: the real content is one level down and we have not
 *  looked at it, and `unknown` is already the value selection rejects. */
function mediaKind(bodyType: unknown): PostMediaKind {
  switch (bodyType) {
    case 'self':
      return 'text';
    case 'link':
      return 'link';
    case 'image':
      return 'image';
    case 'gallery':
      return 'gallery';
    case 'video':
      return 'video';
    case 'poll':
      return 'poll';
    default:
      return 'unknown';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE BARE id, never the fullname.
 *
 * Crawlzo returns both: `id` is Reddit's fullname (`t3_1vq0sbi`) and `id_short`
 * is the same id without the prefix. Everything downstream of here wants the
 * bare one — the agent's find_target builds its own selector as
 * `t3_${redditPostId}`, so a fullname becomes `t3_t3_1vq0sbi` and matches
 * nothing, and its landed-check looks for the id inside the URL path, where
 * Reddit writes `/comments/1vq0sbi/` and never the prefix.
 *
 * That combination cost a live dry run on 2026-08-16: the walk browsed, failed
 * to find the card, navigated directly to the correct thread, and then aborted
 * saying it could not reach a thread it was looking at.
 *
 * Crawlzo itself accepts either form on reddit-post-v2, which is why every read
 * kept working and only the browser noticed.
 */
function bareId(p: { id?: unknown; id_short?: unknown }): string {
  const short = typeof p.id_short === 'string' ? p.id_short : '';
  return (short || String(p.id ?? '')).replace(/^t3_/i, '');
}

function toPost(p: any): PostSummary {
  return {
    redditPostId: bareId(p),
    subreddit: String(p.subreddit?.name ?? '').toLowerCase(),
    title: String(p.title ?? ''),
    // Never null — length checks downstream should not need a guard.
    body: typeof p.selftext === 'string' ? p.selftext : '',
    author: String(p.author?.name ?? '[deleted]'),
    permalink: String(p.permalink ?? ''),
    // created_utc is epoch SECONDS (and a float).
    createdAtMs: Math.round(Number(p.created_utc ?? 0) * 1000),
    score: Number(p.score ?? 0),
    numComments: Number(p.num_comments ?? 0),
    upvoteRatio: typeof p.upvote_ratio === 'number' ? p.upvote_ratio : null,
    flair: typeof p.flair?.text === 'string' ? p.flair.text : null,
    media: mediaKind(p.body_type),
    isLocked: !!p.locked,
    isArchived: !!p.archived,
    isStickied: !!p.stickied || !!p.pinned,
    isNsfw: !!p.over_18,
    isContestMode: !!p.contest_mode,
    isQuarantined: !!p.quarantine,
    // Either signal means a moderator or automod already acted.
    isRemoved: !!p.removed_by_category || !!p.removal_reason,
    isScoreHidden: !!p.hide_score || !!p.score_hidden,
  };
}

function toComment(c: any): ThreadComment {
  return {
    commentId: String(c.id ?? ''),
    author: String(c.author?.name ?? '[deleted]'),
    body: typeof c.body === 'string' ? c.body : '',
    score: Number(c.score ?? 0),
    createdAtMs: Math.round(Number(c.created_utc ?? 0) * 1000),
    isOp: !!c.is_submitter,
    // Loaded replies plus the ones Reddit collapsed behind a "more" stub. Using
    // only `replies.length` would make a 200-reply argument look like a quiet
    // thread, which is exactly backwards for the temperature check.
    replyCount: (Array.isArray(c.replies) ? c.replies.length : 0) + Number(c.more_reply_count ?? 0),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export function createCrawlzoReader(): RedditReader {
  return {
    async search(subreddit, query, opts: SearchOptions = {}): Promise<PostSummary[]> {
      const data = await call<{ posts?: unknown[] }>('reddit-search-v2', {
        query,
        subreddit,
        sort: opts.sort ?? 'new',
        // 'day' plus our own age window is the useful pair: their filter is
        // coarse, ours decides.
        time_filter: opts.time ?? 'day',
        pages: 1,
        limit_per_page: Math.min(opts.limit ?? 25, 50),
        include_nsfw: false,
        include_raw: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data?.posts ?? []).map((p: any) => toPost(p));
    },

    async getThread(redditPostId: string): Promise<ThreadSnapshot | null> {
      const data = await call<{ post?: unknown }>('reddit-post-v2', {
        post_id: redditPostId,
        // 'confidence' is Reddit's own Best sort — the order real readers see,
        // which is the order that decides whether our comment gets read.
        sort: 'confidence',
        comment_limit: 50,
        // TOP LEVEL ONLY, and no "more" rounds. The gap analysis asks what this
        // room has already said; a sub-thread three levels down is not part of
        // that answer, and each extra round is another billed upstream request.
        comment_depth: 1,
        max_more_requests: 0,
        include_raw: false,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = data?.post as any;
      if (!raw) return null;

      const comments: ThreadComment[] = (Array.isArray(raw.comments) ? raw.comments : [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c && typeof c.body === 'string' && c.body !== '[deleted]' && c.body !== '[removed]')
        .map(toComment)
        .sort((a: ThreadComment, b: ThreadComment) => b.score - a.score);

      return { post: toPost(raw), comments, fetchedAtMs: Date.now() };
    },
  };
}
