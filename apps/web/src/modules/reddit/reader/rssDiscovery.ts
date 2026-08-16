import 'server-only';

// Reddit's own feeds, read through the residential proxy.
//
// The one part of comment karma that does not go through Crawlzo, because
// Crawlzo cannot do it: its search endpoint requires a `query`, so there is no
// way to ask it what a community is reading right now. Reddit's RSS needs no
// query and no key.
//
// IT REUSES ../rss.ts's PARSER, AND THE STANDING RULE ABOUT THAT FILE IS
// RESPECTED RATHER THAN BROKEN. The rule is that `score: 0`, `numComments: 0`
// and the hardcoded `isSelfPost: true` must never reach code that reads them as
// measurements. Here they reach nothing: toDiscovered() maps into
// DiscoveredPost, which HAS NO SUCH FIELDS, so the placeholders are dropped at
// the boundary and cannot be read downstream even by mistake.
//
// The alternative was a second Atom parser. That file's entity decoding is
// genuinely hard-won — Reddit double-encodes XML-wrapped HTML, and the comment
// history says every strange line in it was paid for — and two copies would
// drift the first time Reddit changed a feed. One parser, and the dangerous
// half of its output structurally discarded, is the safer trade.

import { fetchWithRetry } from '../redditFetch';
import { normalizeSubreddit, parseAtomFeed, REDDIT_USER_AGENT } from '../rss';
import type { DiscoveredPost, ListingFeed, RedditDiscovery } from './discovery';

/** Reddit's WAF 403s a bare Node fetch on these feeds; this header set gets
 *  past it. Same reasoning and same values as ../rss.ts. */
const BROWSERISH_HEADERS = {
  'User-Agent': REDDIT_USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
} as const;

/** Reddit serves each ordering at its own path. `hot` is the bare feed. */
function feedUrl(sub: string, feed: ListingFeed, limit: number): string {
  const base = `https://www.reddit.com/r/${encodeURIComponent(sub)}`;
  const path = feed === 'hot' ? '/.rss' : `/${feed}/.rss`;
  return `${base}${path}?limit=${limit}`;
}

export function createRssDiscovery(): RedditDiscovery {
  return {
    async list(subreddit: string, feed: ListingFeed, limit = 25): Promise<DiscoveredPost[]> {
      const sub = normalizeSubreddit(subreddit);
      const res = await fetchWithRetry(feedUrl(sub, feed, Math.min(Math.max(limit, 1), 100)), {
        headers: BROWSERISH_HEADERS,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`r/${sub} ${feed} feed: HTTP ${res.status}`);

      return parseAtomFeed(await res.text(), sub).map(toDiscovered);
    },
  };
}

/** The boundary where the fabricated numbers are dropped.
 *
 *  Everything this returns is something the feed genuinely said. Score, comment
 *  count and post type are NOT here and must be read from a paid
 *  reddit-post-v2 call — see ./discovery.ts. */
function toDiscovered(post: {
  redditPostId: string;
  subreddit: string;
  title: string;
  author: string;
  permalink: string;
  createdAtRedditMs: number;
}): DiscoveredPost {
  return {
    redditPostId: post.redditPostId,
    subreddit: post.subreddit.toLowerCase(),
    title: post.title,
    permalink: post.permalink,
    createdAtMs: post.createdAtRedditMs,
    author: post.author,
  };
}
