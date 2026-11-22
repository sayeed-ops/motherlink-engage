import 'server-only';

// Project fetching through Crawlzo.
//
// Since 2026-11-20 Reddit answers its RSS (/new/.rss, /search.rss) with 404 to
// logged-out readers, our residential proxy included, so project fetching
// returned nothing. Crawlzo has no subreddit listing, only search, and its
// search needs a query. Reddit's own search operators work inside that query:
//
//   New     query `self:yes` (every text post), newest first. Image and link
//           posts are left out, which suits us: we only reply to text posts.
//   Search  the project's keywords joined with OR, newest first.
//
// Both come from Reddit's search index, which can trail the live New page a
// little. The window is the last week: Crawlzo's time_filter DOES narrow a
// newest-first search (a day gave 3 posts in r/SEO, a week 50), whatever its
// docs say. One billed call per subreddit, at most 50 posts.

import { createCrawlzoReader } from './reader/crawlzo';
import { buildSearchQuery, normalizeSubreddit } from './rss';
import type { NormalizedRedditPost } from './types';
import type { PostSummary } from '@/modules/forum/reader/types';

const MAX_PER_CALL = 50;

function toNormalized(p: PostSummary, sub: string): NormalizedRedditPost {
  return {
    redditPostId: p.redditPostId.replace(/^t3_/i, ''),
    subreddit: p.subreddit || sub,
    title: p.title,
    body: p.body,
    author: p.author || '[deleted]',
    url: p.permalink,
    permalink: p.permalink,
    isSelfPost: p.media === 'text',
    score: p.score,
    numComments: p.numComments,
    createdAtRedditMs: p.createdAtMs,
  };
}

/** The newest text posts in a subreddit. */
export async function fetchSubredditNew(subreddit: string, limit: number): Promise<NormalizedRedditPost[]> {
  const sub = normalizeSubreddit(subreddit);
  const posts = await createCrawlzoReader().search(sub, 'self:yes', { sort: 'new', time: 'week', limit: Math.min(limit, MAX_PER_CALL) });
  return posts.map((p) => toNormalized(p, sub));
}

/** The newest posts in a subreddit matching any of the keywords. */
export async function searchSubreddit(subreddit: string, keywords: string[], limit: number): Promise<NormalizedRedditPost[]> {
  const sub = normalizeSubreddit(subreddit);
  const posts = await createCrawlzoReader().search(sub, buildSearchQuery(keywords), { sort: 'new', time: 'week', limit: Math.min(limit, MAX_PER_CALL) });
  return posts.map((p) => toNormalized(p, sub));
}
