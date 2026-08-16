// Writing the comment, and the second pass that refuses it.
//
// The two things these tests protect:
//   - The generation prompt COPIES the room (length, register) and never asks
//     the model to choose a style, a tone or a length. Style falls out of the
//     gap; a model asked to pick one returns a model's idea of one.
//   - "None of these" survives every layer. The critic answers with a 1-based
//     number, an out-of-range number is a SKIP rather than a clamp, and a
//     rewritten candidate can never reach the poster — because each of those,
//     got wrong, posts a comment nobody chose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGenerationPrompt,
  parseCandidates,
  renderRegister,
  CANDIDATE_COUNT,
  EMPTY_PERSONA,
} from '../../apps/web/src/modules/reddit/commentKarma/generate.ts';
import {
  buildCriticPrompt,
  parseCriticVerdict,
  chosenCandidate,
} from '../../apps/web/src/modules/reddit/commentKarma/critic.ts';
import {
  profileRoom,
  targetLength,
} from '../../apps/web/src/modules/reddit/commentKarma/roomProfile.ts';
import {
  makeComment,
  makePost,
  makeThread,
} from '../../apps/web/src/modules/reddit/reader/fixtures.ts';

const comments = (bodies, scores = []) =>
  bodies.map((body, i) => makeComment({ commentId: `t1_${i}`, body, score: scores[i] ?? 10 }));

const GAP = {
  posterWant: 'information',
  delivered: 'four people guessing',
  gapState: 'absent',
  angle: 'the actual cost, from having done it',
  targetCommentId: null,
  confidence: 0.8,
};

const ROOM = comments(['a short line here', 'another short line', 'third short line', 'fourth short line'], [9, 8, 7, 6]);
const PROFILE = profileRoom(ROOM);
const THREAD = makeThread(makePost(), ROOM);

const persona = {
  topics: ['budgeting', 'renting'],
  situation: 'renting in Manchester, works in a warehouse',
  neverClaims: ['a doctor', 'a lawyer'],
};

// --- the prompt copies, and never chooses -----------------------------------

test('the generation prompt never asks for a style, a tone or a length', () => {
  const { system, user } = buildGenerationPrompt(THREAD, PROFILE, GAP, persona, targetLength(PROFILE));
  const both = `${system}\n${user}`.toLowerCase();
  // The same rule gaps.ts is held to, one layer later and easier to break here,
  // because this is the prompt that actually writes prose.
  assert.ok(!/\b(funny|humorous|witty|empathetic|professional|friendly|conversational tone|choose a tone|pick a tone|what tone)\b/.test(both), both.match(/\b(funny|humorous|witty|empathetic|professional|friendly)\b/)?.[0]);
  assert.ok(!/decide how long|choose a length|as long as you (like|want)/.test(both));
});

test('the length band comes from the room, not from the prompt', () => {
  const band = targetLength(PROFILE);
  const { user } = buildGenerationPrompt(THREAD, PROFILE, GAP, persona, band);
  assert.match(user, new RegExp(`between ${band.min} and ${band.max} words`));
  assert.match(user, new RegExp(`about ${PROFILE.medianWinnerWords} words`));
});

test('register is stated as measurement, and withheld when the thread is too thin to measure', () => {
  const thin = profileRoom(comments(['ok', 'sure'], [3, 2]));
  const lines = renderRegister(thin, targetLength(thin)).join('\n');
  assert.match(lines, /too thin to read the room/i);
  // A two-comment thread must not manufacture a register out of two people.
  assert.ok(!/of 10 winning comments/.test(lines));

  const measured = renderRegister(PROFILE, targetLength(PROFILE)).join('\n');
  assert.match(measured, /\d of 10 winning comments use contractions/);
});

test('the gap, and the comment being improved on, reach the prompt', () => {
  const thread = makeThread(makePost(), comments(['a rambling hedged half-answer about it', 'nope'], [4, 1]));
  const { user } = buildGenerationPrompt(
    thread,
    profileRoom(thread.comments),
    { ...GAP, gapState: 'said-badly', targetCommentId: 't1_0' },
    persona,
    targetLength(PROFILE),
  );
  assert.match(user, /THE GAP TO FILL: the actual cost/);
  assert.match(user, /a rambling hedged half-answer/);
  // Saying it better is not the same as announcing a correction.
  assert.match(user, /do not mention that it was said/i);
});

test('no persona means claim nothing, rather than claim anything', () => {
  const { user } = buildGenerationPrompt(THREAD, PROFILE, GAP, EMPTY_PERSONA, targetLength(PROFILE));
  assert.match(user, /Claim no expertise/i);
  assert.ok(!/YOU KNOW ABOUT/.test(user));

  const withPersona = buildGenerationPrompt(THREAD, PROFILE, GAP, persona, targetLength(PROFILE)).user;
  assert.match(withPersona, /warehouse/);
  assert.match(withPersona, /MUST NEVER CLAIM TO BE: a doctor, a lawyer/);
});

