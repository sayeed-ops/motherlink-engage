// Outcome capture and the learning loop.
//
// Two things these protect, and both are about NOT over-reacting:
//
//   A removed comment is not a zero. It is the room rejecting the account,
//   which is the failure the whole system exists to avoid, and the loop weighs
//   it far more heavily than a low score. Conflating them would teach the
//   system that being removed is merely unpopular.
//
//   No knob moves on a small sample, and no knob reaches zero. A weight of zero
//   would stop the sampling that could show a community had a bad week — the
//   ledger would freeze on its first impression, which is the same deadlock the
//   "no baseline must not reject everything" rule in select.ts prevents.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECK_SCHEDULE_MS,
  commentIdFromPermalink,
  dueCheck,
  EMPTY_OUTCOME,
  finalCheck,
  normalizeOutcome,
  readOutcome,
  withCheck,
} from '../../apps/web/src/modules/reddit/commentKarma/outcomes.ts';
import {
  fitKnobs,
  MIN_TOTAL,
  MIN_WEIGHT,
  shouldExplore,
  summarise,
  toSamples,
  weightedOrder,
} from '../../apps/web/src/modules/reddit/commentKarma/learn.ts';
import { makeComment, makePost, makeThread } from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

// --- finding our own comment ------------------------------------------------

test('the comment id comes out of the permalink the agent captured', () => {
  // We never chose the id — Reddit did, and the create-comment response is the
  // only place it exists.
  assert.equal(
    commentIdFromPermalink('https://www.reddit.com/r/budget/comments/1abc2d/some_title/p0fl386/'),
    'p0fl386',
  );
  assert.equal(commentIdFromPermalink('/r/budget/comments/1abc2d/some_title/p0fl386/?context=3'), 'p0fl386');
  // A link to the POST rather than to a comment must not be mistaken for one.
  assert.equal(commentIdFromPermalink('https://www.reddit.com/r/budget/comments/1abc2d/'), null);
  assert.equal(commentIdFromPermalink(''), null);
});

test('a check reads score, rank and replies out of one read', () => {
  const thread = makeThread(makePost(), [
    makeComment({ commentId: 'aaa', score: 90 }),
    makeComment({ commentId: 'p0fl386', score: 40, replyCount: 3 }),
    makeComment({ commentId: 'ccc', score: 5 }),
  ]);

  const check = readOutcome(thread, 'p0fl386', NOW - 2 * HOUR, NOW);
  assert.equal(check.score, 40);
  assert.equal(check.rank, 2);
  assert.equal(check.totalTopLevel, 3);
  assert.equal(check.replies, 3);
  assert.equal(check.ageHours, 2);
  // `t1_` prefixed or bare — Reddit uses both and Crawlzo is not documented on
  // which, so the comparison must not care.
  assert.ok(readOutcome(thread, 't1_p0fl386', NOW - HOUR, NOW));
});

test('a comment that is gone is recorded as removed, never as a zero', () => {
  const thread = makeThread(makePost(), [makeComment({ commentId: 'aaa', score: 12 })]);
  assert.equal(readOutcome(thread, 'p0fl386', NOW - HOUR, NOW), null);

  const outcome = withCheck(EMPTY_OUTCOME, null);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.done, true, 'there is nothing left to measure');
  assert.equal(outcome.checks.length, 0);
});

// --- the schedule -----------------------------------------------------------

test('checks fall due on the schedule and then stop', () => {
  const posted = NOW - 90 * 60_000; // 1.5h ago
  let outcome = EMPTY_OUTCOME;

  const first = dueCheck(outcome, posted, NOW);
  assert.equal(first.index, 0, 'the 1h check is due');

  outcome = withCheck(outcome, { atMs: NOW, ageHours: 1.5, score: 4, replies: 0, rank: 3, totalTopLevel: 9 });
  // The 1d check is not due yet, and asking again must not re-run the first.
  assert.equal(dueCheck(outcome, posted, NOW), null);
  assert.ok(dueCheck(outcome, posted, posted + CHECK_SCHEDULE_MS[1]));

  for (const ageHours of [24, 72]) {
    outcome = withCheck(outcome, { atMs: NOW, ageHours, score: 9, replies: 1, rank: 2, totalTopLevel: 9 });
  }
  assert.equal(outcome.done, true);
  assert.equal(dueCheck(outcome, posted, NOW + 999 * HOUR), null, 'a finished record is never re-read');
  assert.equal(finalCheck(outcome).ageHours, 72);
});

test('a malformed outcome reads as empty rather than throwing', () => {
  assert.deepEqual(normalizeOutcome(undefined), EMPTY_OUTCOME);
  assert.deepEqual(normalizeOutcome({ checks: 'lots' }).checks, []);
  assert.equal(normalizeOutcome({ removed: true }).done, true);
});

// --- samples ----------------------------------------------------------------

const record = (over = {}) => ({
  draftId: 'd',
  status: 'posted',
  thread: { subreddit: 'askreddit', redditPostId: 't3_x' },
  gap: { gapState: 'absent', posterWant: 'information' },
  words: 20,
  postedAtMs: NOW,
  createdAtMs: NOW,
  exploratory: false,
  outcome: { checks: [{ atMs: NOW, ageHours: 24, score: 10, replies: 0, rank: 2, totalTopLevel: 10 }], removed: false, done: true },
  ...over,
});

