// Reading covers.com's HTML.
//
// PURE — HTML in, values out. The fetching lives in ./reader.ts. Every rule here
// is tested against slices of real pages saved in tests/fixtures/covers, which
// is the only honest way to write a scraper: the markup is somebody else's and
// it will change without telling us.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THE SITE ACTUALLY GIVES US (measured 2026-08-30, not assumed)
//
// Covers is SERVER-RENDERED. A section page is ~600KB of HTML carrying ~24KB of
// visible text, with about 30KB of script — the content is in the document, so
// no browser is needed. That was the one genuine unknown in this whole phase and
// it came back the easy way.
//
// Every post carries its own identity in data attributes:
//   data-post-id            133914868
//   data-post-userid        / data-post-username
//   data-post-time          08/25/2026 03:22:02
//   data-post-pageNumber    which page of the thread it is on
//   .raw-post-body          the post's markup, in a hidden div
//
// That is what makes post-level granularity cheap here rather than a parsing
// project: the design wants to anchor an opportunity on ONE post inside a
// thread, and Covers hands us the id for it.
//
// ════════════════════════════════════════════════════════════════════════════
// THE TIMEZONE, WHICH IS LOAD-BEARING AND EASY TO GET WRONG BY FOUR HOURS
//
// `data-post-time` is UTC. The page DISPLAYS the same post as "Aug. 24, 2026
// 11:22 pm ET". Both refer to one moment — 08/25 03:22 UTC is 08/24 23:22 EDT —
// so the attribute is the machine-readable UTC and the visible text is the
// localised copy.
//
// Reading the attribute as local time would make every post four hours younger
// than it is. Age against kickoff is the core freshness signal for a betting
// forum, so that error would not look like a bug; it would look like the system
// having slightly bad judgement about which threads are still live.
// ════════════════════════════════════════════════════════════════════════════

export interface CoversThreadSummary {
  /** Covers' own numeric thread id, from `data-entry-id`. */
  threadId: string;
  title: string;
  /** Absolute URL to the thread. */
  url: string;
  /** Section slug, e.g. `nfl-betting-21`. */
  section: string;
  author: string;
  /** Epoch ms, or null when the listing did not carry a parsable date. */
  createdAtMs: number | null;
  /**
   * How many posts COVERS says the thread holds — its own "Posts:" number,
   * which counts the opening post.
   *
   * Named for what the site reports rather than for `replies`, which it is not:
   * a two-post thread is one reply, and a field called `replies` holding 2 is
   * the kind of small lie that later becomes an off-by-one in a freshness rule.
   * Compare it with `postsHeld` on the stored item to see what a harvest missed.
   */
  postsOnSite: number | null;
  views: number | null;
}

export interface CoversPost {
  postId: string;
  threadId: string;
  /** 1-based position within the whole thread, not within the page. */
  number: number | null;
  author: string;
  authorId: string;
  /** Epoch ms, parsed from the UTC data attribute. See the header. */
  createdAtMs: number | null;
  /** Which page of the thread this post is on. */
  page: number | null;
  /** Plain text, entities decoded, block boundaries preserved. */
  body: string;
}

export interface CoversThread {
  threadId: string;
  title: string;
  url: string;
  section: string;
  posts: CoversPost[];
  /** Highest page number linked from this page, when there is pagination. */
  pageCount: number;
}

// ---------------------------------------------------------------------------
// Shared text handling
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  pound: '£', euro: '€', deg: '°',
};

export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => cp(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => cp(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, n) => ENTITIES[n.toLowerCase()] ?? whole);
}

function cp(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Markup to readable text, keeping paragraph breaks.
 *
 * Betting posts are lists — four selections, one per line — and flattening them
 * into a paragraph destroys the structure the analysis most wants to read.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AN IMAGE IS NOT NOTHING
 *
 * Dropping `<img>` silently made an image-only post indistinguishable from an
 * empty one. A live harvest found the first case immediately: a post whose
 * entire content is `<img alt="peace_5">` came back with a zero-length body, and
 * "this post has no text" is a very different statement from "this post is a
 * peace sign" — or, the case that actually matters on a betting forum, "this
 * post is a screenshot of a bet slip".
 *
 * So an image becomes its alt text in brackets, or `[image]` when it has none.
 * Phase 3 can then tell an empty post from a picture, and decide for itself that
 * a picture is not something we can answer.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<img\b[^>]*>/gi, imagePlaceholder)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** `<img alt="peace_5">` → `[peace_5]`; an image with no alt → `[image]`. */
function imagePlaceholder(tag: string): string {
  const alt = /\balt="([^"]*)"/i.exec(tag)?.[1]?.trim();
  // A decorative image is marked with alt="" on purpose; it is still an image,
  // and calling it one is more honest than deleting it.
  return alt ? ` [${alt}] ` : ' [image] ';
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * `08/25/2026 03:22:02` → epoch ms, read as UTC.
 *
 * Built with Date.UTC rather than `new Date(string)`, which would interpret it
 * in whatever zone the server happens to run in — the difference between a
 * correct timestamp and a silently wrong one that changes when the app is
 * deployed somewhere else.
 */
