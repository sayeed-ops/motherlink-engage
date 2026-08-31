// Reading covers.com, tested against slices of REAL pages.
//
// The fixtures in tests/fixtures/covers are cut from live pages fetched on
// 2026-08-30 — the section listing for /forum/nfl-betting-21 and the thread
// "Week 1 bets and line moves". Nothing here is invented markup, because a
// scraper tested against markup its own author wrote proves only that the author
// is consistent.
//
// The thread is deliberately the one from the original strategy conversation, so
// the values asserted below are the ones that were talked about before any of
// this was built: brn2loslive2win, Sea -3.5 / Phi -4.5 / AZ +10 / Det -7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  decode,
  htmlToText,
  parseListingTime,
  parsePageCount,
  parsePostTime,
  parseSectionListing,
  parseThreadPage,
  parseThreadPosts,
  threadIdFromUrl,
} from '../../apps/web/src/modules/covers/parse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(here, '../fixtures/covers', name), 'utf8');

const LISTING = fixture('listing-slice.html');
const THREAD = fixture('thread-slice.html');

// ── the timezone, which is the one that would silently poison everything ───

test('data-post-time is read as UTC, not as local time', () => {
  // The page shows this same post as "Aug. 24, 2026 11:22 pm ET". 03:22 UTC on
  // the 25th IS 23:22 EDT on the 24th, so the attribute is UTC.
  //
  // Reading it as local time would make every post four hours younger than it
  // is. On a betting forum, where a thread's worth collapses at kickoff, that
  // would not look like a bug — it would look like the system having slightly
  // poor judgement about what is still live.
  const ms = parsePostTime('08/25/2026 03:22:02');
  assert.equal(new Date(ms).toISOString(), '2026-08-25T03:22:02.000Z');
});

test('the two clocks on the page agree about the same moment', () => {
  const fromAttribute = parsePostTime('08/25/2026 03:22:02');
  const fromDisplay = parseListingTime('Aug. 24, 2026 11:22 pm ET');
  // Same minute. If these ever diverge by hours, one of the two readers has
  // taken the wrong zone and every age in the system is wrong with it.
  assert.ok(
    Math.abs(fromAttribute - fromDisplay) < 60_000,
    `attribute and display disagree: ${new Date(fromAttribute).toISOString()} vs ${new Date(fromDisplay).toISOString()}`,
  );
});

test('midday and midnight do not collide', () => {
  assert.equal(new Date(parseListingTime('Aug. 24, 2026 12:00 am ET')).toISOString(), '2026-08-24T04:00:00.000Z');
  assert.equal(new Date(parseListingTime('Aug. 24, 2026 12:00 pm ET')).toISOString(), '2026-08-24T16:00:00.000Z');
});

test('an unparsable time is null rather than an invalid date', () => {
  // NaN propagating into an age comparison silently makes every thread "fresh".
  assert.equal(parsePostTime('not a time'), null);
  assert.equal(parsePostTime(''), null);
  assert.equal(parseListingTime('sometime last week'), null);
});

// ── text ───────────────────────────────────────────────────────────────────

test('entities decode, including numeric ones', () => {
  assert.equal(decode('Sea&nbsp;-3.5 &amp; Phi &#45;4.5 &#x2013; nice'), 'Sea -3.5 & Phi -4.5 – nice');
});

test('a betting post keeps one selection per line', () => {
  // Four picks on four lines is the structure the analysis most wants to read.
  // Flattening them into a paragraph destroys exactly that.
  const text = htmlToText('<p>I have:</p><p>Sea -3.5</p><p>Phi -4.5</p><p>AZ +10</p>');
  assert.deepEqual(text.split('\n'), ['I have:', 'Sea -3.5', 'Phi -4.5', 'AZ +10']);
});

