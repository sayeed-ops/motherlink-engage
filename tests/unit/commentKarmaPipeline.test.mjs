// One scan, end to end, against fixtures and a scripted model.
//
// What these protect is mostly MONEY and INDICES:
//   - nothing billable is called before the free checks have passed, and no
//     model is called before the billable ones have found a thread;
//   - the critic chooses among SURVIVORS, so its number must resolve against
//     that array and not the one the model originally wrote. Getting that wrong
//     posts a comment the gates rejected, and it would look fine in every log.
//
// And that a skip is a returned outcome, never an exception — a scan that
// decides not to comment is the system working, and it has to be filed
// differently from Crawlzo being down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanForComment, historyFromPosted } from '../../apps/web/src/modules/reddit/commentKarma/pipeline.ts';
import { DEFAULT_COMMENT_SETTINGS } from '../../apps/web/src/modules/reddit/commentKarma/settings.ts';
import { BOT_TELL_LIMITS } from '../../apps/web/src/modules/reddit/commentKarma/botTell.ts';
import {
  makeComment,
  makePost,
  makeThread,
  FIXTURE_NOW_MS,
} from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const NOW = FIXTURE_NOW_MS;
const HOUR = 3_600_000;

const GOOD1 = 'took me about six months and roughly two hundred quid, mostly because i kept putting it off';
const GOOD2 = 'mine dragged on for ages too because i kept forgetting to chase it up with them';
const LINKED = 'there is a good guide at example.com that covers all of this in more detail for you';

const ROOM = [
  'we ended up doing it ourselves and it took a whole weekend but it was fine',
  'mine came in at roughly the same and i would do it again if i had to',
  'took a couple of tries before it stuck but the second one worked out much better',
  'i left mine far too late and paid for it later which was my own fault',
  'worth doing early if you can, mine dragged on because i kept putting it off',
].map((body, i) => makeComment({ commentId: `t1_${i}`, body, score: 5 }));

const POST = makePost({ redditPostId: 't3_ok' });

/** A reader that counts what it was asked for — the bill, in effect. */
function countingReader({ listings = {}, threads = {} } = {}) {
  const calls = { search: 0, getThread: 0 };
  return {
    calls,
    reader: {
      async search(subreddit) {
        calls.search++;
        return listings[subreddit.toLowerCase()] ?? [];
      },
      async getThread(id) {
        calls.getThread++;
        return threads[id] ?? null;
      },
    },
  };
}

/** A model that answers from a script, in order, and remembers what it was asked. */
function scriptedAsk(responses) {
  const asked = [];
  return {
    asked,
    ask: async (input) => {
      asked.push(input);
      if (!responses.length) throw new Error(`unscripted model call #${asked.length}`);
      return responses.shift();
    },
  };
}

const GAP_OK = {
  posterWant: 'information',
  delivered: 'a few vague guesses',
  gapState: 'absent',
  angle: 'say what it actually cost',
  targetCommentId: null,
  confidence: 0.8,
};

const settings = (over = {}) => ({ ...DEFAULT_COMMENT_SETTINGS, enabled: true, ...over });
const pairs = [{ subreddit: 'askreddit', keywords: ['cost'] }];

function fullDeps(responses, over = {}) {
  const { reader, calls } = countingReader({
    listings: { askreddit: [POST] },
    threads: { t3_ok: makeThread(POST, ROOM) },
  });
  const { ask, asked } = scriptedAsk(responses);
  return { deps: { reader, ask, nowMs: NOW, random: () => 0, ...over }, calls, asked };
}

// --- the happy path ---------------------------------------------------------