export function parsePostTime(raw: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, mm, dd, yyyy, hh, mi, ss] = m;
  const ms = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss);
  return Number.isFinite(ms) ? ms : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * `Aug. 24, 2026 11:22 pm ET` → epoch ms.
 *
 * The listing's human-readable form, and the only date a section page gives. ET
 * is applied as a fixed −4 (EDT); Covers is a US sports site and its forum
 * clock is Eastern.
 *
 * DELIBERATELY APPROXIMATE, and the approximation is bounded and stated: for one
 * hour twice a year, around the DST boundary, this is an hour out. That is
 * acceptable for a LISTING date, which is only ever used to decide whether a
 * thread is worth opening. Anything that matters — the age of the specific post
 * being answered — comes from `data-post-time`, which is unambiguous UTC.
 */
export function parseListingTime(raw: string): number | null {
  const m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(raw);
  if (!m) return null;

  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;

  let hour = +m[4] % 12;
  if (m[6].toLowerCase() === 'pm') hour += 12;

  return Date.UTC(+m[3], month, +m[2], hour + 4, +m[5]);
}

// ---------------------------------------------------------------------------
// Section listings
// ---------------------------------------------------------------------------

const THREAD_LINK =
  /<a\s+[^>]*href="([^"]*\/forum\/([a-z0-9-]+)\/[^"]*?-(\d+))"[^>]*class="thread-subject"[^>]*data-entry-id="(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Threads on one section page.
 *
 * Anchored on `class="thread-subject"` plus `data-entry-id`, because a section
 * page links each thread several times — the title, a "last post" jump with
 * `#last`, and a reply shortcut. Keying on the entry id means one row per
 * thread however many times it is linked, and the SUBJECT link is the one that
 * carries the title text.
 */
export function parseSectionListing(html: string, baseUrl = 'https://www.covers.com'): CoversThreadSummary[] {
  const byId = new Map<string, CoversThreadSummary>();

  for (const m of html.matchAll(THREAD_LINK)) {
    const [, href, section, , entryId, inner] = m;
    if (byId.has(entryId)) continue;

    const title = htmlToText(inner).replace(/\n/g, ' ').trim();
    if (!title) continue;

    // The row's metadata follows the link: "By: <user> Aug. 24, 2026 11:22 pm ET"
    // and, further along, "Views: 872 | Posts: 20".
    //
    // The window STOPS at the next thread link. Without that bound a row whose
    // own counts are missing reads the next row's, which is worse than a null:
    // a silently borrowed number cannot be told from a measured one.
    const from = m.index ?? 0;
    const nextAt = nextThreadAt(html, from + m[0].length);
    const tail = html.slice(from, Math.min(nextAt, from + 4000));
    const flat = htmlToText(tail).replace(/\n/g, ' ');

    byId.set(entryId, {
      threadId: entryId,
      title,
      url: href.startsWith('http') ? href : `${baseUrl}${href}`,
      section,
      author: /by:\s*([^\s|]+)/i.exec(flat)?.[1]?.trim() ?? '',
      createdAtMs: parseListingTime(flat),
      // ⚠️ THE LABEL COMES FIRST: "Views: 872", not "872 views". The first
      // version of this matched `(\d+)\s*views` and therefore returned null for
      // every row on every page — a parser that never once produced a number and
      // said so only by omission. Both counts are asserted against the fixture
      // now, so the same silence cannot come back unnoticed.
      postsOnSite: labelled(flat, /posts:\s*(\d[\d,]*)/i),
      views: labelled(flat, /views:\s*(\d[\d,]*)/i),
    });
  }

  return [...byId.values()];
}

function labelled(flatText: string, pattern: RegExp): number | null {
  const m = pattern.exec(flatText);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Where the next thread row begins, or the end of the document. */
function nextThreadAt(html: string, from: number): number {
  const re = /class="thread-subject"/gi;
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : html.length;
}

/** The highest page number linked from a section or thread page. */
export function parsePageCount(html: string, sectionOrThread: string): number {
  const re = new RegExp(`${escapeRe(sectionOrThread)}/(\\d+)(?:["'#?]|$)`, 'g');
  let max = 1;
  for (const m of html.matchAll(re)) max = Math.max(max, Number(m[1]) || 1);
  return max;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const POST_HEAD =
  /data-post-id="(\d+)"[^>]*data-post-time="([^"]*)"(?:[^>]*data-post-pageNumber="(\d+)")?/gi;

const POST_BODY = /<div\s+class="raw-post-body"[^>]*>([\s\S]*?)<\/div>/gi;

/**
 * Posts on one thread page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WINDOW RUNS FROM THE PREVIOUS POST'S BODY, NOT FROM THIS POST'S ID
 *
 * Measured order inside one brick on a real page:
 *
 *   data-post-username   (twice — the header link and the profile card)
 *   data-post-userid
 *   data-post-id  +  data-post-time
 *   .raw-post-body
 *
 * The username comes roughly 1,800 bytes BEFORE the id it belongs to. The
 * obvious implementation — find the id, read forward — therefore finds no
 * username at all, or worse, finds the NEXT post's. The first version of this
 * function did exactly that and returned every post with an empty author.
 *
 * So each post's window is bounded by BODIES: from the end of the previous
 * post's body to the end of its own. That span contains exactly one post's
 * username, id, time and text, whatever order Covers puts them in — which also
 * means a future reshuffle of those attributes does not break it.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function parseThreadPosts(html: string, threadId: string): CoversPost[] {
  const heads = [...html.matchAll(POST_HEAD)];
  const bodies = [...html.matchAll(POST_BODY)];
  const posts: CoversPost[] = [];

  for (const [i, head] of heads.entries()) {
    const headAt = head.index ?? 0;

    // This post's body is the first one that starts after its id.
    const body = bodies.find((b) => (b.index ?? 0) > headAt);
    const bodyStart = body?.index ?? html.length;

    // The window opens where the previous post's body closed, so it reaches back
    // far enough to include this post's username without ever reaching into the
    // post before it.
    const prevBody = i > 0 ? bodies.find((b) => (b.index ?? 0) > (heads[i - 1].index ?? 0)) : undefined;
    const windowStart = prevBody ? (prevBody.index ?? 0) + prevBody[0].length : 0;

    const meta = html.slice(windowStart, bodyStart);

    posts.push({
      postId: head[1],
      threadId,
      number: numberFrom(meta),
      // Read from the metadata window only, never from the body: a quoted post
      // carries the quoted user's name inside its text, and reading from there
      // would attribute a reply to the person being answered.
      author: lastMatch(meta, /data-post-username="([^"]*)"/gi) ?? '',
      authorId: lastMatch(meta, /data-post-userid="(\d+)"/gi) ?? '',
      createdAtMs: parsePostTime(head[2]),
      page: head[3] ? Number(head[3]) : null,
      body: body ? htmlToText(body[1]) : '',
    });
  }

  return posts;
}

/** The LAST occurrence in the window. The username appears twice per brick —
 *  header link and profile card — and either is correct, but taking a consistent
 *  one keeps the parse stable if Covers drops one of them. */
function lastMatch(haystack: string, re: RegExp): string | null {
  let found: string | null = null;
  for (const m of haystack.matchAll(re)) found = m[1];
  return found;
}

function numberFrom(window: string): number | null {
  const m = /covers-CoversForum-postNumber[^>]*>([\s\S]{0,120}?)</i.exec(window);
  if (!m) return null;
  const n = /#?\s*(\d+)/.exec(htmlToText(m[1]));
  return n ? Number(n[1]) : null;
}

/**
 * The thread's id, from its URL.
 *
 * ⚠️ THE SECTION SLUG ALSO ENDS IN A NUMBER, AND IT COMES FIRST.
 *
 * `/forum/nfl-betting-21/dk-nfl-preseason-week-3-104044028` contains three
 * `-digits` groups: the section's `-21`, the `-3` in the title, and the thread's
 * own id at the end. Scanning left to right for the first one returns **21** —
 * the section — for every thread in the forum.
 *
 * That is not a parse that looks broken. It returns a plausible number, the same
 * one every time, so every thread in a section collapses onto ONE item id and
 * their posts pile into one subcollection. The unit tests missed it because they
 * passed the thread id in by hand; a live harvest of three threads showed all
 * three arriving as `21`.
 *
 * The id is the trailing number of the SLUG segment — the third path segment,
 * since a page suffix (`/2`) may follow it.
 */
export function threadIdFromUrl(url: string): string {
  try {
    const segments = new URL(url, 'https://www.covers.com').pathname.split('/').filter(Boolean);
    // ['forum', '<section>', '<slug>-<id>', '<page>'?]
    const slug = segments[2] ?? '';
    return /-(\d+)$/.exec(slug)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Everything one thread page yields. */
export function parseThreadPage(html: string, url: string): CoversThread | null {
  const threadId = threadIdFromUrl(url);
  if (!threadId) return null;

  const sectionMatch = /\/forum\/([a-z0-9-]+)\//i.exec(new URL(url).pathname);

  const rawTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const title = htmlToText(rawTitle)
    .replace(/\s*-\s*[^-]*Betting Forum \| Covers\s*$/i, '')
    .replace(/\s*\|\s*Covers\s*$/i, '')
    .trim();

  return {
    threadId,
    title,
    url,
    section: sectionMatch?.[1] ?? '',
    posts: parseThreadPosts(html, threadId),
    pageCount: parsePageCount(html, `-${threadId}`),
  };
}
