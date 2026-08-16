// Finding posts without a keyword.
//
// The rule this file exists to hold: FREE DATA MAY ONLY DECIDE WHAT IT ACTUALLY
// KNOWS. A Reddit feed gives an id, a title, a permalink and a timestamp — no
// score, no comment count, no media type, no flags. So the free screen rejects
// on age and nothing else, and DiscoveredPost has no fields for the numbers it
// does not have. `../rss.ts` fills those with zeros, and the standing rule here
// is that a fabricated zero must never reach code that reads it as a
// measurement — the way to guarantee that is to have nowhere to put it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTING_FEEDS,
  paceWindow,
  rankDiscovered,
  screenDiscovered,
  titleInvitesAnswer,
} from '../../apps/web/src/modules/reddit/reader/discovery.ts';
import { scanForComment } from '../../apps/web/src/modules/reddit/commentKarma/pipeline.ts';
import {
  anyRelaxed,
  DEFAULT_COMMENT_SETTINGS,
  normalizeCommentSettings,
  NO_RELAXATIONS,
  scanReadiness,
} from '../../apps/web/src/modules/reddit/commentKarma/settings.ts';
import {
  DEFAULT_LIMITS,
  JUDGEMENT_REJECTS,
  SAFETY_REJECTS,
} from '../../apps/web/src/modules/reddit/commentKarma/select.ts';
import {
  makeComment,
  makePost,
  makeThread,
  FIXTURE_NOW_MS,
} from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const NOW = FIXTURE_NOW_MS;
const MIN = 60_000;
const HOUR = 3_600_000;

const seen = (over = {}) => ({
  redditPostId: 'abc123',
  subreddit: 'budget',
  title: 'how do you stop spending on payday',
  permalink: 'https://www.reddit.com/r/budget/comments/abc123/how_do_you/',
  createdAtMs: NOW - 2 * HOUR,
  author: 'someone',
  ...over,
});

const AGE = { minAgeMinutes: DEFAULT_LIMITS.minAgeMinutes, maxAgeHours: DEFAULT_LIMITS.maxAgeHours };

// --- the screen -------------------------------------------------------------

test('age is the only thing a feed entry may be rejected on', () => {
  assert.equal(screenDiscovered(seen(), NOW, AGE), null);
  assert.equal(screenDiscovered(seen({ createdAtMs: NOW - 5 * MIN }), NOW, AGE), 'too-young');
  assert.equal(screenDiscovered(seen({ createdAtMs: NOW - 30 * HOUR }), NOW, AGE), 'too-old');
  // No timestamp is not "assume it's fine" — it is unusable.
  assert.equal(screenDiscovered(seen({ createdAtMs: 0 }), NOW, AGE), 'no-timestamp');
});

test('a feed entry carries no fabricated numbers to read', () => {
  // The guarantee is structural. If these ever appear, something has started
  // guessing, and a guessed zero reads as "this post has no comments".
  const post = seen();
  for (const field of ['score', 'numComments', 'upvoteRatio', 'media', 'isLocked', 'isNsfw']) {
    assert.equal(field in post, false, `${field} must not exist on a feed entry`);
  }
});

test('a non-question title is ranked lower, never rejected', () => {
  // It may still have a body full of question. Rejecting on a title alone would
  // throw away good threads to save a call.
  assert.equal(titleInvitesAnswer('how do you stop spending on payday'), true);
  assert.equal(titleInvitesAnswer('Finally hit my savings goal'), false);
  assert.equal(screenDiscovered(seen({ title: 'Finally hit my savings goal' }), NOW, AGE), null);

  const ranked = rankDiscovered([
    seen({ redditPostId: 'statement', title: 'Finally hit my savings goal', createdAtMs: NOW - HOUR }),
    seen({ redditPostId: 'question', title: 'what did it cost you?', createdAtMs: NOW - 3 * HOUR }),
  ]);
  assert.equal(ranked[0].redditPostId, 'question', 'a question outranks a fresher statement');
  assert.equal(ranked.length, 2, 'and the statement is still in the list');
});

