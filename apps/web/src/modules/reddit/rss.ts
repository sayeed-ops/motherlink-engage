import 'server-only';

import type { NormalizedRedditPost } from './types';
import { fetchWithRetry } from './redditFetch';

// Reddit RSS fetching and Atom parsing.
//
// PORTED VERBATIM in behaviour from ML Studio's fetch-posts and search-posts
// routes, which contain ~90 lines of identical copy-pasted parsing between
// them. This is the single copy. Anything below that looks strange is strange
// on purpose — the comments record why, and every one of them was paid for.
//
// Why RSS at all, in the order it was learned:
//   Apify            worked, slow, $45/mo actor. Code fully removed.
//   /r/<sub>.json    HTTP 403 for this network. Dead.
//   old.reddit HTML  429.
//   Python scrapers  wrong stack, all punt to proxies anyway.
//   Official API     Nov-2025 Responsible Builder Policy gates approval 2-4
//                    weeks, and a promotional use case will not pass. Applying
//                    honestly can flag the accounts. Confirmed by trying.
//
// RSS is the ONE endpoint that returns 200 — but only with a browser
// User-Agent, and only through a rotating residential proxy. Do not "fix" this
// back to the JSON API.

/**
 * Reddit throttles obvious bot agents far harder than browser traffic on the
 * unauthenticated RSS feeds. This is not a Reddit-API-compliant descriptive UA
 * and cannot be, because compliance requires an API key we cannot obtain.
 */
export const REDDIT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Reddit's search.rss WAF rejects bare Node-fetch requests with 403 even though
 * the same URL via curl returns 200. This fuller header set gets past it.
 */
const BROWSERISH_HEADERS = {
  'User-Agent': REDDIT_USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
} as const;

export const MAX_SUBREDDITS = 20;
export const MAX_KEYWORDS = 15;
export const DEFAULT_LIMIT = 25;

function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/** Reddit RSS double-encodes (XML-wrapped HTML), so iterate until stable. */
function decodeEntities(s: string): string {
  let prev = s;
  for (let i = 0; i < 4; i++) {
    const next = decodeEntitiesOnce(prev);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

function stripHtml(html: string): string {
  // The <content type="html"> body is entity-encoded — decode first so tags
  // become real `<...>`, then strip. Also drop SC_OFF/SC_ON comments, the
  // trailing vote/links/comments anchors, and Reddit's "submitted by" footer.
  const decoded = decodeEntities(html);
  return decoded
    .replace(/<!--\s*SC_O(?:FF|N)\s*-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[link\]|\[comments\]/g, '')
    .replace(/submitted by\s*\/u\/[\w-]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extract(source: string, regex: RegExp): string {
  const m = source.match(regex);
  return m ? m[1] : '';
}

export function parseAtomFeed(xml: string, fallbackSub: string): NormalizedRedditPost[] {
  const entries: NormalizedRedditPost[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRegex.exec(xml)) !== null) {
    const e = m[1];

    // <id> is like "tag:reddit.com,2008:/r/sub/comments/abc123/..." or
    // sometimes just "t3_abc123". Extract the 5-7 char post id either way.
    const idRaw = extract(e, /<id>([^<]+)<\/id>/);
    const idMatch = idRaw.match(/t3_([a-z0-9]+)/i) || idRaw.match(/\/comments\/([a-z0-9]+)/i);
    const redditPostId = idMatch ? idMatch[1] : '';
    if (!redditPostId) continue;

    const title = decodeEntities(extract(e, /<title[^>]*>([\s\S]*?)<\/title>/));
    const linkHref = extract(e, /<link[^>]*href="([^"]+)"/);
    const author = extract(e, /<author>[\s\S]*?<name>([^<]+)<\/name>/).replace(/^\/u\//, '');
    const published = extract(e, /<published>([^<]+)<\/published>/);
    const category = extract(e, /<category[^>]*term="([^"]+)"/);
    const contentRaw = extract(e, /<content[^>]*>([\s\S]*?)<\/content>/);

    entries.push({
      redditPostId,
      subreddit: category || fallbackSub,
      title,
      body: stripHtml(contentRaw),
      author: author || '[deleted]',
      url: linkHref,
      permalink: linkHref,
      // RSS exposes none of these reliably. The UI hides zero metrics rather
      // than showing a wrong number.
      isSelfPost: true,
      score: 0,
      numComments: 0,
      createdAtRedditMs: published ? new Date(published).getTime() : 0,
    });
  }
  return entries;
}

export function normalizeSubreddit(raw: string): string {
  return raw.replace(/^\/?r\//i, '');
}

/** Quote multi-word phrases, leave single tokens bare. Join with OR. */
export function buildSearchQuery(keywords: string[]): string {
  return keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (k.includes(' ') ? `"${k.replace(/"/g, '')}"` : k))
    .join(' OR ');
}

async function getFeed(url: string, sub: string): Promise<NormalizedRedditPost[]> {
  const res = await fetchWithRetry(url, { headers: BROWSERISH_HEADERS, cache: 'no-store' });
  if (!res.ok) throw new Error(`r/${sub}: HTTP ${res.status}`);
  return parseAtomFeed(await res.text(), sub);
}

/** Newest posts from a subreddit. */
export async function fetchSubredditRss(
  subreddit: string,
  limit: number,
): Promise<NormalizedRedditPost[]> {
  const sub = normalizeSubreddit(subreddit);
  return getFeed(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss?limit=${limit}`, sub);
}

/**
 * Keyword search within a subreddit.
 *
 * Note sort=relevance, not sort=new. ML Studio's header comment claims `new`
 * while the code sends `relevance`; the code is what has been running, so the
 * code is what ports. Changing it would alter which posts surface and break
 * parity testing.
 */
export async function searchSubredditRss(
  subreddit: string,
  keywords: string[],
  limit: number,
): Promise<NormalizedRedditPost[]> {
  const sub = normalizeSubreddit(subreddit);
  const q = buildSearchQuery(keywords);
  return getFeed(
    `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss` +
      `?q=${encodeURIComponent(q)}&restrict_sr=1&sort=relevance&limit=${limit}`,
    sub,
  );
}

/** Dedupe by redditPostId, preserving first-seen order. */
export function dedupe(posts: NormalizedRedditPost[]): NormalizedRedditPost[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    if (seen.has(p.redditPostId)) return false;
    seen.add(p.redditPostId);
    return true;
  });
}

export function clampLimit(value: unknown): number {
  return typeof value === 'number' && value > 0 && value <= 100 ? Math.floor(value) : DEFAULT_LIMIT;
}
