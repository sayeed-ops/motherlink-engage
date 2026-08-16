// The three checks before posting: can we defend it, will it start a fight, and
// does the ACCOUNT look like a bot.
//
// The two that carry the design:
//   - Length is enforced against a band measured from the thread. The same text
//     is too long in one room and too short in another, and nothing tells the
//     code which room it is in.
//   - The bot-tell gate is account-level. It refuses a comment that would extend
//     a pattern, it does NOT refuse a comment that breaks one, and it refuses
//     nothing at all on a new account — because blocking there would deadlock
//     exactly like an unknown subreddit in select.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateComment,
  extractClaims,
  firstSentence,
} from '../../apps/web/src/modules/reddit/commentKarma/validate.ts';
import {
  screenConflict,
  threadTemperature,
} from '../../apps/web/src/modules/reddit/commentKarma/conflict.ts';
import {
  screenAccountTiming,
  screenBotTell,
  botTellPressure,
  openingOf,
  historyEntryOf,
  clockSpanHours,
  MIN_HISTORY,
  BOT_TELL_LIMITS,
} from '../../apps/web/src/modules/reddit/commentKarma/botTell.ts';
import {
  runGates,
  screenCandidates,
  screenBeforeGeneration,
} from '../../apps/web/src/modules/reddit/commentKarma/gates.ts';
import {
  profileRoom,
  targetLength,
} from '../../apps/web/src/modules/reddit/commentKarma/roomProfile.ts';
import { makeComment } from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const room = (bodies) =>
  profileRoom(bodies.map((body, i) => makeComment({ commentId: `t1_${i}`, body, score: 5 })));

const ordinary = room([
  'we ended up doing it ourselves and it took a whole weekend but it was fine in the end',
  'mine came in at roughly the same and i would do it again if i had to honestly',
  'took a couple of tries before it stuck but the second one worked out much better',
  'i left mine far too late and paid for it later on which was entirely my own fault',
  'worth doing early if you can, mine dragged on for ages because i kept putting it off',
]);

const ctx = (over = {}) => ({
  length: targetLength(ordinary),
  profile: ordinary,
  comments: [],
  subreddit: 'askreddit',
  history: [],
  ...over,
});

const codes = (r) => r.failures.map((f) => f.code);

const GOOD = 'took me about six months and roughly two hundred quid, mostly because i kept putting it off';

test('an ordinary comment in an ordinary room passes everything', () => {
  const r = runGates(GOOD, ctx());
  assert.deepEqual(r.failures, [], JSON.stringify(r.failures));
  assert.equal(r.ok, true);
});

// --- length is copied, and the proof is the same text judged twice ----------

test('the same comment is too long in one room and too short in another', () => {
  const text =
    'we did the same thing last winter and it worked out fine for us in the end, though it took a while longer than we expected and cost a bit more than the quote we were given';

  const oneLiner = room(['same', 'this', 'lol no', 'yep', 'ha']);
  const essay = room(Array.from({ length: 5 }, () => 'word '.repeat(150).trim()));

  const short = validateComment(text, { length: targetLength(oneLiner), profile: oneLiner });
  const long = validateComment(text, { length: targetLength(essay), profile: essay });

  assert.ok(codes(short).includes('too-long'), codes(short).join(','));
  assert.ok(codes(long).includes('too-short'), codes(long).join(','));
  // Nothing told either call which kind of room it was in.
});

test('the first-sentence cap scales with the room instead of being a constant', () => {
  const opener = `${'word '.repeat(40).trim()}. and then a short one.`;
  const essay = room(Array.from({ length: 5 }, () => 'word '.repeat(150).trim()));
  assert.equal(firstSentence(opener).split(' ').length, 40);
  assert.ok(!codes(validateComment(opener, { length: targetLength(essay), profile: essay })).includes('first-line-too-long'));
  assert.ok(codes(validateComment(opener, { length: targetLength(ordinary), profile: ordinary })).includes('first-line-too-long'));
});