test('an image-only post reads as an image, not as an empty post', () => {
  // ⚠️ FOUND BY THE FIRST LIVE HARVEST. A post whose entire content is
  // `<img alt="peace_5">` came back as a zero-length body, which is the same
  // thing the parser says about a post it failed to read. On a betting forum the
  // case that matters is not the emoticon — it is the screenshot of a bet slip.
  assert.equal(
    htmlToText('<p><img src="https://img.covers.com/covers/emoticons/peace_5.gif" alt="peace_5"></p>'),
    '[peace_5]',
  );
  assert.equal(htmlToText('<p><img src="/slip.png"></p>'), '[image]');
  assert.equal(htmlToText('<p>Took <img src="/x.gif" alt="fire"> Seattle -3.5</p>'), 'Took [fire] Seattle -3.5');
});

test('<br> is a line break, and scripts never reach the text', () => {
  assert.equal(htmlToText('one<br>two<script>evil()</script>'), 'one\ntwo');
});

// ── the thread ─────────────────────────────────────────────────────────────

const posts = parseThreadPosts(THREAD, '104044109');

test('every post on the page is found', () => {
  assert.ok(posts.length >= 3, `expected several posts, got ${posts.length}`);
});

test('each post carries its own id, author and time — post-level granularity', () => {
  // The whole design anchors an opportunity on ONE post inside a thread, not on
  // the thread. This is the assertion that says Covers supports that.
  const first = posts[0];
  assert.equal(first.postId, '133914868');
  assert.equal(first.author, 'brn2loslive2win');
  assert.ok(first.authorId.length > 0);
  assert.equal(new Date(first.createdAtMs).toISOString(), '2026-08-25T03:22:02.000Z');
  assert.equal(first.threadId, '104044109');
});

test('the opening post body is the real text, with its selections intact', () => {
  const body = posts[0].body;
  for (const pick of ['Sea -3.5', 'Phi -4.5', 'AZ +10', 'Det -7']) {
    assert.ok(body.includes(pick), `lost "${pick}" from the post body`);
  }
  assert.ok(body.includes('opening week bets'), 'lost the question the post is asking');
  assert.ok(!body.includes('<p>'), 'markup leaked into the body');
  assert.ok(!body.includes('&nbsp;'), 'entities were not decoded');
});

test('a reply is attributed to its own author, not the thread starter', () => {
  // The failure this guards against is subtle and would ruin the analysis: if
  // the username were read from anywhere in the brick, a quoted post would
  // attribute a reply to the person being quoted.
  const authors = posts.map((p) => p.author);
  assert.ok(new Set(authors).size > 1, `every post attributed to the same user: ${authors.join(', ')}`);
  assert.equal(posts[1].postId, '133914944');
  assert.ok(posts[1].body.includes('Baltimore -3.5'));
});

test('posts come back in page order, oldest first', () => {
  const times = posts.map((p) => p.createdAtMs).filter(Boolean);
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
});

// ── the section listing ────────────────────────────────────────────────────

const threads = parseSectionListing(LISTING);

test('threads are found on a section page', () => {
  assert.ok(threads.length >= 1, `expected threads, got ${threads.length}`);
});

test('the thread we came for is parsed correctly', () => {
  const week1 = threads.find((t) => t.threadId === '104044109');
  assert.ok(week1, 'did not find the Week 1 thread');
  assert.equal(week1.title, 'Week 1 bets and line moves');
  assert.equal(week1.section, 'nfl-betting-21');
  assert.equal(week1.author, 'brn2loslive2win');
  assert.ok(week1.url.startsWith('https://www.covers.com/forum/nfl-betting-21/'));
  assert.ok(week1.url.endsWith('104044109'));
});

test('the listing counts are read — label first, number after', () => {
  // ⚠️ THE PARSER USED TO RETURN NULL FOR BOTH OF THESE, ON EVERY ROW OF EVERY
  // PAGE. It matched "872 views", and Covers writes "Views: 872". A parser that
  // never once produces a number reports it only by omission, and null is a
  // legitimate value here — so nothing looked wrong until a live harvest showed
  // every thread with its length unmeasured.
  const week1 = threads.find((t) => t.threadId === '104044109');
  assert.equal(week1.views, 872);
  assert.equal(week1.postsOnSite, 19, "Covers' own count, including the opening post");
});

