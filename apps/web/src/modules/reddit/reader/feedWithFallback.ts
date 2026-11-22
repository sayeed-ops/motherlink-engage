// Recent posts in a community: Reddit's own feed first, Crawlzo search when the
// feed is refused.
//
// Since 2026-11-20 Reddit answers its community feeds with 404 (RSS) and 403
// (JSON) for logged-out readers, our residential proxy included. Crawlzo's
// search still works, but it needs a query, so it searches the community for
// one of that community's own keywords, newest first. The age window and the
// thread checks downstream decide as before. A search is a billed call, so it
// is used only when the feed has failed.
//
// After the feed is refused once, it is skipped for a while rather than asked
// again for every community in the same run.

import type { DiscoveredPost, FeedDiscovery, ListingFeed } from '@/modules/forum/reader/discovery';
import type { ForumReader } from '@/modules/forum/reader/types';

const FEED_RETRY_AFTER_MS = 30 * 60_000;
let feedRefusedUntil = 0;

export interface FallbackOptions {
  /** The community's own keywords; the subreddit name in words when empty. */
  keywordsFor: (subreddit: string) => string[];
  random?: () => number;
  /** Called once per community that fell back, with the feed's error. */
  onFallback?: (subreddit: string, keyword: string, feedError: string) => void;
}

export function createFeedWithFallback(feed: FeedDiscovery, reader: ForumReader, opts: FallbackOptions): FeedDiscovery {
  const random = opts.random ?? Math.random;
  return {
    async list(subreddit: string, kind: ListingFeed, limit = 25): Promise<DiscoveredPost[]> {
      let feedError = 'skipped: Reddit refused its feeds recently';
      if (Date.now() >= feedRefusedUntil) {
        try {
          return await feed.list(subreddit, kind, limit);
        } catch (e) {
          feedError = String((e as Error)?.message ?? e);
          if (/HTTP (403|404|429)/.test(feedError)) feedRefusedUntil = Date.now() + FEED_RETRY_AFTER_MS;
        }
      }
      const words = opts.keywordsFor(subreddit).filter(Boolean);
      const keyword = words.length ? words[Math.floor(random() * words.length)] : subreddit.replace(/_/g, ' ');
      opts.onFallback?.(subreddit, keyword, feedError);
      const posts = await reader.search(subreddit, keyword, { sort: 'new', time: 'week', limit: Math.min(limit, 50) });
      return posts.map((p) => ({
        redditPostId: p.redditPostId.replace(/^t3_/i, ''),
        subreddit: p.subreddit || subreddit,
        title: p.title,
        permalink: p.permalink,
        createdAtMs: p.createdAtMs,
        author: p.author,
      }));
    },
  };
}
