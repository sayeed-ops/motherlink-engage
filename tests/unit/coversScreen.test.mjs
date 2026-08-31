// The free rejections and the policy tier — everything that decides an
// opportunity before a model is called.
//
// The assertions worth reading are the ones about what does NOT happen: an
// unknown kickoff never rejects, an unmeasured section pace never rejects, and a
// prohibited jurisdiction always does, whatever else the post has going for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  screen,
  sectionPace,
  DEFAULT_LIMITS,
  EMPTY_FOOTPRINT,
} from '../../apps/web/src/modules/covers/screen.ts';
import {
  checkJurisdiction,
  variantEligibility,
  anyVariantEligible,
} from '../../apps/web/src/modules/covers/policy.ts';

const HOUR = 3_600_000;
const NOW = 1_788_000_000_000;

const SECTIONS = [
  { slug: 'nfl-betting-21', name: 'NFL Betting', roles: ['watch', 'reply'], sport: 'nfl' },
  { slug: 'website-promotions-9', name: 'Website Promotions', roles: ['watch', 'reply', 'promote'], sport: null },
  { slug: 'general-discussion-25', name: 'General Discussion', roles: ['watch'], sport: null },
];

const post = (over = {}) => ({
  postId: '1',
  threadId: 't',
  number: 1,
  author: 'brn2loslive2win',
  authorId: '9',
  createdAtMs: NOW - HOUR,
  page: 1,
  body: 'I grabbed Seattle -3.5 early and now it is -4.5, does anyone think it gets to -6 by Sunday?',
  ...over,
});