test('a scan that finds something returns the comment and everything the panel needs', async () => {
  const { deps, calls, asked } = fullDeps([
    GAP_OK,
    { candidates: [GOOD1, GOOD2] },
    { chosen: 1, reason: 'it answers the question plainly' },
  ]);

  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(out.produced, true, JSON.stringify(out));
  assert.equal(out.text, GOOD1);
  assert.equal(out.words, 17);
  assert.equal(out.thread.subreddit, 'askreddit');
  assert.match(out.thread.threadUrl, /^https:\/\/www\.reddit\.com\//);
  assert.equal(out.gap.gapState, 'absent');
  // The band is measured from the thread, not chosen — see roomProfile.
  assert.ok(out.room.target > 0 && out.room.min < out.room.max);
  assert.equal(asked.length, 3, 'gap, generation, critic — one call each');
  assert.equal(calls.search, 1);
  assert.equal(calls.getThread, 1);
});

test('the three model calls are given the temperatures their jobs need', async () => {
  const { deps, asked } = fullDeps([GAP_OK, { candidates: [GOOD1] }, { chosen: 1, reason: 'fine' }]);
  await scanForComment(deps, { settings: settings(), pairs, history: [] });

  const [gap, generate, critic] = asked;
  // Variety is wanted in exactly one place. A critic that answers differently
  // on the same input twice is not a check.
  assert.ok(generate.temperature > gap.temperature);
  assert.ok(generate.temperature > critic.temperature);
});

// --- the critic chooses among survivors, not among everything written -------

test('the critic\'s number resolves against the candidates that PASSED the gates', async () => {
  // LINKED fails the mechanical gate, so the critic is shown two candidates and
  // "1" means the first of those two. Resolving it against the original array
  // would post the one the gates rejected — and nothing downstream would notice.
  const { deps, asked } = fullDeps([
    GAP_OK,
    { candidates: [LINKED, GOOD1, GOOD2] },
    { chosen: 1, reason: 'the plainest of the two' },
  ]);

  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });
  assert.equal(out.text, GOOD1);
  assert.ok(!asked[2].user.includes('example.com'), 'the rejected candidate must not reach the critic');
  assert.equal(out.rejected.length, 1);
  assert.ok(out.rejected[0].failures.some((f) => f.code === 'link'));
});

// --- every way a scan stops -------------------------------------------------

test('the account\'s own rhythm stops a scan before anything is billed', async () => {
  // Six comments at an even three-hour cadence.
  const history = Array.from({ length: 6 }, (_, i) => ({
    postedAtMs: NOW - (18 - i * 3) * HOUR,
    words: 20,
    subreddit: 'askreddit',
    opening: `opener ${i}`,
  }));
  const { deps, calls, asked } = fullDeps([]);

  const out = await scanForComment(deps, { settings: settings(), pairs, history });
  assert.equal(out.produced, false);
  assert.equal(out.skipStage, 'timing');
  assert.equal(calls.search, 0, 'a search is a billed call');
  assert.equal(asked.length, 0);
});

test('one over-used community moves the scan elsewhere rather than ending it', async () => {
  // sub-monotony is a reason to go somewhere else; cadence is a reason to stop.
  const history = Array.from({ length: BOT_TELL_LIMITS.maxSameSubStreak }, (_, i) => ({
    // Deliberately irregular, so only the subreddit rule can fire.
    postedAtMs: NOW - [2, 9, 13, 30, 44, 51, 79, 96][i] * HOUR,
    words: 10 + i * 3,
    subreddit: 'askreddit',
    opening: `opener ${i}`,
  }));

  const { reader } = countingReader({
    listings: { cooking: [makePost({ redditPostId: 't3_c', subreddit: 'cooking' })] },
    threads: {},
  });
  const { ask } = scriptedAsk([]);

  const out = await scanForComment(
    { reader, ask, nowMs: NOW, random: () => 0 },
    {
      settings: settings(),
      // shuffle with random()=0 puts the second entry first, so askreddit is
      // tried first and rejected, and cooking is where it goes.
      pairs: [{ subreddit: 'cooking', keywords: ['pans'] }, { subreddit: 'askreddit', keywords: ['cost'] }],
      history,
    },
  );

  assert.ok(out.trace.some((t) => /skipped r\/askreddit/.test(t)), out.trace.join(' | '));
  assert.ok(out.trace.some((t) => /search r\/cooking/.test(t)), out.trace.join(' | '));
});

