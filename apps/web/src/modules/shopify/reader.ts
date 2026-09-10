import 'server-only';

// Reading community.shopify.com over the network.
//
// The parsing is pure and lives in ./categories.ts and ./topics.ts. This file
// is the fetching, the pacing and the limits — same split as
// modules/covers/reader.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// IT IS DISCOURSE, AND THAT CHANGES THE WHOLE SHAPE OF THIS MODULE
//
// Every page has a JSON twin. There is no HTML parser here and there will not
// be one: `/c/{slug}/{id}/l/{sort}.json` returns the board, `/t/{slug}/{id}.json`
// returns a thread with its posts. Covers needed 18KB of regex against 600KB
// pages to get less than this payload hands over for free.
//
// WHAT ROBOTS.TXT ACTUALLY SAYS (read 2026-09-10, not assumed)
//
// `User-agent: *` has NO blanket Disallow — reading is permitted. What it
// forbids, and the ones that matter to us:
//
//   /search           — no search scraping
//   /c/*.rss  /t/*/*.rss  — the feeds specifically
//   /tag/*/l          — tag listings. NOTE: /c/*/l is NOT forbidden.
//   /my  /g  /badges  — member and group pages
//   /admin/  /auth/  /session  /user-api-key  /*?api_key*
//   /c/uncategorized/1
//
// ⚠️ Unlike Covers — which explicitly disallowed */replyToThread/ and
// */createthread/ — Shopify does NOT forbid its posting endpoints here. That
// removes the specific wall Covers hit, and it is NOT a licence to post: terms
// of service are a separate document from robots.txt and have to be read on
// their own before anything is written to this site. Recorded here because this
// is where it was found.
//
// DISALLOW IS ENFORCED, not merely noted: isDisallowedPath refuses those paths,
// so a bug elsewhere cannot walk into one.
// ════════════════════════════════════════════════════════════════════════════

import {
  SHOPIFY_COMMUNITY_BASE,
  categoryListUrl,
  parseCategoryList,
  topicUrl,
  type ShopifyCategory,
  type ShopifySort,
} from './categories';
import { parseTopicList, type ShopifyTopic } from './topics';

/**
 * We identify ourselves.
 *
 * Covers sits behind a CDN that refuses any client admitting to being a
 * crawler, which forced a browser User-Agent and an uncomfortable paragraph
 * explaining why. Shopify's community publishes a JSON API and serves it
 * without that fight, so there is no reason to pretend to be Chrome — and every
 * reason not to. A named agent is one a site owner can allow, rate-limit or
 * contact, which is the whole social contract of reading somebody's server.
 */
const USER_AGENT = 'MotherlinkEngage/1.0 (+https://motherlink.io; forum research; contact sayeed@motherlink.io)';

const TIMEOUT_MS = 20_000;
/** A board listing measured ~90KB, a 23-post thread ~77KB. Room for a long
 *  thread, not for a runaway response. */
const MAX_BYTES = 4_000_000;
/** Between requests. Discourse rate-limits, and this is somebody else's server
 *  for a read budget of a few dozen pages. */
const GAP_MS = 1_000;

/** Paths robots.txt forbids to `User-agent: *`. Fragments, matched against the
 *  path we are about to request. */
const DISALLOWED: RegExp[] = [
  /^\/search\b/i,
  /^\/my\b/i,
  /^\/g\b/i,
  /^\/badges\b/i,
  /^\/admin\//i,
  /^\/auth\//i,
  /^\/email\//i,
  /^\/session\b/i,
  /^\/user-api-key\b/i,
  /^\/tag\/[^/]+\/l\b/i,
  /^\/c\/uncategorized\/1\b/i,
  /\.rss$/i,
  /[?&]api_key=/i,
];

export function isDisallowedPath(url: string): boolean {
  let path: string;
  try {
    const u = new URL(url, SHOPIFY_COMMUNITY_BASE);
    path = `${u.pathname}${u.search}`;
  } catch {
    // Unparseable is refused rather than passed through: a URL we cannot
    // inspect is one we cannot promise anything about.
    return true;
  }
  return DISALLOWED.some((re) => re.test(path));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests are paced against a module-level clock rather than a per-call
 *  delay, so two callers in the same process cannot both "wait 1s" and then
 *  fire together. */
let lastRequestAt = 0;

async function pace(): Promise<void> {
  const since = Date.now() - lastRequestAt;
  if (since < GAP_MS) await sleep(GAP_MS - since);
  lastRequestAt = Date.now();
}

export class ShopifyReadError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ShopifyReadError';
    this.status = status;
  }
}

