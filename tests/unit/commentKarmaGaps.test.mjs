// Room profiling and gap analysis.
//
// Two rules carry most of the design and both are tested here:
//   - LENGTH IS COPIED from what is winning in this thread, never chosen.
//   - A point already made is NOT automatically a reason to stay out; the
//     best-phrased version of an obvious answer often outranks whoever was
//     first, so 'said-badly' has to survive parsing as a real move.
//
// The parser tests are mostly about REFUSING. An unparseable or empty model
// response must collapse to a skip, because the alternative is posting a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  profileRoom,
  winnersOf,
  extractJargon,
  targetLength,
  isConfident,
  MIN_SAMPLE,
} from '../../apps/web/src/modules/reddit/commentKarma/roomProfile.ts';
import {
  buildGapPrompt,
  parseGapAnalysis,
  shouldProceed,
  proceedRefusal,
  IMPROVE_CONFIDENCE,
} from '../../apps/web/src/modules/reddit/commentKarma/gaps.ts';
import { makeComment, makeThread, makePost } from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const comments = (bodies, scores = []) =>
  bodies.map((body, i) =>
    makeComment({ commentId: `t1_${i}`, body, score: scores[i] ?? 10 }),
  );

// --- length is copied, not chosen ------------------------------------------

test('a one-liner room yields a one-liner target', () => {
  const p = profileRoom(comments(['same', 'this', 'lol no', 'exactly this', 'yep'], [40, 30, 25, 20, 15]));
  assert.ok(p.medianWinnerWords <= 3, `expected a tiny target, got ${p.medianWinnerWords}`);
  assert.ok(targetLength(p).max < 40, 'a one-liner room must not permit an essay');
});

test('an essay room yields an essay target', () => {
  const long = 'word '.repeat(150).trim();
  const p = profileRoom(comments([long, long, long, long, long], [50, 40, 30, 20, 10]));
  assert.ok(p.medianWinnerWords > 100, `expected a long target, got ${p.medianWinnerWords}`);
  assert.ok(targetLength(p).target > 100);
});

test('the same code produces opposite answers for the two rooms', () => {
  // The point of measuring rather than configuring: nothing told it which
  // kind of room either of these was.
  const short = profileRoom(comments(['same', 'this', 'lol', 'yep', 'ha'], [9, 8, 7, 6, 5]));
  const longBody = 'word '.repeat(120).trim();
  const long = profileRoom(comments([longBody, longBody, longBody, longBody, longBody], [9, 8, 7, 6, 5]));
  assert.ok(targetLength(long).target > targetLength(short).target * 10);
});

// --- winners ---------------------------------------------------------------

test('winners are judged against the thread median, not an absolute score', () => {
  // 12 points is a triumph in a small sub and invisible in a default one.
  // median of [0,1,2,4,9,12] is 3 → winners are the three above it.
  const small = winnersOf(comments(['a', 'b', 'c', 'd', 'e', 'f'], [12, 9, 4, 2, 1, 0]));
  assert.equal(small.length, 3, 'should keep the above-median tail only');
  assert.ok(small.every((c) => c.score > 3));
  // Few winners is not the same as no winners: three of six is a real signal,
  // and must not collapse back to profiling the whole thread.
  assert.ok(small.length < 6);
});

test('a thread where every score ties still yields a profile', () => {
  // Common on young threads. An empty winners list would profile nothing.
  const p = profileRoom(comments(['aa bb', 'cc dd', 'ee ff', 'gg hh', 'ii jj'], [1, 1, 1, 1, 1]));
  assert.equal(p.sampleSize, 5);
  assert.ok(p.medianWinnerWords > 0);
});

test('confidence is refused on a tiny sample', () => {
  assert.equal(isConfident(profileRoom(comments(['a', 'b'], [5, 4]))), false);
  const many = comments(Array.from({ length: MIN_SAMPLE + 4 }, () => 'a few words here'), []);
  assert.equal(isConfident(profileRoom(many)), true);
});

// --- register --------------------------------------------------------------

test('register is measured, not assumed', () => {
  const casual = profileRoom(
    comments(["i don't know man", "that's rough", "can't help there", "won't work"], [9, 8, 7, 6]),
  );
  const formal = profileRoom(
    comments(
      ['I do not believe that is correct.', 'It will not work.', 'That is unfortunate.', 'I cannot assist.'],
      [9, 8, 7, 6],
    ),
  );
  assert.ok(casual.contractionRate > formal.contractionRate);
  assert.ok(casual.lowercaseOpenRate > formal.lowercaseOpenRate);
});

test('the punished set is captured separately from the winners', () => {
  const list = [
    ...comments(['good one', 'nice'], [20, 15]),
    makeComment({ commentId: 't1_bad', body: 'well actually you are all wrong', score: -4 }),
    makeComment({ commentId: 't1_bad2', body: 'this is stupid', score: 0 }),
  ];
  const p = profileRoom(list);
  assert.equal(p.negative.count, 2);
});

// --- jargon ----------------------------------------------------------------

test('jargon finds in-group words and drops ordinary English', () => {
  const j = extractJargon(
    comments([
      'the taper was rough for me',
      'my taper took months',
      'taper slowly and it is fine',
      'i think you should taper',
    ]),
  );
  assert.ok(j.includes('taper'), `expected taper in ${JSON.stringify(j)}`);
  for (const stop of ['the', 'you', 'and', 'think', 'should']) {
    assert.ok(!j.includes(stop), `stopword leaked: ${stop}`);
  }
});