test('posts rejected on free listing data are never read in full', async () => {
  const { reader, calls } = countingReader({
    // An image post and a locked one: both decidable from the search result.
    listings: { askreddit: [makePost({ redditPostId: 't3_a', media: 'image' }), makePost({ redditPostId: 't3_b', isLocked: true })] },
    threads: {},
  });
  const { ask, asked } = scriptedAsk([]);

  const out = await scanForComment({ reader, ask, nowMs: NOW, random: () => 0 }, { settings: settings(), pairs, history: [] });

  assert.equal(out.skipStage, 'screen');
  assert.equal(calls.getThread, 0, 'reading a thread is a second billed call — the screen exists to avoid it');
  assert.equal(asked.length, 0);
  assert.match(out.skipReason, /media|locked/);
});

test('a thread nobody should enter ends the scan before the model is asked anything', async () => {
  const crowded = makePost({ redditPostId: 't3_ok' });
  const { reader, calls } = countingReader({
    listings: { askreddit: [crowded] },
    // An unbeatable top comment — only visible once the thread is read.
    threads: { t3_ok: makeThread(crowded, [makeComment({ commentId: 't1_big', body: 'the answer', score: 900 })]) },
  });
  const { ask, asked } = scriptedAsk([]);

  const out = await scanForComment({ reader, ask, nowMs: NOW, random: () => 0 }, { settings: settings(), pairs, history: [] });
  assert.equal(out.skipStage, 'judge');
  assert.equal(calls.getThread, 1);
  assert.equal(asked.length, 0);
});

test('no gap means no generation call', async () => {
  const { deps, asked } = fullDeps([{ ...GAP_OK, gapState: 'none', angle: '' }]);
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(out.skipStage, 'gap');
  assert.equal(asked.length, 1, 'writing three comments for a thread with nothing to add is pure waste');
  // The thread and the room are still recorded: a skip is evidence, not a blank.
  assert.ok(out.thread);
  assert.equal(out.gap.gapState, 'none');
});

test('everything failing a gate ends the scan without paying for a critic', async () => {
  const { deps, asked } = fullDeps([GAP_OK, { candidates: [LINKED, 'Hope this helps!'] }]);
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(out.skipStage, 'gates');
  assert.equal(asked.length, 2);
  assert.equal(out.rejected.length, 2);
});

test('"none of these" from the critic is a normal outcome, with its reason kept', async () => {
  const { deps } = fullDeps([
    GAP_OK,
    { candidates: [GOOD1, GOOD2] },
    { chosen: null, reason: 'both read as advice to someone who was venting' },
  ]);
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });

  assert.equal(out.produced, false);
  assert.equal(out.skipStage, 'critic');
  assert.match(out.criticReason, /venting/);
});

test('a model that returns junk skips rather than posting a guess', async () => {
  const { deps } = fullDeps([GAP_OK, { candidates: ['', '   ', null] }]);
  const out = await scanForComment(deps, { settings: settings(), pairs, history: [] });
  assert.equal(out.skipStage, 'generate');
});

test('nothing to search for is a skip, not a crash', async () => {
  const { deps, calls } = fullDeps([]);
  const out = await scanForComment(deps, {
    settings: settings(),
    pairs: [{ subreddit: 'askreddit', keywords: [] }],
    history: [],
  });
  assert.equal(out.skipStage, 'search');
  assert.equal(calls.search, 0);
});

test('a reader fault propagates instead of being filed as a judgement', async () => {
  // "Crawlzo is unauthorised" is not the same fact as "no thread was worth
  // entering", and filing one as the other makes an outage look like the gates
  // doing their job.
  const { ask } = scriptedAsk([]);
  await assert.rejects(
    scanForComment(
      {
        reader: {
          async search() {
            throw new Error('Crawlzo UNAUTHORIZED');
          },
          async getThread() {
            return null;
          },
        },
        ask,
        nowMs: NOW,
        random: () => 0,
      },
      { settings: settings(), pairs, history: [] },
    ),
    /UNAUTHORIZED/,
  );
});

// --- history ----------------------------------------------------------------

test('history is built from what we actually posted, and drops the empties', () => {
  const h = historyFromPosted([
    { text: GOOD1, subreddit: 'askreddit', postedAtMs: NOW },
    { text: null, subreddit: 'askreddit', postedAtMs: NOW },
    { text: '   ', subreddit: 'cooking', postedAtMs: NOW },
  ]);
  assert.equal(h.length, 1);
  assert.equal(h[0].opening, 'took me about');
  assert.equal(h[0].words, 17);
});