// --- the tells --------------------------------------------------------------

test('assistant openers, closers and phrasing are refused', () => {
  const cases = [
    ['Great question, mine took about six months to sort out in the end honestly', 'banned-opener'],
    ['As someone who has done this a few times, it took me about six months', 'banned-opener'],
    ['mine took about six months and it was fine in the end. Hope this helps!', 'banned-closer'],
    ['mine took six months. It is important to note that yours may differ from mine', 'assistant-tell'],
    ['commenting so i can find this later, mine took about six months to sort out', 'meta'],
  ];
  for (const [text, code] of cases) {
    assert.ok(codes(validateComment(text, ctx())).includes(code), `${code} missed on: ${text}`);
  }
});

test('links and brand mentions are refused', () => {
  const link = validateComment('mine took six months, there is a good guide at example.com about it', ctx());
  assert.ok(codes(link).includes('link'));

  const brand = validateComment('mine took six months, i used Motherlink for the whole thing and it was fine', {
    ...ctx(),
    bannedTerms: ['Motherlink'],
  });
  assert.ok(codes(brand).includes('brand'));
});

test('bullets are refused only where the room has been measured as plain prose', () => {
  const bulleted = 'a few things that mattered for me here\n- the first one\n- the second one\n- the third one';
  assert.ok(codes(validateComment(bulleted, ctx())).includes('formatting'));

  // Two comments cannot tell us that nobody here uses bullets.
  const thin = room(['ok fine', 'sure thing']);
  assert.ok(!codes(validateComment(bulleted, { length: targetLength(thin), profile: thin })).includes('formatting'));
});

// --- defensibility ----------------------------------------------------------

test('a specific from your own life is fine; the same number as a general fact is not', () => {
  // The design WANTS specifics — "six months, about £200" beats "it varies".
  // What it cannot have is the same number with the speaker taken out, because
  // there is no honest answer to "where did you get that".
  const lived = extractClaims('It took me about six months and cost me roughly £200.');
  assert.equal(lived[0].kind, 'experience');
  assert.equal(lived[0].defensible, true);

  const cited = extractClaims('The average cost is £200 and it takes six months.');
  assert.equal(cited[0].kind, 'fact');
  assert.equal(cited[0].defensible, false);

  assert.ok(codes(validateComment('The average wait is 14 months for most people who apply for one of these', ctx())).includes('unverifiable-statistic'));
});

test('appeals to a source we do not have are refused', () => {
  const r = validateComment('studies show that most people give up on this within about a year of starting', ctx());
  assert.ok(codes(r).includes('appeal-to-authority'));
});

test('hedged opinions stay defensible', () => {
  const claims = extractClaims('I think it is probably closer to six months for most people.');
  assert.equal(claims[0].kind, 'opinion');
  assert.equal(claims[0].defensible, true);
});

test('every failure is reported, not just the first', () => {
  // The review panel has to show an operator why nothing was posted.
  const r = validateComment('Great question! Studies show it takes 6 months. See example.com. Hope this helps!', ctx());
  const found = new Set(codes(r));
  for (const code of ['banned-opener', 'appeal-to-authority', 'link', 'banned-closer']) {
    assert.ok(found.has(code), `${code} missing from ${[...found].join(',')}`);
  }
});

test('a comment identical to one already in the thread is refused', () => {
  const existing = [makeComment({ commentId: 't1_x', body: GOOD })];
  assert.ok(codes(validateComment(GOOD, { ...ctx(), existing })).includes('duplicate'));
});

// --- conflict ---------------------------------------------------------------

test('naming a person, judging a person, and politics are all refused', () => {
  const cases = [
    ['u/someone said the same thing and they were right about it', 'names-a-person'],
    ['that is a selfish way to treat someone who is trying their best', 'moral-judgment'],
    ['this is exactly what the election was about for a lot of people', 'charged-topic'],
    ['you clearly did not read the post before writing all of that', 'second-person-accusation'],
  ];
  for (const [text, code] of cases) {
    assert.ok(codes(screenConflict(text)).includes(code), `${code} missed on: ${text}`);
  }
});

