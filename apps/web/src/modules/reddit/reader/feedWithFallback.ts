// Recent posts in a community: Reddit's own feed first, Crawlzo search when the
// feed is refused.
//
// Since 2026-11-20 Reddit answers its community feeds with 404 (RSS) and 403
// (JSON) for logged-out readers, our residential proxy included. Crawlzo's
// search still works, but it needs a query. The query is `self:yes` — every
// text post — newest first, so the fallback is the community's own New page
// (text posts only, which is all we comment on), not a keyword match.
//
// It used to search one of the community's keywords instead. A phrase like
// "beginner homebrewing tips" matched 2 posts in a week, mostly days old, and
// with the age window downstream not one autopilot comment run found two
// threads to choose from (seen 2026-11-22/23). The age window and the thread
// checks downstream decide as before. A search is a billed call, so it is used
// only when the feed has failed.
//
// After the feed is refused once, it is skipped for a while rather than asked
// again for every community in the same run.

import type { DiscoveredPost, FeedDiscovery, ListingFeed } from '@/modules/forum/reader/discovery';
import type { ForumReader } from '@/modules/forum/reader/types';

const FEED_RETRY_AFTER_MS = 30 * 60_000;
const ALL_TEXT_POSTS = 'self:yes';
let feedRefusedUntil = 0;

export interface FallbackOptions {
  /** Called once per community that fell back, with the feed's error. */
  onFallback?: (subreddit: string, feedError: string) => void;
}

export function createFeedWithFallback(feed: FeedDiscovery, reader: ForumReader, opts: FallbackOptions = {}): FeedDiscovery {
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
      opts.onFallback?.(subreddit, feedError);
      const posts = await reader.search(subreddit, ALL_TEXT_POSTS, { sort: 'new', time: 'week', limit: Math.min(limit, 50) });
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