test('a row reads its own counts, never the next row\'s', () => {
  // The window stops at the next thread link. A borrowed number cannot be told
  // apart from a measured one, which makes it worse than a null.
  const counted = threads.filter((t) => t.views !== null);
  assert.ok(counted.length > 1, 'more than one row should carry counts');
  assert.ok(
    new Set(counted.map((t) => `${t.views}:${t.postsOnSite}`)).size > 1,
    'every row reporting the same pair would mean one row is being read repeatedly',
  );
});

test('a thread linked several times on one page is ONE row', () => {
  // Covers links each thread as the title, as a "last post" jump with #last,
  // and as a reply shortcut. Keying on the entry id is what stops the listing
  // returning the same thread three times.
  const ids = threads.map((t) => t.threadId);
  assert.equal(new Set(ids).size, ids.length, `duplicate threads: ${ids.join(', ')}`);
});

test('the listing date is read as ET', () => {
  const week1 = threads.find((t) => t.threadId === '104044109');
  assert.equal(new Date(week1.createdAtMs).toISOString(), '2026-08-25T03:22:00.000Z');
});

// ── pagination ─────────────────────────────────────────────────────────────

test('the last page number is found, not merely the next one', () => {
  const html = `<a href="/forum/nfl-betting-21/2">2</a><a href="/forum/nfl-betting-21/10">10</a><a href="/forum/nfl-betting-21/3">3</a>`;
  assert.equal(parsePageCount(html, 'nfl-betting-21'), 10);
});

test('a single-page section reports one page', () => {
  assert.equal(parsePageCount('<a href="/forum/nfl-betting-21">NFL</a>', 'nfl-betting-21'), 1);
});


// ---------------------------------------------------------------------------
// The thread id, which the section slug very nearly stole
// ---------------------------------------------------------------------------

test('the thread id is the id of the THREAD, not the number in the section slug', () => {
  // ⚠️ THIS RETURNED "21" — the section — FOR EVERY THREAD IN THE NFL FORUM.
  // A live harvest of three different threads produced three items with the
  // same id, which in Firestore means one item holding everybody's posts. The
  // old rule scanned for the first `-digits` group and `/forum/nfl-betting-21/`
  // is the first one in every URL on the site.
  assert.equal(
    threadIdFromUrl('https://www.covers.com/forum/nfl-betting-21/dk-nfl-preseason-week-3-104044028'),
    '104044028',
  );
  assert.equal(
    threadIdFromUrl('https://www.covers.com/forum/nba-betting-22/finals-game-7-99887766'),
    '99887766',
  );
  // Page two of a long thread is the same thread.
  assert.equal(
    threadIdFromUrl('https://www.covers.com/forum/nfl-betting-21/week-1-bets-and-line-moves-104044109/2'),
    '104044109',
  );
  assert.equal(threadIdFromUrl('https://www.covers.com/forum/nfl-betting-21'), '', 'a section is not a thread');
});

test('two threads in one section never share an id', () => {
  const a = threadIdFromUrl('https://www.covers.com/forum/nfl-betting-21/thread-one-100000001');
  const b = threadIdFromUrl('https://www.covers.com/forum/nfl-betting-21/thread-two-100000002');
  assert.notEqual(a, b);
});

test('a thread page carries the id, section and title of the page it came from', () => {
  const url = 'https://www.covers.com/forum/nfl-betting-21/week-1-bets-and-line-moves-104044109';
  const thread = parseThreadPage(THREAD, url);

  assert.equal(thread.threadId, '104044109');
  assert.equal(thread.section, 'nfl-betting-21');
  assert.ok(thread.posts.length > 0);
  assert.ok(thread.posts.every((p) => p.threadId === '104044109'));
});