/**
 * One GET, JSON out.
 *
 * Refuses a disallowed path before opening a socket, caps the body, and gives
 * a 429 its own message — a rate limit is a thing to slow down for, not a bug
 * to report as "the forum could not be read".
 */
async function getJson(url: string): Promise<unknown> {
  if (isDisallowedPath(url)) {
    throw new ShopifyReadError(`robots.txt disallows ${url} — refused before the request.`);
  }

  await pace();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
  } catch (err) {
    clearTimeout(timer);
    const why = err instanceof Error && err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : String(err);
    throw new ShopifyReadError(`Could not reach the community: ${why}`);
  }
  clearTimeout(timer);

  if (res.status === 429) {
    throw new ShopifyReadError('The community is rate-limiting us. Wait a minute and read fewer boards at once.', 429);
  }
  if (res.status === 404) {
    throw new ShopifyReadError('That board or topic no longer exists.', 404);
  }
  if (!res.ok) {
    throw new ShopifyReadError(`The community answered ${res.status}.`, res.status);
  }

  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) {
    throw new ShopifyReadError(`Response is ${len} bytes, over the ${MAX_BYTES} cap.`);
  }

  const text = await res.text();
  if (text.length > MAX_BYTES) {
    throw new ShopifyReadError(`Response is ${text.length} bytes, over the ${MAX_BYTES} cap.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    // Discourse serves an HTML error page for some failures with a 200. Saying
    // "not JSON" is more useful than a parser stack trace.
    throw new ShopifyReadError('The community answered with something that was not JSON.');
  }
}

/**
 * Every board the community publishes.
 *
 * Fetched live rather than shipped as a constant, because the operator can
 * select ANY category and a hardcoded list would silently omit whatever
 * Shopify added last month. DEFAULT_CATEGORIES exists only to seed a new
 * project's configuration.
 */
export async function fetchCategories(): Promise<ShopifyCategory[]> {
  return parseCategoryList(await getJson(`${SHOPIFY_COMMUNITY_BASE}/categories.json`));
}

export interface ListPage {
  topics: ShopifyTopic[];
  /** Discourse's own next-page link. Preferred over building one: it carries
   *  the ordering's internal cursor, which a hand-built `?page=` does not. */
  moreUrl: string | null;
}

/** One page of one board in one ordering. */
export async function fetchTopicPage(
  category: Pick<ShopifyCategory, 'id' | 'slug'>,
  sort: ShopifySort,
  page = 0,
): Promise<ListPage> {
  return parseTopicList(await getJson(categoryListUrl(category, sort, page)));
}

/**
 * Up to `maxPages` of a board, stopping early when it runs out.
 *
 * The cap is a request budget, not a target. Duplicate ids across pages are
 * dropped — Discourse can repeat a topic when it is bumped mid-read, and a
 * board that returns the same thread twice would otherwise be counted twice.
 */
export async function fetchTopics(
  category: Pick<ShopifyCategory, 'id' | 'slug'>,
  sort: ShopifySort,
  maxPages: number,
): Promise<{ topics: ShopifyTopic[]; pagesRead: number; truncated: boolean }> {
  const pages = Math.max(1, Math.min(20, Math.round(maxPages)));
  const seen = new Set<number>();
  const topics: ShopifyTopic[] = [];
  let more: string | null = null;
  let read = 0;

  for (let p = 0; p < pages; p++) {
    const url: string = more ? new URL(more, SHOPIFY_COMMUNITY_BASE).toString() : categoryListUrl(category, sort, p);
    const raw: unknown = await getJson(ensureJsonPath(url));
    const parsed = parseTopicList(raw);
    read++;

    for (const t of parsed.topics) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      topics.push(t);
    }

    more = parsed.moreUrl;
    if (!more || parsed.topics.length === 0) return { topics, pagesRead: read, truncated: false };
  }

  return { topics, pagesRead: read, truncated: more !== null };
}

/** `more_topics_url` comes back without the `.json` suffix. Adding it keeps us
 *  on the JSON API rather than silently fetching a 600KB HTML page. */
function ensureJsonPath(url: string): string {
  const u = new URL(url, SHOPIFY_COMMUNITY_BASE);
  if (!u.pathname.endsWith('.json')) u.pathname = `${u.pathname}.json`;
  return u.toString();
}

/** One topic with its posts, raw. Parsing the conversation is stage two's job
 *  and lives in ./discussion.ts. */
export async function fetchTopicRaw(id: number, slug: string): Promise<unknown> {
  return getJson(topicUrl(id, slug));
}
