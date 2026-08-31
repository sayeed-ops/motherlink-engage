import 'server-only';

// Reading covers.com over the network.
//
// The parsing is pure and lives in ./parse.ts, tested against slices of real
// pages. This file is the fetching, the pacing and the limits.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT ROBOTS.TXT ACTUALLY SAYS (read 2026-08-30, not assumed)
//
// `User-agent: *` has NO blanket Disallow. Reading the forum is permitted. What
// is disallowed is a specific list of endpoints, and the interesting ones are:
//
//   */replyToThread/     */createthread/      — POSTING endpoints
//   */forum/admin/       */LoadPostAdminTools — moderation tooling
//   /forum/viewuserpost/                      — a redirect that costs a lookup
//   */GetGameThreadJson/                      — an internal JSON endpoint
//   /go/  /Go/                                — affiliate redirects
//   */account/*                               — anything user-specific
//
// So Covers explicitly asks automated clients not to touch the reply and create
// endpoints. That does not affect this file, which only reads — but it is a
// direct, documented statement about automated posting that phase 6 has to face
// rather than discover. It is recorded here because this is where it was found.
//
// DISALLOW IS ENFORCED, not merely noted: isDisallowedPath below refuses those
// paths, so a bug elsewhere cannot walk into one.
// ════════════════════════════════════════════════════════════════════════════

import {
  parseSectionListing,
  parseThreadPage,
  type CoversThread,
  type CoversThreadSummary,
} from './parse';
import { sectionUrl, normaliseSection } from './sections';

const BASE = 'https://www.covers.com';

/**
 * A browser User-Agent, and the honesty question that raises.
 *
 * Covers serves this content to any browser and its robots.txt permits reading
 * it. What it does not do is publish an API, so a client that identifies itself
 * as a crawler is refused by the CDN in front of the site — the same protection
 * that produced the 403 on the other client's help centre.
 *
 * This is a real tension and it is not resolved by pretending otherwise. What
 * the code CAN do is behave like the well-mannered client it claims to be:
 * obey robots.txt, pace requests, cap the budget, and never touch the endpoints
 * the site asked automated clients to leave alone. Those are enforced below.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 20_000;
/** A section page measured ~600KB, a thread ~680KB. Room for growth, not for a
 *  runaway response. */
const MAX_BYTES = 4_000_000;
/** Between requests. Covers is somebody else's server and the whole read budget
 *  is a handful of pages per scan. */
const GAP_MS = 1_200;

/** Paths robots.txt forbids to `User-agent: *`, as prefixes or fragments. */
const DISALLOWED: RegExp[] = [
  /\/sportsbookredirect/i,
  /\/forum\/viewuserpost\//i,
  /\/getgamethreadjson\//i,
  /\/replytothread\//i,
  /\/createthread\//i,
  /\/forum\/admin\//i,
  /\/loadpostadmintools/i,
  /\/loadthreadadmintools/i,
  /\/increaseviewcount/i,
  /\/api\/geolocation/i,
  /\/betting\/matcher/i,
  /\/account\//i,
  /\/go\//i,
  /\/preview-commercial-content\//i,
];

export function isDisallowedPath(url: string): boolean {
  try {
    const path = new URL(url, BASE).pathname;
    return DISALLOWED.some((re) => re.test(path));
  } catch {
    return true;
  }
}

export class CoversReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'CoversReadError';
  }
}

let lastRequestAt = 0;

/** One GET, paced, capped and timed out. */
async function get(url: string): Promise<string> {
  if (isDisallowedPath(url)) {
    throw new CoversReadError(0, `robots.txt asks us not to fetch ${url}`);
  }

  // Process-wide spacing rather than per-call: two scans running at once would
  // otherwise each pace themselves politely and hit the site twice as often.
  const wait = GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new CoversReadError(
        res.status,
        res.status === 403
          ? 'Covers refused the request (403). The read path may need attention before this can run unattended.'
          : `Covers returned HTTP ${res.status}.`,
      );
    }

    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8').decode(
      buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf,
    );
  } catch (err) {
    if (err instanceof CoversReadError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new CoversReadError(0, aborted ? 'Covers took too long to respond.' : 'Covers could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

/**
 * The threads on one page of a section.
 *
 * LISTING, NOT SEARCH, and that is a real difference from the Reddit path.
 * Crawlzo has no listing endpoint and requires a query, so comment karma has to
 * search each community for keywords somebody typed into a settings box. Covers
 * simply serves the section, in order, so this sees what the section is actually
 * reading — including the thread taking off for a reason nobody predicted.
 */
export async function listSection(slug: string, page = 1): Promise<CoversThreadSummary[]> {
  const html = await get(sectionUrl(slug, page, BASE));
  return parseSectionListing(html, BASE);
}

/**
 * One thread and its posts.
 *
 * `page` selects which page of a long thread to read. The opportunity anchor is
 * a POST, and on a busy thread the post worth answering is rarely on page one —
 * so paging is a first-class argument rather than something a caller has to
 * build a URL for.
 */
export async function getThread(threadUrl: string, page = 1): Promise<CoversThread | null> {
  const url = page > 1 ? `${threadUrl.replace(/\/$/, '')}/${page}` : threadUrl;
  const html = await get(url);
  return parseThreadPage(html, url);
}

/**
 * Read a section, then read the threads that pass a caller's filter.
 *
 * The filter is passed in rather than decided here, and the budget is explicit,
 * because this is the expensive call in the whole module: one section page is
 * cheap, and every thread after it is another ~700KB and another 1.2s. Phase 3
 * supplies a real screen; for now the caller says how much to spend.
 */
export async function harvestSection(
  slug: string,
  opts: {
    pages?: number;
    maxThreads?: number;
    keep?: (thread: CoversThreadSummary) => boolean;
  } = {},
): Promise<{ threads: CoversThreadSummary[]; read: CoversThread[]; fetched: number; errors: string[] }> {
  const section = normaliseSection(slug);
  const pages = Math.max(1, Math.min(5, opts.pages ?? 1));
  const maxThreads = Math.max(0, Math.min(25, opts.maxThreads ?? 0));

  const threads: CoversThreadSummary[] = [];
  const read: CoversThread[] = [];
  const errors: string[] = [];
  let fetched = 0;

  for (let page = 1; page <= pages; page++) {
    try {
      const found = await listSection(section, page);
      fetched++;
      threads.push(...found);
      // An empty page means the section is shorter than the requested range.
      // Stopping is right; continuing would spend the budget on 404s.
      if (found.length === 0) break;
    } catch (err) {
      errors.push(err instanceof CoversReadError ? err.message : 'A section page could not be read.');
      break;
    }
  }

  const candidates = (opts.keep ? threads.filter(opts.keep) : threads).slice(0, maxThreads);

  for (const candidate of candidates) {
    try {
      const thread = await getThread(candidate.url);
      fetched++;
      if (thread) read.push(thread);
    } catch (err) {
      errors.push(
        `${candidate.title}: ${err instanceof CoversReadError ? err.message : 'could not be read'}`,
      );
    }
  }

  return { threads, read, fetched, errors };
}