test('an absolute is refused, unless it is scoped to yourself', () => {
  assert.ok(codes(screenConflict('that never works for people in that situation')).includes('absolute'));
  // "I have never managed it" is a story. "That never works" is a claim someone
  // will arrive with a counterexample to.
  assert.deepEqual(codes(screenConflict('i have never managed to make that work for me')), []);
});

test('disagreement is allowed in exactly one shape', () => {
  const blunt = screenConflict("that's not true, the fee is waived for most people");
  assert.ok(codes(blunt).includes('blunt-contradiction'));

  const shaped = screenConflict(
    'true for a lot of people, though in my case the fee was waived because i applied before the deadline',
  );
  assert.deepEqual(codes(shaped), [], JSON.stringify(shaped.failures));
});

test('a thread already arguing is not entered at all', () => {
  const hostile = [
    makeComment({ commentId: 'a', body: "that's not true and you know it", score: 4 }),
    makeComment({ commentId: 'b', body: 'you clearly have no idea what you are talking about', score: 2 }),
    makeComment({ commentId: 'c', body: 'reasonable point, mine went the same way', score: 9 }),
  ];
  assert.ok(threadTemperature(hostile) > 0.3);
  assert.ok(codes(screenConflict(GOOD, hostile)).includes('hostile-thread'));
  assert.equal(threadTemperature([]), 0);
});

// --- bot tell: the account, not the comment ---------------------------------

const BASE = Date.UTC(2026, 0, 10, 9, 0, 0);
const HOUR = 3_600_000;

const history = (specs) =>
  specs.map((s, i) => ({
    postedAtMs: BASE + (s.atHours ?? i * 7) * HOUR,
    words: s.words ?? 20,
    subreddit: s.subreddit ?? 'askreddit',
    opening: s.opening ?? `opener ${i} here`,
  }));

const uniform = (n, over = {}) => history(Array.from({ length: n }, () => ({ ...over })));

test('openingOf and historyEntryOf agree on what an opening is', () => {
  assert.equal(openingOf(GOOD), 'took me about');
  const e = historyEntryOf(GOOD, 'AskReddit', BASE);
  assert.equal(e.opening, 'took me about');
  assert.equal(e.words, 17);
});

test('a new account is never blocked — there is no pattern to detect yet', () => {
  // The same deadlock rule as an unknown subreddit in select.ts: refusing on no
  // evidence means the account can never build the evidence.
  const tiny = uniform(MIN_HISTORY - 1, { opening: 'took me about', words: 17 });
  assert.deepEqual(screenBotTell({ words: 17, opening: 'took me about', subreddit: 'askreddit' }, tiny).failures, []);
  assert.deepEqual(screenAccountTiming(tiny, 'askreddit', BASE + 100 * HOUR).failures, []);
  assert.deepEqual(botTellPressure(tiny), { wantsBrief: false, avoidOpenings: [], lengthCeiling: null });
});

test('repeating a recent opening is refused', () => {
  const h = history([{ opening: 'took me about' }, {}, {}, {}, {}, {}]);
  assert.ok(codes(screenBotTell({ words: 40, opening: 'took me about', subreddit: 'askreddit' }, h)).includes('opening-repeat'));
});

test('uniform lengths refuse the comment that extends them, not the one that breaks them', () => {
  const h = uniform(6, { words: 20 });
  const extends_ = screenBotTell({ words: 21, opening: 'a fresh opening', subreddit: 'askreddit' }, h);
  assert.ok(codes(extends_).includes('length-uniform'));

  const breaks = screenBotTell({ words: 5, opening: 'a fresh opening', subreddit: 'askreddit' }, h);
  assert.deepEqual(codes(breaks), []);
});

