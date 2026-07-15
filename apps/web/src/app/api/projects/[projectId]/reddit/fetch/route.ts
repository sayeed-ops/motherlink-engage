import { NextResponse } from 'next/server';
import { requireProjectPermission, type Caller } from '@/server/auth';
import { withAuth, jsonBody, badRequest } from '@/server/route';
import { runThrottled } from '@/modules/reddit/throttle';
import {
  fetchSubredditRss,
  searchSubredditRss,
  dedupe,
  clampLimit,
  buildSearchQuery,
  MAX_SUBREDDITS,
  MAX_KEYWORDS,
} from '@/modules/reddit/rss';
import { saveFetchedItems } from '@/modules/reddit/store';
import type { NormalizedRedditPost } from '@/modules/reddit/types';

// POST /api/projects/:projectId/reddit/fetch
//
// Replaces ML Studio's /api/reddit-visibility/fetch-posts AND search-posts,
// which were two routes sharing ~90 lines of copy-pasted parsing. The compute
// is unchanged; what is new is everything around it.
//
// ML Studio's version has NO auth. Anyone on the internet can POST to it and
// spend the paid IPRoyal residential bandwidth — verified against production
// from a terminal: an anonymous curl returned 25 real posts. It is also
// project-agnostic: the browser passes whatever subreddits it likes.
//
// Here the caller must hold items.fetch ON THIS PROJECT. `items.fetch` is a
// distinct permission precisely because it spends metered money; a reviewer who
// should only read drafts has no business burning bandwidth.

interface Body {
  mode?: 'new' | 'search';
  subreddits?: unknown;
  keywords?: unknown;
  limit?: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withAuth<Ctx>(async (req: Request, caller: Caller, ctx: Ctx) => {
  const { projectId } = await ctx.params;
  await requireProjectPermission(caller, projectId, 'items.fetch');

  const body = await jsonBody<Body>(req);
  const mode = body.mode === 'search' ? 'search' : 'new';
  const subreddits = strings(body.subreddits);
  const keywords = strings(body.keywords);
  const limit = clampLimit(body.limit);

  if (subreddits.length === 0) return badRequest('No subreddits provided.');
  if (subreddits.length > MAX_SUBREDDITS) {
    return badRequest(`Too many subreddits (max ${MAX_SUBREDDITS}).`);
  }
  if (mode === 'search') {
    if (keywords.length === 0) return badRequest('Search needs at least one keyword.');
    if (keywords.length > MAX_KEYWORDS) return badRequest(`Too many keywords (max ${MAX_KEYWORDS}).`);
  }

  // Sequential with a 400ms gap. Reddit rate-limits per IP, and bursting the
  // rotating proxy still trips it. runThrottled catches per-item errors and
  // returns results in input order.
  const results = await runThrottled(subreddits, (s) =>
    mode === 'search' ? searchSubredditRss(s, keywords, limit) : fetchSubredditRss(s, limit),
  );

  const posts: NormalizedRedditPost[] = [];
  const errors: { subreddit: string; message: string }[] = [];
  const hitsBySubreddit: Record<string, number> = {};

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      posts.push(...r.value);
      hitsBySubreddit[subreddits[i]] = r.value.length;
    } else {
      // A failing subreddit is reported, never thrown. One transient 429 must
      // not fail the whole run — and downstream, purge is scoped to the
      // subreddits that actually succeeded, so an errored sub's history is
      // never mistaken for "no longer relevant" and deleted.
      errors.push({
        subreddit: subreddits[i],
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  const unique = dedupe(posts);

  // Persist here, on the server. ML Studio returns the posts and lets the
  // browser write them one at a time with the client SDK.
  //
  // Existing items are never overwritten, so processingStatus and isFavorite
  // survive a re-fetch. isFavorite especially: it is a purge-retention flag,
  // and resetting it to false would quietly make favourited posts eligible for
  // deletion on the next purge.
  const saved = await saveFetchedItems(projectId, unique, caller.uid);

  return NextResponse.json({
    posts: unique,
    saved,
    errors,
    hitsBySubreddit,
    query: mode === 'search' ? buildSearchQuery(keywords) : null,
  });
});