test('at equal shape, fresher wins — a rising thread compounds from the moment you land', () => {
  const ranked = rankDiscovered([
    seen({ redditPostId: 'older', createdAtMs: NOW - 5 * HOUR }),
    seen({ redditPostId: 'fresher', createdAtMs: NOW - 1 * HOUR }),
  ]);
  assert.equal(ranked[0].redditPostId, 'fresher');
});

// --- the window follows the community's pace --------------------------------

const ages = (hours) => hours.map((h, i) => seen({ redditPostId: `p${i}`, createdAtMs: NOW - h * HOUR }));

test('one window cannot serve two communities, so it is measured instead', () => {
  const account = { minAgeMinutes: 20, maxAgeHours: 24 };

  // r/AskReddit, live: 25 posts, every one under twenty minutes old. A 20m floor
  // rejects the entire feed — which is exactly what happened.
  const firehose = paceWindow(ages([0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3]), account, NOW);
  assert.ok(firehose.minAgeMinutes < 20, `floor was ${firehose.minAgeMinutes}m`);
  assert.ok(firehose.maxAgeHours < 1, `ceiling was ${firehose.maxAgeHours}h`);

  // r/budget, live: median post age seventy-five hours. The same two numbers
  // reject that entire feed the other way.
  const slow = paceWindow(ages([2, 20, 50, 75, 90, 120, 150]), account, NOW);
  assert.ok(slow.minAgeMinutes > 60, `floor was ${slow.minAgeMinutes}m`);
  assert.equal(slow.medianAgeHours, 75);

  // Two communities, opposite windows, from one setting and no tuning.
  assert.ok(firehose.maxAgeHours < slow.maxAgeHours);
});

test("the derived ceiling never exceeds the account's own, and the floor may go under it", () => {
  // Correctness, not caution: the enqueue re-checks staleness against the
  // account setting, so a draft written outside it would be refused at approval
  // and good comments would die between two rules that disagreed. Nothing
  // downstream rejects a thread for being young, so the floor is free.
  const account = { minAgeMinutes: 30, maxAgeHours: 6 };
  const slow = paceWindow(ages([40, 60, 80, 100, 120, 140, 160]), account, NOW);
  assert.equal(slow.maxAgeHours, 6, 'capped by the account');
  assert.ok(slow.minAgeMinutes > 30, 'and the floor still followed the pace');

  const fast = paceWindow(ages([0.02, 0.05, 0.1, 0.12, 0.2, 0.3, 0.4]), account, NOW);
  assert.ok(fast.minAgeMinutes < 30, 'the floor is free to go under');
  assert.ok(fast.minAgeMinutes >= 2, 'but never under two minutes — no votes, no comments to read');
});

test('too few posts to measure leaves the account settings alone', () => {
  const account = { minAgeMinutes: 20, maxAgeHours: 24 };
  const thin = paceWindow(ages([1, 2, 3]), account, NOW);
  assert.equal(thin.minAgeMinutes, 20);
  assert.equal(thin.maxAgeHours, 24);
  assert.equal(thin.medianAgeHours, 0, 'and says it measured nothing');
});

test('a scan reports the window it derived, so it is never invisible', async () => {
  const post = makePost({ redditPostId: 'p3', subreddit: 'budget' });
  const { deps } = feedDeps(ages([10, 20, 30, 40, 50, 60, 70]), { p3: makeThread(post, []) });
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });
  assert.ok(out.trace.some((t) => /pace: median post here is 40h old → window/.test(t)), out.trace.join(' | '));
});

test('the pace window can be switched off', async () => {
  const { deps } = feedDeps(ages([0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11]), {});
  const out = await scanForComment(deps, {
    settings: settings({ adaptWindow: false }),
    pairs,
    history: [],
  });
  // Back to the configured window, which rejects this entire feed as too young.
  assert.ok(!out.trace.some((t) => /pace:/.test(t)), out.trace.join(' | '));
  assert.match(out.skipReason, /too-young/);
});

// --- the pipeline in feed mode ---------------------------------------------

const settings = (over = {}) => ({ ...DEFAULT_COMMENT_SETTINGS, enabled: true, ...over });
const pairs = [{ subreddit: 'budget', keywords: [] }];