test('an account that is never unimpressive has to be, eventually', () => {
  const h = uniform(BOT_TELL_LIMITS.maxConsideredStreak, { words: 20 });
  const considered = screenBotTell({ words: 40, opening: 'a fresh opening', subreddit: 'askreddit' }, h);
  assert.ok(codes(considered).includes('all-considered'));

  // And "same" gets through, which is the entire point.
  const brief = screenBotTell({ words: 3, opening: 'yeah same here', subreddit: 'askreddit' }, h);
  assert.deepEqual(codes(brief), []);
  assert.equal(botTellPressure(h).wantsBrief, true);
});

test('pressure steers the next comment rather than only refusing it', () => {
  const h = history([
    { opening: 'took me about', words: 20 },
    { opening: 'took me about', words: 21 },
    { opening: 'mine was fine', words: 20 },
    { opening: 'mine was fine', words: 19 },
    { opening: 'i left mine', words: 20 },
  ]);
  const p = botTellPressure(h);
  assert.deepEqual(p.avoidOpenings.sort(), ['i left mine', 'mine was fine', 'took me about']);
  assert.ok(p.lengthCeiling !== null && p.lengthCeiling < 20, `ceiling was ${p.lengthCeiling}`);
});

test('an even cadence is refused; a lumpy one is not', () => {
  const even = history([{ atHours: 0 }, { atHours: 3 }, { atHours: 6 }, { atHours: 9 }, { atHours: 12 }, { atHours: 15 }]);
  assert.ok(codes(screenAccountTiming(even, 'askreddit', BASE + 18 * HOUR)).includes('cadence-regular'));

  const lumpy = history([{ atHours: 0 }, { atHours: 5 }, { atHours: 19 }, { atHours: 26 }, { atHours: 51 }]);
  assert.deepEqual(codes(screenAccountTiming(lumpy, 'askreddit', BASE + 70 * HOUR)), []);
});

test('an account that only ever comments in the same few hours is refused', () => {
  const clockwork = history([
    { atHours: 0 },
    { atHours: 25 },
    { atHours: 46 },
    { atHours: 75 },
    { atHours: 96 },
  ]);
  assert.ok(codes(screenAccountTiming(clockwork, 'askreddit', BASE + 120.5 * HOUR)).includes('clock-narrow'));
  // Circular, so 23:00 and 01:00 are two hours apart rather than twenty-two.
  assert.ok(clockSpanHours([Date.UTC(2026, 0, 1, 23), Date.UTC(2026, 0, 2, 1)]) <= 3);
});

test('an account living in one subreddit is refused there and nowhere else', () => {
  const h = uniform(BOT_TELL_LIMITS.maxSameSubStreak, { subreddit: 'askreddit' });
  assert.ok(codes(screenAccountTiming(h, 'askreddit', BASE + 200 * HOUR)).includes('sub-monotony'));
  assert.ok(!codes(screenAccountTiming(h, 'cooking', BASE + 200 * HOUR)).includes('sub-monotony'));
});

// --- composition ------------------------------------------------------------

test('the timing gate runs before anything is written', () => {
  const even = history([{ atHours: 0 }, { atHours: 3 }, { atHours: 6 }, { atHours: 9 }, { atHours: 12 }, { atHours: 15 }]);
  const r = screenBeforeGeneration(ctx({ history: even }), BASE + 18 * HOUR);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].gate, 'bot-tell');
});

test('failures from every gate are collected together and labelled', () => {
  const r = runGates('u/someone linked example.com and that never works for anyone in that position', ctx());
  const gates = new Set(r.failures.map((f) => f.gate));
  assert.ok(gates.has('mechanical'), 'expected the link to be caught');
  assert.ok(gates.has('conflict'), 'expected the mention to be caught');
});

test('candidates are split into what could be posted and what could not', () => {
  const { survivors, rejected } = screenCandidates(
    [GOOD, 'Great question! Hope this helps!', 'mine dragged on for ages too because i kept forgetting to chase it up'],
    ctx(),
  );
  assert.equal(survivors.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.ok(rejected[0].failures.length >= 2);
});
