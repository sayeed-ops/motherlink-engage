// Comment-karma candidate selection.
//
// This decides where an account spends its reputation, and every rule in it is
// a rule about something that cannot be undone once posted. The cases below are
// deliberately about the ways it could be WRONG rather than the happy path.
//
// Two rejections matter more than the rest and have extra tests: media posts
// (we cannot see the image, so a comment is a guess) and the age window (the
// single highest-leverage rule, because Reddit's confidence sort compounds
// early votes).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeCandidate,
  rankCandidates,
  isQuestionShaped,
  computeBaseline,
  screenListing,
  DEFAULT_LIMITS,
} from '../../apps/web/src/modules/reddit/commentKarma/select.ts';
import {
  makePost,
  makeComment,
  FIXTURE_NOW_MS,
} from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const judge = (over = {}, comments = [], baseline = null) =>
  judgeCandidate({
    post: makePost(over),
    comments,
    baseline,
    nowMs: FIXTURE_NOW_MS,
  });

// --- the baseline case -----------------------------------------------------

test('an ordinary rising text post is accepted', () => {
  const v = judge();
  assert.equal(v.ok, true, `unexpectedly rejected: ${v.reason}`);
  assert.ok(v.score > 0);
});

// --- content type ----------------------------------------------------------

test('media posts are rejected — we cannot see the image', () => {
  for (const media of ['image', 'video', 'gallery', 'poll']) {
    assert.equal(judge({ media }).reason, 'media', `${media} was not rejected`);
  }
});

test('an UNKNOWN media type is rejected, not assumed to be text', () => {
  // A reader that cannot determine the type must not have that read as "safe".
  assert.equal(judge({ media: 'unknown' }).reason, 'media');
});

test('link posts are rejected — we would be commenting on something unread', () => {
  assert.equal(judge({ media: 'link' }).reason, 'link-post');
});

// --- the AskReddit shape, which a naive rule would destroy ------------------

test('a title-only question post is ACCEPTED (the AskReddit case)', () => {
  // Empty selftext with the whole post in the title is the highest-yield
  // category here. A "must have a body" rule would reject all of it.
  const v = judge({ body: '', title: 'What is a small thing that improved your life?' });
  assert.equal(v.ok, true, `rejected: ${v.reason}`);
  assert.equal(v.signals.questionShaped, true);
});

test('a text post with no body and no question is rejected', () => {
  assert.equal(judge({ body: '', title: 'My cat' }).reason, 'nothing-to-answer');
});

test('question shape is detected from ?, opener, or flair', () => {
  assert.equal(isQuestionShaped(makePost({ title: 'this happened today?' })), true);
  assert.equal(isQuestionShaped(makePost({ title: 'How do I fix this' })), true);
  assert.equal(isQuestionShaped(makePost({ title: 'Anyone else seeing this' })), true);
  assert.equal(isQuestionShaped(makePost({ title: 'A thing', flair: 'Advice' })), true);
  assert.equal(isQuestionShaped(makePost({ title: 'A thing', flair: null })), false);
});

// --- the age window --------------------------------------------------------

test('too young is rejected — velocity is not yet measurable', () => {
  assert.equal(judge({ ageMinutes: 10 }).reason, 'too-young');
});

test('too old is rejected — the visible slots are already taken', () => {
  assert.equal(judge({ ageMinutes: 60 * 10 }).reason, 'too-old');
});

test('the window boundaries behave', () => {
  assert.notEqual(judge({ ageMinutes: DEFAULT_LIMITS.minAgeMinutes + 1 }).reason, 'too-young');
  assert.notEqual(judge({ ageMinutes: DEFAULT_LIMITS.maxAgeHours * 60 - 1 }).reason, 'too-old');
});

// --- room to be seen -------------------------------------------------------

test('a crowded thread is rejected', () => {
  assert.equal(judge({ numComments: DEFAULT_LIMITS.maxComments + 1 }).reason, 'crowded');
});

test('an unbeatable top comment is rejected', () => {
  const v = judge({}, [makeComment({ score: 400 })]);
  assert.equal(v.reason, 'unbeatable');
});

test('slot availability falls as visible competitors appear', () => {
  const empty = judge({}, []);
  const busy = judge({}, [
    makeComment({ commentId: 'a', score: 30 }),
    makeComment({ commentId: 'b', score: 25 }),
    makeComment({ commentId: 'c', score: 20 }),
  ]);
  assert.ok(empty.signals.slotAvailability > busy.signals.slotAvailability);
  // Comments below the visible threshold are not competitors.
  const quiet = judge({}, [makeComment({ score: 1 }), makeComment({ score: 2 })]);
  assert.equal(quiet.signals.visibleCompetitors, 0);
});

// --- thread temperature ----------------------------------------------------

test('a contested thread is rejected', () => {
  assert.equal(judge({ upvoteRatio: 0.4 }).reason, 'contested');
});

test('an UNKNOWN upvote ratio is not treated as a fight', () => {
  // null means the reader could not say. Absence of evidence is not evidence.
  assert.notEqual(judge({ upvoteRatio: null }).reason, 'contested');
});

// --- the two-stage split (this is a COST control, so it gets real tests) ----