function feedDeps(feedPosts, threads, responses = []) {
  const calls = { search: 0, getThread: 0, list: [] };
  const asked = [];
  return {
    calls,
    asked,
    deps: {
      reader: {
        async search() {
          calls.search++;
          return [];
        },
        async getThread(id) {
          calls.getThread++;
          return threads[id] ?? null;
        },
      },
      discovery: {
        async list(subreddit, feed) {
          calls.list.push(`${subreddit}/${feed}`);
          return feedPosts;
        },
      },
      ask: async (input) => {
        asked.push(input);
        if (!responses.length) throw new Error(`unscripted model call #${asked.length}`);
        return responses.shift();
      },
      nowMs: NOW,
      random: () => 0,
    },
  };
}

test('feed mode needs no keyword and pays for no search', () => {
  // The whole point. An account with no keywords at all can still read the room.
  const ready = scanReadiness(normalizeCommentSettings({ enabled: true, discovery: 'feed' }), [
    { subreddit: 'budget', keywords: [] },
  ]);
  assert.equal(ready.ok, true, ready.reason);

  // And in search mode the same account is correctly refused.
  const searching = scanReadiness(normalizeCommentSettings({ enabled: true, discovery: 'search' }), [
    { subreddit: 'budget', keywords: [] },
  ]);
  assert.equal(searching.ok, false);
});

test('a scan reads the community feed instead of searching it', async () => {
  const post = makePost({ redditPostId: 'abc123', subreddit: 'budget' });
  const room = ['a few words about it here', 'mine was much the same in the end'].map((body, i) =>
    makeComment({ commentId: `t1_${i}`, body, score: 5 }),
  );
  const { deps, calls } = feedDeps([seen()], { abc123: makeThread(post, room) }, [
    { posterWant: 'information', delivered: 'guesses', gapState: 'none', angle: '', targetCommentId: null, confidence: 0.9 },
  ]);

  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(calls.search, 0, 'no billed search in feed mode');
  assert.deepEqual(calls.list, ['budget/rising'], 'and it read the rising feed');
  assert.equal(calls.getThread, 1, 'the paid read is what supplies every real number');
  assert.ok(out.trace.some((t) => /feed r\/budget \/rising/.test(t)), out.trace.join(' | '));
  assert.ok(out.trace.some((t) => /age window: 1 of 1 in range/.test(t)), out.trace.join(' | '));
});

test('everything outside the age window ends the scan before a single read is paid for', async () => {
  const { deps, calls, asked } = feedDeps(
    [
      seen({ redditPostId: 'young', createdAtMs: NOW - 2 * MIN }),
      seen({ redditPostId: 'old', createdAtMs: NOW - 40 * HOUR }),
    ],
    {},
  );

  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(out.skipStage, 'search');
  assert.match(out.skipReason, /window/);
  assert.equal(calls.getThread, 0, 'age is free to judge, so it is judged first');
  assert.equal(asked.length, 0);
});

test('a post that vanished between the feed and the read is counted, not retried', async () => {
  // NOT_FOUND is BILLED (vendor docs), so a stale feed id costs money and must
  // never be retried.
  const { deps, calls } = feedDeps([seen()], {});
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(calls.getThread, 1, 'exactly once');
  assert.equal(out.skipStage, 'judge');
  assert.ok(out.trace.some((t) => /gone since the listing/.test(t)), out.trace.join(' | '));
});

test('feed mode still applies the full listing screen — on the paid data', async () => {
  // Nothing is waived. An image post is invisible to the free screen here
  // because RSS cannot say it is one, so judgeCandidate catches it after the
  // read, on real data.
  const image = makePost({ redditPostId: 'abc123', subreddit: 'budget', media: 'image' });
  const { deps, calls, asked } = feedDeps([seen()], { abc123: makeThread(image, []) });

  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });
  assert.equal(out.skipStage, 'judge');
  assert.match(out.skipReason, /media/);
  assert.equal(calls.getThread, 1);
  assert.equal(asked.length, 0, 'and no model was asked about a post we cannot see');
});