test('an unmeasured comment is not counted as a failure', () => {
  // Counting it would make every fresh comment drag the numbers down, and the
  // knobs would move on nothing.
  assert.equal(toSamples([record({ outcome: EMPTY_OUTCOME })]).length, 0);
  assert.equal(toSamples([record({ status: 'queued' })]).length, 0);
  assert.equal(toSamples([record()]).length, 1);
  // Removed counts, even with no check to read a score from.
  assert.equal(toSamples([record({ outcome: { checks: [], removed: true, done: true } })]).length, 1);
});

// --- the knobs --------------------------------------------------------------

const samples = (n, over = {}) =>
  Array.from({ length: n }, () => ({
    subreddit: 'askreddit',
    gapState: 'absent',
    posterWant: 'information',
    words: 20,
    hour: 12,
    exploratory: false,
    score: 10,
    rank: 2,
    totalTopLevel: 10,
    replies: 0,
    removed: false,
    ...over,
  }));

test('nothing is fitted until there is something to fit', () => {
  const early = fitKnobs(samples(MIN_TOTAL - 1));
  assert.deepEqual(early.communityWeights, {});
  assert.deepEqual(early.gapConfidenceFloor, {});
  assert.match(early.notes[0], /nothing is fitted yet/);
});

test('a community that pays off is scanned more, one that does not is never dropped', () => {
  const mixed = [
    ...samples(10, { subreddit: 'good', score: 40 }),
    ...samples(10, { subreddit: 'bad', score: 1 }),
  ];
  const knobs = fitKnobs(mixed);
  assert.ok(knobs.communityWeights.good > knobs.communityWeights.bad);
  // The floor is the point: a zero would stop the sampling that could show the
  // community had a bad week.
  assert.ok(knobs.communityWeights.bad >= MIN_WEIGHT, `bad was ${knobs.communityWeights.bad}`);
  assert.ok(knobs.communityWeights.good <= 2, 'and the ceiling stops one good week taking over');
});

test('a room that removes our comments is treated as rejection, not low yield', () => {
  const knobs = fitKnobs([
    ...samples(10, { subreddit: 'hostile', removed: true, score: 0 }),
    ...samples(10, { subreddit: 'fine', score: 20 }),
  ]);
  assert.equal(knobs.communityWeights.hostile, MIN_WEIGHT);
  assert.ok(knobs.notes.some((n) => /does not want us/.test(n)), knobs.notes.join(' | '));
});

test('an underperforming gap state gets a higher bar, not a ban', () => {
  const knobs = fitKnobs([
    ...samples(12, { gapState: 'absent', score: 30 }),
    ...samples(10, { gapState: 'said-badly', score: 1 }),
  ]);
  assert.ok(knobs.gapConfidenceFloor['said-badly'] > 0);
  assert.equal(knobs.gapConfidenceFloor['absent'], undefined);
});

test('a small bucket inside a big sample is still ignored', () => {
  const knobs = fitKnobs([...samples(30, { subreddit: 'main' }), ...samples(3, { subreddit: 'rare', score: 0 })]);
  assert.equal(knobs.communityWeights.rare, undefined, 'three comments is not evidence about a community');
});

test('the summary separates removed and exploratory from the rest', () => {
  const s = summarise([
    ...samples(3, { score: 10 }),
    ...samples(1, { removed: true, score: 0 }),
    ...samples(2, { exploratory: true, score: 5 }),
  ]);
  assert.equal(s.n, 6);
  assert.equal(s.removed, 1);
  assert.equal(s.exploratory, 2);
});

// --- ordering and exploration ----------------------------------------------

test('weight biases the order without ever removing anything', () => {
  const items = ['heavy', 'light'];
  const weightOf = (x) => (x === 'heavy' ? 2 : MIN_WEIGHT);
  let heavyFirst = 0;
  // A deterministic sweep of the unit interval rather than a random one: the
  // question is whether weight biases the draw, and a flaky test about
  // randomness is worse than no test.
  for (let i = 1; i <= 100; i++) {
    const seq = [i / 101, 1 - i / 101];
    let n = 0;
    const order = weightedOrder(items, weightOf, () => seq[n++ % seq.length]);
    if (order[0] === 'heavy') heavyFirst++;
    assert.equal(order.length, 2, 'nothing is ever dropped from the rotation');
  }
  assert.ok(heavyFirst > 60, `heavy went first ${heavyFirst}/100 times`);
  assert.ok(heavyFirst < 100, 'and the light one still gets sampled');
});

test('exploration is a small, bounded share', () => {
  assert.equal(shouldExplore(0.15, () => 0.1), true);
  assert.equal(shouldExplore(0.15, () => 0.9), false);
  // Never all of them, whatever the stored value says.
  assert.equal(shouldExplore(5, () => 0.6), false);
  assert.equal(shouldExplore(-1, () => 0), false);
});