test('screenListing rejects everything it can without a comment tree', () => {
  // Each of these must be caught on free search data, never after paying for a
  // reddit-post-v2 call.
  const cases = [
    [{ media: 'image' }, 'media'],
    [{ media: 'link' }, 'link-post'],
    [{ isRemoved: true }, 'removed'],
    [{ isQuarantined: true }, 'quarantined'],
    [{ isLocked: true }, 'locked'],
    [{ isContestMode: true }, 'contest-mode'],
    [{ isScoreHidden: true }, 'score-hidden'],
    [{ ageMinutes: 5 }, 'too-young'],
    [{ ageMinutes: 60 * 12 }, 'too-old'],
    [{ numComments: 500 }, 'crowded'],
    [{ upvoteRatio: 0.3 }, 'contested'],
  ];
  for (const [over, expected] of cases) {
    assert.equal(screenListing(makePost(over), FIXTURE_NOW_MS), expected, `${expected} not caught`);
  }
});

test('screenListing passes a good post, so survivors reach the paid call', () => {
  assert.equal(screenListing(makePost(), FIXTURE_NOW_MS), null);
});

test('the only check needing comments is the unbeatable top comment', () => {
  // If this ever fails, a comment-dependent check leaked into stage two and the
  // bill now scales with candidates rather than survivors.
  const post = makePost();
  assert.equal(screenListing(post, FIXTURE_NOW_MS), null);
  const v = judgeCandidate({ post, comments: [makeComment({ score: 900 })], baseline: null, nowMs: FIXTURE_NOW_MS });
  assert.equal(v.reason, 'unbeatable');
});

test('judgeCandidate still applies every listing rule', () => {
  // The two stages must not drift apart — stage two calls stage one.
  assert.equal(judge({ media: 'image' }).reason, 'media');
  assert.equal(judge({ isContestMode: true }).reason, 'contest-mode');
});

// --- rejects the Crawlzo schema exposed ------------------------------------

test('contest mode is rejected — randomised order means no position to win', () => {
  assert.equal(judge({ isContestMode: true }).reason, 'contest-mode');
});

test('hidden scores are rejected — the ranking signals would be fiction', () => {
  assert.equal(judge({ isScoreHidden: true }).reason, 'score-hidden');
});

test('removed and quarantined posts are rejected', () => {
  assert.equal(judge({ isRemoved: true }).reason, 'removed');
  assert.equal(judge({ isQuarantined: true }).reason, 'quarantined');
});

// --- moderation state ------------------------------------------------------

test('locked, archived, stickied and nsfw are each rejected', () => {
  assert.equal(judge({ isLocked: true }).reason, 'locked');
  assert.equal(judge({ isArchived: true }).reason, 'archived');
  assert.equal(judge({ isStickied: true }).reason, 'stickied');
  assert.equal(judge({ isNsfw: true }).reason, 'nsfw');
});

// --- the per-subreddit baseline --------------------------------------------

test('a post below its own subreddit median is rejected as not rising', () => {
  const baseline = { subreddit: 'askreddit', medianVelocity: 100, madVelocity: 10 };
  // 40 points over ~2h is well under 100/hr.
  assert.equal(judge({}, [], baseline).reason, 'not-rising');
});

test('NO baseline must not reject everything — that would prevent building one', () => {
  const v = judge({}, [], null);
  assert.equal(v.ok, true, `rejected with no baseline: ${v.reason}`);
  assert.equal(v.signals.velocityZ, null);
});

test('computeBaseline needs enough points to be meaningful', () => {
  const few = [makePost(), makePost(), makePost()];
  assert.equal(computeBaseline('askreddit', few, FIXTURE_NOW_MS), null);
});

test('computeBaseline uses the median, so one viral post cannot poison a sub', () => {
  const ordinary = Array.from({ length: 8 }, (_, i) =>
    makePost({ redditPostId: `t3_${i}`, score: 20, ageMinutes: 120 }),
  );
  const withViral = [...ordinary, makePost({ redditPostId: 't3_viral', score: 50_000, ageMinutes: 120 })];

  const a = computeBaseline('askreddit', ordinary, FIXTURE_NOW_MS);
  const b = computeBaseline('askreddit', withViral, FIXTURE_NOW_MS);
  assert.ok(a && b);
  // A mean would have moved enormously; a median barely shifts.
  assert.ok(Math.abs(b.medianVelocity - a.medianVelocity) < a.medianVelocity * 0.5);
});

// --- ranking ---------------------------------------------------------------

test('rankCandidates drops rejects and orders best first', () => {
  const inputs = [
    { post: makePost({ redditPostId: 'bad', media: 'image' }), comments: [], baseline: null, nowMs: FIXTURE_NOW_MS },
    {
      post: makePost({ redditPostId: 'ok', numComments: 3, score: 60 }),
      comments: [],
      baseline: null,
      nowMs: FIXTURE_NOW_MS,
    },
    {
      post: makePost({ redditPostId: 'meh', numComments: 50, score: 10 }),
      comments: [makeComment({ score: 40 }), makeComment({ commentId: 'x', score: 30 })],
      baseline: null,
      nowMs: FIXTURE_NOW_MS,
    },
  ];

  const ranked = rankCandidates(inputs);
  assert.ok(!ranked.some((r) => r.input.post.redditPostId === 'bad'), 'a media post survived');
  assert.equal(ranked[0].input.post.redditPostId, 'ok');
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].verdict.score >= ranked[i].verdict.score, 'not sorted');
  }
});

test('an OP replying in the thread raises the score', () => {
  const without = judge({}, [makeComment({ score: 3 })]);
  const withOp = judge({}, [makeComment({ score: 3, isOp: true })]);
  assert.equal(without.signals.opActive, false);
  assert.equal(withOp.signals.opActive, true);
  assert.ok(withOp.score > without.score, 'an active OP did not raise the score');
});