test('one person repeating a word does not make it the room vocabulary', () => {
  const j = extractJargon([
    makeComment({ commentId: 'a', body: 'blorp blorp blorp blorp blorp' }),
    makeComment({ commentId: 'b', body: 'nothing unusual here at all' }),
    makeComment({ commentId: 'c', body: 'nothing unusual here at all' }),
    makeComment({ commentId: 'd', body: 'nothing unusual here at all' }),
  ]);
  assert.ok(!j.includes('blorp'));
});

// --- the prompt ------------------------------------------------------------

test('the prompt carries comment ids so a target can be pointed at', () => {
  const thread = makeThread(makePost(), comments(['first', 'second'], [10, 5]));
  const { user } = buildGapPrompt(thread, profileRoom(thread.comments));
  assert.match(user, /id=t1_0/);
  assert.match(user, /score=10/);
});

test('the prompt never asks for a style, tone or length', () => {
  const thread = makeThread(makePost(), comments(['a', 'b', 'c', 'd'], [9, 8, 7, 6]));
  const { system, user } = buildGapPrompt(thread, profileRoom(thread.comments));
  const both = `${system}\n${user}`.toLowerCase();
  // Style must fall out of the gap. Asking a model to pick one produces a
  // model's idea of a style, which is how comments start sounding like comments.
  assert.ok(!/choose a (tone|style)|pick a (tone|style)|write (a )?(funny|humorous)/.test(both));
  assert.match(system, /never suggest a style/i);
});

test('a title-only post is described as such rather than sent as an empty body', () => {
  const thread = makeThread(makePost({ body: '' }), []);
  const { user } = buildGapPrompt(thread, profileRoom([]));
  assert.match(user, /the title is the whole post/i);
  assert.match(user, /no comments yet/i);
});

// --- parsing: mostly about refusing ----------------------------------------

const good = {
  posterWant: 'information',
  delivered: 'a few vague guesses',
  gapState: 'absent',
  angle: 'give the actual number',
  targetCommentId: null,
  confidence: 0.8,
};

test('a well-formed response parses', () => {
  const g = parseGapAnalysis(good);
  assert.equal(g.gapState, 'absent');
  assert.equal(shouldProceed(g), true);
});

test('garbage collapses to a skip rather than a guess', () => {
  for (const bad of [null, undefined, 'text', 42, {}, { gapState: 'maybe' }, { posterWant: 'vibes' }]) {
    assert.equal(parseGapAnalysis(bad), null, `parsed junk: ${JSON.stringify(bad)}`);
    assert.equal(shouldProceed(parseGapAnalysis(bad)), false);
  }
});

test("a gap with nothing to say is downgraded to 'none'", () => {
  // A confident-sounding empty answer must not reach generation.
  const g = parseGapAnalysis({ ...good, angle: '   ' });
  assert.equal(g.gapState, 'none');
  assert.equal(shouldProceed(g), false);
});

test("'none' never proceeds", () => {
  assert.equal(shouldProceed(parseGapAnalysis({ ...good, gapState: 'none', angle: '' })), false);
});

// --- the operator's clarification, encoded ---------------------------------

test("'said-badly' is a real move — an existing point is not a reason to stay out", () => {
  const g = parseGapAnalysis({
    ...good,
    gapState: 'said-badly',
    angle: 'the same answer in one clean sentence',
    targetCommentId: 't1_3',
    confidence: 0.75,
  });
  assert.equal(g.gapState, 'said-badly');
  assert.equal(shouldProceed(g), true, 'saying it better must be allowed');
});

test('improving on someone needs a target and a higher bar than saying something new', () => {
  const base = { ...good, gapState: 'buried', angle: 'surface it', targetCommentId: 't1_9' };
  // No target: unactionable downstream.
  assert.equal(shouldProceed(parseGapAnalysis({ ...base, targetCommentId: null })), false);
  // Below the improve bar, but above the absent bar — proves the two differ.
  const low = IMPROVE_CONFIDENCE - 0.1;
  assert.equal(shouldProceed(parseGapAnalysis({ ...base, confidence: low })), false);
  assert.equal(shouldProceed(parseGapAnalysis({ ...good, confidence: low })), true);
});

test('a refused gap says WHICH bar it failed, not "nothing worth adding"', () => {
  // The first live runs reported `Gap state "partial" — nothing worth adding`,
  // which is false and misleading at once: 'partial' MEANS there is something
  // to add. Reporting the state as the reason would hide the failure that
  // matters most — a model that never names a targetCommentId silently disables
  // three of the five gap states and every one of them reads as "no gap".
  const noTarget = parseGapAnalysis({ ...good, gapState: 'partial', angle: 'add the qualifier', targetCommentId: null, confidence: 0.9 });
  assert.match(proceedRefusal(noTarget), /point at the comment it improves on/);

  const lowImprove = parseGapAnalysis({ ...good, gapState: 'buried', angle: 'surface it', targetCommentId: 't1_2', confidence: 0.4 });
  assert.match(proceedRefusal(lowImprove), /below the 0.6 bar/);

  const lowAbsent = parseGapAnalysis({ ...good, confidence: 0.2 });
  assert.match(proceedRefusal(lowAbsent), /below the 0.45 bar/);

  assert.match(proceedRefusal(parseGapAnalysis({ ...good, gapState: 'none', angle: '' })), /said well, and is at the top/);
  assert.match(proceedRefusal(null), /unusable/);

  // And null when it is going ahead — the two functions must agree.
  const fine = parseGapAnalysis({ ...good, confidence: 0.8 });
  assert.equal(proceedRefusal(fine), null);
  assert.equal(shouldProceed(fine), true);
});

test('confidence is clamped, not trusted', () => {
  assert.equal(parseGapAnalysis({ ...good, confidence: 99 }).confidence, 1);
  assert.equal(parseGapAnalysis({ ...good, confidence: -5 }).confidence, 0);
});
