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
  rankDiscovered,
  screenDiscovered,
  titleInvitesAnswer,
} from '../../apps/web/src/modules/reddit/reader/discovery.ts';
import { scanForComment } from '../../apps/web/src/modules/reddit/commentKarma/pipeline.ts';
import {
  DEFAULT_COMMENT_SETTINGS,
  normalizeCommentSettings,
  scanReadiness,
} from '../../apps/web/src/modules/reddit/commentKarma/settings.ts';
import { DEFAULT_LIMITS } from '../../apps/web/src/modules/reddit/commentKarma/select.ts';
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

test('search mode is still reachable and unchanged', () => {
  assert.equal(normalizeCommentSettings({ discovery: 'search' }).discovery, 'search');
  // Anything unrecognised means the default, not a broken account.
  assert.equal(normalizeCommentSettings({ discovery: 'psychic' }).discovery, 'feed');
});