const input = (over = {}) => ({
  threadLastPostAtMs: NOW - HOUR,
  section: 'nfl-betting-21',
  sections: SECTIONS,
  paceMs: 2 * HOUR,
  footprint: EMPTY_FOOTPRINT,
  kickoffMs: null,
  nowMs: NOW,
  limits: DEFAULT_LIMITS,
  ...over,
  // After the spread: `over.post` is a PARTIAL post, and letting it through
  // whole would hand `screen` an object with no author or body.
  post: post(over.post),
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test('a live post in a reply section passes everything', () => {
  const v = screen(input());
  assert.equal(v.pass, true, v.reasons.join(', '));
  assert.deepEqual(v.reasons, []);
});

test('a watch-only section is watch-only', () => {
  const v = screen(input({ section: 'general-discussion-25' }));
  assert.equal(v.pass, false);
  assert.ok(v.reasons.includes('section-watch-only'));
});

test('a section nobody configured is refused rather than treated as permissive', () => {
  const v = screen(input({ section: 'mystery-section-77' }));
  assert.ok(v.reasons.includes('section-unknown'));
});

test('every reason is reported, not just the first', () => {
  // A short post, in a watch-only section, that we wrote, in a cold thread.
  const v = screen(
    input({
      section: 'general-discussion-25',
      post: { body: 'lol', author: 'ourbot', createdAtMs: NOW - 5000 * HOUR },
      threadLastPostAtMs: NOW - 5000 * HOUR,
      footprint: { inThread: 0, inSection: 0, ourAuthors: ['ourbot'] },
    }),
  );
  assert.equal(v.pass, false);
  for (const r of ['section-watch-only', 'post-thin', 'our-own-post', 'thread-cold', 'post-stale']) {
    assert.ok(v.reasons.includes(r), `expected ${r}, got ${v.reasons.join(', ')}`);
  }
});

test('an unknown kickoff never rejects — unknown is not "has started"', () => {
  // ⚠️ V1 HAS NO SCHEDULE FEED, so this is the normal case. Treating null as
  // "started" would reject the whole board; treating it as "not started" would
  // be an equally invented fact that happens to be convenient.
  assert.equal(screen(input({ kickoffMs: null })).pass, true);
  // With a real kickoff in the past, it does reject.
  assert.ok(screen(input({ kickoffMs: NOW - HOUR })).reasons.includes('event-started'));
  // And a kickoff still ahead does not.
  assert.equal(screen(input({ kickoffMs: NOW + HOUR })).pass, true);
});

test('an unmeasured section pace means no opinion about age, not a guessed window', () => {
  // A section we cannot measure must not have a window invented for it: one
  // guess rejects everything in a slow section, the other nothing in a fast one.
  const ancient = input({ paceMs: null, post: { createdAtMs: NOW - 5000 * HOUR }, threadLastPostAtMs: NOW - 5000 * HOUR });
  const v = screen(ancient);
  assert.ok(!v.reasons.includes('thread-cold'));
  assert.ok(!v.reasons.includes('post-stale'));
  assert.equal(v.measured.paceMs, null);
});

test('the cold-thread window is a multiple of the section\'s own pace', () => {
  const fast = screen(input({ paceMs: HOUR / 4, threadLastPostAtMs: NOW - 4 * HOUR }));
  const slow = screen(input({ paceMs: 48 * HOUR, threadLastPostAtMs: NOW - 4 * HOUR }));

  assert.ok(fast.reasons.includes('thread-cold'), 'four hours is an age on a fast board');
  assert.ok(!slow.reasons.includes('thread-cold'), 'four hours is nothing on a slow one');
});

test('an old post in a thread that is STILL ALIVE is not stale', () => {
  // ⚠️ THE TWO CHECKS ANSWER DIFFERENT QUESTIONS AND USED TO SHARE A NUMBER.
  // What decides whether a reply is seen is the thread being alive. A post's own
  // age only matters when it is ancient relative to everything around it — so
  // the stale window is four times the cold one, and this post, ten paces old in
  // a thread somebody replied to an hour ago, survives.
  const v = screen(
    input({
      paceMs: HOUR,
      threadLastPostAtMs: NOW - HOUR,
      post: { createdAtMs: NOW - 10 * HOUR },
    }),
  );
  assert.ok(!v.reasons.includes('post-stale'), v.reasons.join(', '));
  assert.ok(!v.reasons.includes('thread-cold'));
  assert.equal(v.pass, true);

  // Genuinely ancient still goes.
  const ancient = screen(
    input({ paceMs: HOUR, threadLastPostAtMs: NOW - HOUR, post: { createdAtMs: NOW - 40 * HOUR } }),
  );
  assert.ok(ancient.reasons.includes('post-stale'));
});

test('a post with almost nothing in it has nothing to answer', () => {
  assert.ok(screen(input({ post: { body: '[peace_5]' } })).reasons.includes('post-thin'));
  assert.ok(screen(input({ post: { body: 'Dallas 1000 bet .' } })).reasons.includes('post-thin'));
});

test('our own footprint stops us talking to ourselves or flooding a section', () => {
  const ours = screen(input({ footprint: { inThread: 0, inSection: 0, ourAuthors: ['BRN2LOSLIVE2WIN'] } }));
  assert.ok(ours.reasons.includes('our-own-post'), 'matched case-insensitively');

  const engaged = screen(input({ footprint: { inThread: 1, inSection: 1, ourAuthors: [] } }));
  assert.ok(engaged.reasons.includes('already-engaged'));

  const saturated = screen(input({ footprint: { inThread: 0, inSection: 3, ourAuthors: [] } }));
  assert.ok(saturated.reasons.includes('section-saturated'));
});

test('the section pace refuses to answer from too small a sample', () => {
  // ⚠️ A harvest lists sixty threads and opens four. The first live run took its
  // whole staleness window from the four, and `post-stale` then fired on 72 of
  // 103 posts. A median of four points is not a measurement of a section.
  const hourly = (n) => Array.from({ length: n }, (_, i) => NOW + i * HOUR);

  assert.equal(sectionPace([]), null);
  assert.equal(sectionPace(hourly(4)), null, 'four threads is not a section');
  assert.equal(sectionPace(hourly(9)), null);
  assert.equal(sectionPace(hourly(10)), HOUR, 'ten is the floor at which it answers');
  assert.equal(sectionPace(Array(12).fill(NOW)), null, 'a zero pace would reject everything');

  // Order of the input must not matter.
  const shuffled = [...hourly(12)].reverse();
  assert.equal(sectionPace(shuffled), HOUR);
});

// ---------------------------------------------------------------------------
// Jurisdiction
// ---------------------------------------------------------------------------

const POLICY = { prohibited: ['United States', 'US', 'Ontario'], licensed: ['Brazil'] };

test('a locational construction blocks; a passing mention does not', () => {
  // ⚠️ THE LIVE FAILURE THIS FIXES. Blocking on a bare mention hard-rejected two
  // posts in a political argument about healthcare, because the sentence
  // contained "US". Neither had anything to do with betting, and a hard reject
  // explains itself to nobody — those threads were silently unreachable.
  const blocked = (t) => checkJurisdiction(t, POLICY).blocked;

  assert.equal(blocked('Best book for someone betting from Ontario these days?'), true);
  assert.equal(blocked('anyone in the US getting decent lines?'), true);
  assert.equal(blocked('do they take Ontario players?'), true);
  assert.equal(blocked('Ontario residents keep asking about this'), true);

  // Named, but nobody is being placed there.
  assert.equal(blocked('the US and Canada both changed their rules last year'), false);
  assert.equal(blocked('Ontario is beautiful in the autumn'), false);
  assert.equal(blocked('watched the Ontario game last night'), false);
});

test('a two-letter code is matched in the case it was written in', () => {
  // `US` is also the word "us". At two or three characters an abbreviation
  // collides with ordinary English, and how it is WRITTEN is what separates
  // them — the same lesson the team lexicon learned about NO and WAS.
  assert.equal(checkJurisdiction('just us regulars in here', POLICY).blocked, false);
  assert.equal(checkJurisdiction('nothing between us and a cash out', POLICY).blocked, false);
  assert.equal(checkJurisdiction('anyone in the US?', POLICY).blocked, true);

  // A full name has no such ambiguity and matches however it is typed.
  assert.equal(checkJurisdiction('betting from ontario', POLICY).blocked, true);
  assert.equal(checkJurisdiction('anyone in the united states?', POLICY).blocked, true);
});

test('the verdict names which term fired, for the reviewer', () => {
  const v = checkJurisdiction('I bet from Ontario mostly', POLICY);
  assert.deepEqual(v.matched, ['Ontario']);
});

test('a licensed jurisdiction is not a block, and is not a bonus either', () => {
  assert.equal(checkJurisdiction('betting from Brazil', POLICY).blocked, false);
});

test('no policy configured blocks nothing', () => {
  assert.equal(checkJurisdiction('betting from Ontario', { prohibited: [], licensed: [] }).blocked, false);
});

// ---------------------------------------------------------------------------
// Variant eligibility
// ---------------------------------------------------------------------------

const elig = (over = {}) =>
  variantEligibility({
    section: 'nfl-betting-21',
    sections: SECTIONS,
    hasAssetMatch: true,
    hasCitableClaim: true,
    ...over,
  });

test('a reply-only section removes the brand-mentioned variant before it costs anything', () => {
  const v = elig();
  assert.equal(v.variants.brandMentioned, false);
  assert.match(v.reasons.brandMentioned, /does not permit promotion/);
  assert.equal(v.variants.brandInformed, true);
  assert.equal(v.variants.communityOnly, true);
});

test('only a promote section lets a reply name the client', () => {
  const v = elig({ section: 'website-promotions-9' });
  assert.equal(v.variants.brandMentioned, true);
});

test('an unconfigured section permits nothing that names the client', () => {
  const v = elig({ section: 'mystery-77' });
  assert.equal(v.variants.brandMentioned, false);
  assert.equal(v.variants.brandInformed, false, 'watch-only by default');
  assert.equal(v.variants.communityOnly, false);
  assert.equal(anyVariantEligible(v.variants), false);
});

test('an expired claim kills the brand-MENTIONED variant and spares the brand-INFORMED one', () => {
  // ⚠️ THE DISTINCTION THE WHOLE LIBRARY IS BUILT ON. An asset whose only claim
  // expired is still USABLE — the knowledge shapes an answer. What it may no
  // longer do is carry a reply that names the client AND states a fact.
  const v = elig({ section: 'website-promotions-9', hasCitableClaim: false });
  assert.equal(v.variants.brandMentioned, false);
  assert.match(v.reasons.brandMentioned, /no live claim/);
  assert.equal(v.variants.brandInformed, true);
});

test('nothing in the library leaves only the community reply', () => {
  const v = elig({ section: 'website-promotions-9', hasAssetMatch: false, hasCitableClaim: false });
  assert.equal(v.variants.brandMentioned, false);
  assert.equal(v.variants.brandInformed, false);
  assert.equal(v.variants.communityOnly, true, 'we can still be useful without the client');
});

test('a client switch is distinguishable from a rule', () => {
  const v = elig({ section: 'website-promotions-9', enabled: { brandMentioned: false } });
  assert.equal(v.variants.brandMentioned, false);
  assert.match(v.reasons.brandMentioned, /Turned off for this client/);
});

test('a watch-only section leaves nothing to generate', () => {
  const v = elig({ section: 'general-discussion-25' });
  assert.equal(anyVariantEligible(v.variants), false);
});
