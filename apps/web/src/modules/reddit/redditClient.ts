// ============================================================
// Reddit fetch — calls our /api/reddit-visibility/fetch-posts route.
// (Direct browser fetch to reddit.com is CORS-blocked; direct
// server-side fetch to reddit.com JSON is anti-bot-blocked.
// The route uses Reddit's RSS feed, which is allowed server-side.)
// ============================================================

import type { NormalizedRedditPost } from './types';

export interface FetchAllResult {
  posts: NormalizedRedditPost[];
  errors: { subreddit: string; message: string }[];
}

export interface SearchResult extends FetchAllResult {
  hitsBySubreddit: Record<string, number>;
  query: string;
}

export async function fetchAllSubreddits(
  subreddits: string[],
  limit: number = 25
): Promise<FetchAllResult> {
  const res = await fetch('/api/reddit-visibility/fetch-posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subreddits, limit }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as FetchAllResult;
}

export async function searchSubreddits(
  subreddits: string[],
  keywords: string[],
  limit: number = 25
): Promise<SearchResult> {
  const res = await fetch('/api/reddit-visibility/search-posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subreddits, keywords, limit }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as SearchResult;
}