test('openings the account has used recently are pushed into the prompt', () => {
  const { user } = buildGenerationPrompt(THREAD, PROFILE, GAP, persona, targetLength(PROFILE), {
    avoidOpenings: ['took me about', 'honestly i just'],
  });
  assert.match(user, /DO NOT BEGIN WITH: "took me about", "honestly i just"/);
});

// --- parsing candidates -----------------------------------------------------

test('candidates parse from either shape the model might return', () => {
  const a = parseCandidates({ candidates: ['one two three', 'four five six'] });
  const b = parseCandidates([{ text: 'one two three' }, { text: 'four five six' }]);
  assert.deepEqual(a.map((c) => c.text), b.map((c) => c.text));
  assert.equal(a[0].words, 3);
});

test('junk yields no candidates rather than a repaired one', () => {
  for (const bad of [null, undefined, 'text', 42, {}, { candidates: 'one' }, { candidates: [null, '', '   '] }]) {
    assert.deepEqual(parseCandidates(bad), [], `parsed junk: ${JSON.stringify(bad)}`);
  }
});

test('numbering, fences and quotes the model adds are stripped', () => {
  const parsed = parseCandidates({
    candidates: ['1. first one here', '```\nsecond one here\n```', '"third one here"', 'Candidate 4: fourth one'],
  }, 4);
  assert.deepEqual(parsed.map((c) => c.text), [
    'first one here',
    'second one here',
    'third one here',
    'fourth one',
  ]);
});

test('near-duplicates are dropped, so the critic never gets a fake choice', () => {
  // Three rewordings of one sentence is one attempt. A fake choice reliably
  // produces a pick, and the pick this system needs most is "none".
  const parsed = parseCandidates({
    candidates: ['Took me about six months.', 'took me about six months', 'about six months for me'],
  });
  assert.equal(parsed.length, 2);
});

test('more candidates than asked for are truncated, not averaged in', () => {
  const parsed = parseCandidates({ candidates: ['one a', 'two b', 'three c', 'four d', 'five e'] });
  assert.equal(parsed.length, CANDIDATE_COUNT);
});

// --- the critic -------------------------------------------------------------

const CANDIDATES = parseCandidates({ candidates: ['first one here', 'second one here', 'third one here'] });

test('the critic prompt numbers from 1 and makes refusing easy', () => {
  const { system, user } = buildCriticPrompt(CANDIDATES, THREAD, GAP, PROFILE);
  assert.match(user, /\(1\) \[3 words\]/);
  assert.match(user, /\(3\) \[3 words\]/);
  assert.match(system, /CHOOSE NONE FREELY/);
  assert.match(system, /Do not rewrite/i);
});

test('a 1-based answer becomes a 0-based index', () => {
  const v = parseCriticVerdict({ chosen: 2, reason: 'it is the only one that answers what was asked' }, 3);
  assert.equal(v.chosenIndex, 1);
  assert.equal(chosenCandidate(v, CANDIDATES).text, 'second one here');
});

test('an out-of-range choice is a skip, never a clamp', () => {
  // Clamping posts a comment the critic did not choose, which is worse than
  // posting nothing.
  for (const n of [0, 4, -1, 1.5, '2']) {
    assert.equal(parseCriticVerdict({ chosen: n, reason: 'because' }, 3).chosenIndex, null, `chosen=${n}`);
  }
});

test('"none of these" is a first-class answer and keeps its reason', () => {
  const v = parseCriticVerdict({ chosen: null, reason: 'all three read as advice to someone venting' }, 3);
  assert.equal(v.chosenIndex, null);
  assert.match(v.reason, /venting/);
  assert.equal(chosenCandidate(v, CANDIDATES), null);
});

test('a choice with no reason is not a choice', () => {
  assert.equal(parseCriticVerdict({ chosen: 1, reason: '   ' }, 3).chosenIndex, null);
  assert.equal(parseCriticVerdict({ chosen: 1 }, 3).chosenIndex, null);
  assert.equal(parseCriticVerdict('nope', 3).chosenIndex, null);
});

test('a critic that rewrites a candidate is ignored', () => {
  // A rewritten text has bypassed every generation constraint and every gate
  // that ran on the original, so the text always comes from OUR array.
  const v = parseCriticVerdict({ chosen: 1, reason: 'tidied it up', text: 'here is my improved version' }, 3);
  assert.equal(chosenCandidate(v, CANDIDATES).text, 'first one here');
});