test('the feed choice is stored, bounded, and never empty', () => {
  assert.deepEqual(normalizeCommentSettings({}).feeds, ['rising', 'hot']);
  assert.deepEqual(normalizeCommentSettings({ feeds: ['new'] }).feeds, ['new']);
  // Junk and empties fall back rather than leaving a mode with nothing to read.
  assert.deepEqual(normalizeCommentSettings({ feeds: ['front-page'] }).feeds, ['rising', 'hot']);
  assert.deepEqual(normalizeCommentSettings({ feeds: [] }).feeds, ['rising', 'hot']);
  // Order follows LISTING_FEEDS, so the stored value cannot encode a preference
  // the UI never offered.
  assert.deepEqual(normalizeCommentSettings({ feeds: ['hot', 'rising'] }).feeds, ['rising', 'hot']);
  assert.equal(LISTING_FEEDS.length, 3);
});

// --- the testing switches ---------------------------------------------------

test('a testing switch may reach a prediction, never a fact about the post', async () => {
  // THE line that matters. Relaxing "crowded" finds more candidates; relaxing
  // "this is an image" finds ways to get an account banned.
  for (const reason of SAFETY_REJECTS) {
    assert.equal(JUDGEMENT_REJECTS.has(reason), false, `${reason} must not be relaxable`);
  }
  for (const reason of ['media', 'locked', 'nsfw', 'quarantined', 'removed', 'contest-mode', 'link-post']) {
    assert.equal(SAFETY_REJECTS.has(reason), true, `${reason} must be a safety reject`);
  }

  // And in the pipeline: an image post is refused with every switch on.
  const image = makePost({ redditPostId: 'abc123', subreddit: 'budget', media: 'image' });
  const { deps, calls, asked } = feedDeps([seen()], { abc123: makeThread(image, []) });
  const out = await scanForComment(deps, {
    settings: settings({ relax: { ignoreGap: true, ignoreOpportunity: true, ignoreBotTell: true, ignoreCritic: true } }),
    pairs,
    history: [],
  });

  assert.equal(out.produced, false);
  assert.equal(out.skipStage, 'judge');
  assert.match(out.skipReason, /media/);
  assert.equal(calls.getThread, 1);
  assert.equal(asked.length, 0, 'and no model was asked about a post nobody can see');
});

test('ignoring the gap produces a comment on a thread that did not need one', async () => {
  // Filler, deliberately and visibly: the record is marked `relaxed`, which is
  // what stops it being auto-approved.
  const post = makePost({ redditPostId: 'abc123', subreddit: 'budget' });
  const room = [
    'we ended up doing it ourselves and it took a whole weekend but it was fine',
    'mine came in at roughly the same and i would do it again if i had to',
    'took a couple of tries before it stuck but the second one worked out much better',
    'i left mine far too late and paid for it later which was my own fault',
  ].map((body, i) => makeComment({ commentId: `t1_${i}`, body, score: 5 }));

  const { deps } = feedDeps(
    [seen()],
    { abc123: makeThread(post, room) },
    [
      { posterWant: 'information', delivered: 'all of it', gapState: 'none', angle: '', targetCommentId: null, confidence: 0.95 },
      { candidates: ['took me about six months and roughly two hundred quid, because i kept putting it off'] },
      { chosen: 1, reason: 'ordinary and harmless' },
    ],
  );

  const out = await scanForComment(deps, {
    settings: settings({ relax: { ...settings().relax, ignoreGap: true } }),
    pairs,
    history: [],
  });

  assert.equal(out.produced, true, JSON.stringify(out.trace));
  assert.equal(out.relaxed, true, 'and it says so, which is what blocks auto-approval');
  assert.ok(out.trace.some((t) => /filler by definition/.test(t)), out.trace.join(' | '));
});

test('the switches default off and an unknown one stays off', () => {
  assert.deepEqual(normalizeCommentSettings({}).relax, NO_RELAXATIONS);
  assert.equal(anyRelaxed(normalizeCommentSettings({}).relax), false);
  assert.equal(normalizeCommentSettings({ relax: { ignoreGap: 'yes' } }).relax.ignoreGap, false);
  assert.equal(anyRelaxed(normalizeCommentSettings({ relax: { ignoreCritic: true } }).relax), true);
});

test('search mode is still reachable and unchanged', () => {
  assert.equal(normalizeCommentSettings({ discovery: 'search' }).discovery, 'search');
  // Anything unrecognised means the default, not a broken account.
  assert.equal(normalizeCommentSettings({ discovery: 'psychic' }).discovery, 'feed');
});
