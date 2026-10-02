// The project reply pipeline: read the thread, then write inside the decision.
//
// What these tests protect:
//   - The mention level is enforced in CODE. A growth reply that names the
//     client is discarded however well it reads, and if every attempt does it
//     the draft fails rather than shipping one.
//   - The thread may sharpen the angle and never loses it: an unusable
//     refinement falls back to the analysis angle, not to nothing.
//   - Length is measured from the thread when there is enough of one, and sized
//     from the POST when there is not — never the 13-word cap that suits a
//     karma comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_ROOM_WORDS,
  REPLY_MAX_WORDS,
  analysisAngle,
  buildPickPrompt,
  buildRefinePrompt,
  buildReplyPrompt,
  checkReply,
  claimsAffiliation,
  companyTerms,
  draftProjectReply,
  measureRoom,
  namesCompany,
  parseJsonLoose,
  parseRefinement,
  threadRefusal,
  ReplyPipelineError,
} from '../../apps/web/src/modules/reddit/replyPipeline.ts';
import { makeComment, makePost, makeThread } from '../../apps/web/src/modules/forum/reader/fixtures.ts';

const PROJECT = {
  name: 'Acme Pay',
  websiteUrl: 'https://www.acmepay.io/pricing',
  productService: 'Payout software',
  brandMentionStyle: '',
  forbiddenPhrases: ['game changer'],
};
const POST = { subreddit: 'gambling', title: 'Payout times?', body: 'Waiting three days for a withdrawal.' };
const GROWTH = { relevantSourceIds: [], mentionRecommendation: 'no', suggestedAngle: 'Pitch.', growthAngle: 'Explain why payouts stall.' };
const BRAND = { ...GROWTH, mentionRecommendation: 'soft', suggestedAngle: 'How Acme handles payouts.' };

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const room4 = (len) =>
  [9, 8, 7, 6].map((score, i) => makeComment({ commentId: `t1_${i}`, body: `I've ${words(len - 1)}`, score }));

// --- the room ---------------------------------------------------------------

test('a thread with enough comments is measured, and its length is copied', () => {
  const room = measureRoom(POST, room4(30), 'no');
  assert.equal(room.measured, true);
  assert.equal(room.medianWinnerWords, 30);
  assert.ok(room.min <= 30 && room.max >= 30);
  assert.match(room.lines[0], /run about 30 words/);
  assert.ok(room.lines.some((l) => /contractions/.test(l)));
});

test('six comments are a thread, even when only a few score above the median', () => {
  // Distinct scores: three sit above the median, which is under MIN_SAMPLE and
  // used to read as "too few to measure".
  const six = [12, 9, 7, 4, 2, 1].map((score, i) => makeComment({ commentId: `t1_${i}`, body: `I've ${words(19)}`, score }));
  const room = measureRoom(POST, six, 'no');
  assert.equal(room.measured, true);
  assert.equal(room.sampleSize, 6);
  assert.equal(room.medianWinnerWords, 20);
  // Three comments are still too few.
  assert.equal(measureRoom(POST, six.slice(0, 3), 'no').measured, false);
});

test('capitalisation and swearing are never copied from the thread', () => {
  const sweary = [9, 8, 7, 6].map((score, i) => makeComment({ commentId: `t1_${i}`, body: 'well shit that is damn slow', score }));
  const lines = measureRoom(POST, sweary, 'no').lines.join('\n');
  assert.ok(!/swear/i.test(lines));
  assert.ok(!/lowercase/i.test(lines));
});

test('a thin thread is sized from the post, not capped like a karma comment', () => {
  const empty = measureRoom(POST, [], 'no');
  assert.equal(empty.measured, false);
  assert.ok(empty.max > 13, 'the karma fallback would have capped this at 13 words');
  assert.match(empty.lines[0], /too quiet to measure/);
  // No style lines: three comments are one person's habits, not a room.
  assert.ok(!measureRoom(POST, room4(30).slice(0, 3), 'no').lines.some((l) => /contractions/.test(l)));

  const long = measureRoom({ title: 'A detailed question', body: words(400) }, [], 'no');
  assert.ok(long.target > empty.target, 'a detailed post earns a longer reply');
  assert.ok(long.max <= REPLY_MAX_WORDS);
});

test('a brand reply gets room for the mention in a one-liner thread', () => {
  const growth = measureRoom(POST, room4(6), 'no');
  const brand = measureRoom(POST, room4(6), 'soft');
  assert.ok(growth.max < BRAND_ROOM_WORDS);
  assert.equal(brand.max, BRAND_ROOM_WORDS);
});

test('an essay thread is still capped', () => {
  assert.equal(measureRoom(POST, room4(400), 'no').max, REPLY_MAX_WORDS);
});

// --- the angle ----------------------------------------------------------------

test('a growth reply is written to the growth angle, a brand reply to the suggested one', () => {
  assert.equal(analysisAngle(GROWTH), 'Explain why payouts stall.');
  assert.equal(analysisAngle(BRAND), 'How Acme handles payouts.');
});

test('an unusable refinement keeps the analysis angle', () => {
  for (const raw of [null, 'nonsense', {}, { refinedAngle: '   ' }]) {
    const r = parseRefinement(raw, 'Original.');
    assert.equal(r.angle, 'Original.');
    assert.equal(r.changed, false);
  }
});

test('a refinement that changes the angle carries its reason', () => {
  const r = parseRefinement(
    { posterWant: 'information', delivered: 'Guesses.', refinedAngle: 'Sharper.', changed: true, note: 'Top comment is vague.' },
    'Original.',
  );
  assert.deepEqual([r.angle, r.changed, r.note, r.posterWant], ['Sharper.', true, 'Top comment is vague.', 'information']);
  // "changed: false" wins over a different string: the model said it kept it.
  assert.equal(parseRefinement({ refinedAngle: 'Other.', changed: false }, 'Original.').angle, 'Original.');
});

test('the refine prompt may not move the mention or pick a style', () => {
  const { system, user } = buildRefinePrompt(PROJECT, [], POST, room4(10), GROWTH);
  assert.match(system, /STAY ON THE TOPIC/);
  assert.match(system, /NOT a reason to drop it/);
  assert.match(system, /not yours to change/);
  assert.match(system, /Never suggest a tone, a length or a format/);
  assert.match(user, /ORIGINAL ANGLE: Explain why payouts stall\./);
});

// --- the write prompt -------------------------------------------------------

test('the write prompt carries the comments, the refined angle and the room', () => {
  const comments = room4(20);
  const room = measureRoom(POST, comments, 'no');
  const refinement = parseRefinement({ refinedAngle: 'Sharper.', changed: true }, 'Original.');
  const { system, user } = buildReplyPrompt(PROJECT, [], POST, comments, GROWTH, refinement, room);
  assert.match(user, /COMMENTS ALREADY POSTED/);
  assert.match(user, /THE ANGLE: Sharper\./);
  assert.match(user, new RegExp(`between ${room.min} and ${room.max} words`));
  assert.match(user, /Mention recommendation: no/);
  // The fixed 80–200 words is gone; length now comes from the thread.
  assert.ok(!/80–200/.test(system));
  assert.ok(system.trimEnd().endsWith('no markdown fence.'), 'the output format is the last thing read');
});

// --- the rules, in code -------------------------------------------------------

test('the company is recognised by name, squashed name, host and host label', () => {
  const terms = companyTerms(PROJECT);
  for (const t of ['Acme Pay', 'AcmePay', 'acmepay.io', 'acmepay']) assert.ok(terms.includes(t), t);
  assert.ok(namesCompany('I switched to acme pay last year.', terms));
  assert.ok(namesCompany('See AcmePay.io for it', terms));
  assert.ok(!namesCompany('Paying on time is the acme of good service.', terms));
  // A short host label is a word, not a name.
  assert.deepEqual(companyTerms({ name: 'Go', websiteUrl: 'https://go.io' }), ['Go', 'go.io']);
});

test('naming the company in a growth reply is a hard failure', () => {
  const room = measureRoom(POST, [], 'no');
  const bad = checkReply(`Acme Pay sorts this out. ${words(40)}`, { mention: 'no', project: PROJECT, room });
  assert.match(bad.hard.join(), /must not mention/);
  const ok = checkReply(`Payouts stall on verification. ${words(40)}`, { mention: 'no', project: PROJECT, room });
  assert.deepEqual(ok.hard, []);
});

test('claiming to work for the company is a hard failure, at every mention level', () => {
  const terms = companyTerms({ name: 'Stake', websiteUrl: 'https://stake.com' });
  // Every one of these came out of the first live drafts.
  for (const lie of [
    'Worth a look if you want it automated (disclosure: I work with Stake).',
    'I work with Stake, and support can pull up your exact eligibility.',
    "Since I'm on Stake's side, I'd suggest checking the current promo page.",
    "I'm replying on behalf of Stake. 75 bonuses ending the same way is frustrating.",
    'Feels rigged, but each spin is independent. I work with Stake. Every round is verifiable.',
    'Stake here. The streak you are describing sounds brutal.',
    'We at Stake publish the seeds.',
  ]) {
    assert.ok(claimsAffiliation(lie, terms), lie);
  }
  // How an outsider names a company, and all of it must keep passing.
  for (const fine of [
    "Stake's provably fair system lets you pull the seeds and nonce for that round.",
    "Slot-specific odds aren't something Stake discloses, those come from the provider.",
    'Stake has that built into its responsible gambling settings, worth a look.',
    'Since you are on r/Stake, the most accurate way to check is through support chat.',
    'I work with spreadsheets all day and tracking every bet is the only thing that helped.',
  ]) {
    assert.ok(!claimsAffiliation(fine, terms), fine);
  }

  const project = { ...PROJECT, name: 'Stake', websiteUrl: 'https://stake.com' };
  const room = measureRoom(POST, [], 'yes');
  for (const mention of ['yes', 'soft', 'no']) {
    const c = checkReply(`I work with Stake. ${words(40)}`, { mention, project, room });
    assert.match(c.hard.join(), /claims a connection/);
  }
});

test('the write prompt forbids claiming a connection to the company', () => {
  const { system } = buildReplyPrompt(PROJECT, [], POST, [], BRAND, parseRefinement(null, 'A.'), measureRoom(POST, [], 'soft'));
  assert.match(system, /NEVER claim or imply a connection to the company/);
  assert.match(system, /NOT from the company/);
});

test('a forbidden phrase is a hard failure; length and links are only flagged', () => {
  const room = measureRoom(POST, [], 'soft');
  const c = { mention: 'soft', project: PROJECT, room };
  assert.match(checkReply(`A real Game Changer. ${words(40)}`, c).hard.join(), /forbidden phrase/);
  const short = checkReply('Too short.', c);
  assert.deepEqual(short.hard, []);
  assert.match(short.soft.join(), /this thread calls for/);
  assert.match(checkReply(`See https://example.com ${words(40)}`, c).soft.join(), /link/);
  assert.match(checkReply(words(40), { ...c, mention: 'yes' }).soft.join(), /does not name the company/);
});

// --- the thread itself --------------------------------------------------------

test('a locked, archived or removed post is refused', () => {
  assert.equal(threadRefusal(makeThread(makePost())), null);
  assert.match(threadRefusal(makeThread(makePost({ isLocked: true }))), /locked/);
  assert.match(threadRefusal(makeThread(makePost({ isArchived: true }))), /archived/);
  assert.match(threadRefusal(makeThread(makePost({ isRemoved: true }))), /removed/);
});

test('JSON is found inside a fence or a sentence', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(parseJsonLoose('no object here'), null);
});

// --- end to end ---------------------------------------------------------------

const good = (n) => `Payouts usually stall on identity checks. ${words(n)}`;

/** A model that answers each step by recognising its system prompt. */
function fakeModel({ refine, candidates, pick }) {
  const calls = [];
  return {
    calls,
    ask: async ({ system, user }) => {
      if (system.startsWith('You prepare a Reddit reply')) {
        calls.push('refine');
        return refine;
      }
      if (system.startsWith('You write Reddit replies')) {
        calls.push('write');
        return { candidates };
      }
      calls.push('pick');
      assert.match(user, /CANDIDATES:/);
      return pick;
    },
  };
}

const input = (over = {}) => ({
  project: PROJECT,
  sources: [],
  post: POST,
  analysis: GROWTH,
  instructions: [],
  thread: makeThread(makePost(), room4(40)),
  ...over,
});

test('the pipeline refines, writes, checks and picks', async () => {
  const model = fakeModel({
    refine: { posterWant: 'information', delivered: 'Guesses.', refinedAngle: 'Name the identity check.', changed: true, note: 'Nobody has.' },
    candidates: [good(30), `Acme Pay fixes it. ${words(30)}`, good(45)],
    pick: { chosen: 2, reason: 'Fits the thread.' },
  });
  const out = await draftProjectReply(model, input());

  assert.deepEqual(model.calls, ['refine', 'write', 'pick']);
  assert.equal(out.body, good(45));
  assert.deepEqual(out.alternates, [good(30)]);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reasons.join(), /must not mention/);
  assert.deepEqual(out.angle, { original: 'Explain why payouts stall.', refined: 'Name the identity check.', changed: true, note: 'Nobody has.' });
  assert.equal(out.commentsSeen, 4);
  assert.equal(out.threadRead, true);
  assert.equal(out.pickReason, 'Fits the thread.');
});

test('every attempt naming the client fails the draft instead of shipping one', async () => {
  const model = fakeModel({ refine: {}, candidates: [`Try Acme Pay. ${words(30)}`, `acmepay.io does this. ${words(30)}`], pick: { chosen: 1, reason: 'x' } });
  await assert.rejects(draftProjectReply(model, input()), (err) => {
    assert.ok(err instanceof ReplyPipelineError);
    assert.match(err.message, /must not mention/);
    return true;
  });
  assert.ok(!model.calls.includes('pick'));
});

test('an unusable pick falls back to the cleanest attempt', async () => {
  // The first attempt is far outside the band; the second is inside it.
  const model = fakeModel({ refine: {}, candidates: ['Too short.', good(40)], pick: { chosen: 9, reason: 'x' } });
  const out = await draftProjectReply(model, input());
  assert.equal(out.body, good(40));
  assert.deepEqual(out.flags, []);
  assert.equal(out.pickReason, '');
});

test('with no comments the angle is not sent for refinement', async () => {
  const model = fakeModel({ refine: { refinedAngle: 'Should not be used.', changed: true }, candidates: [good(40)], pick: null });
  const out = await draftProjectReply(model, input({ thread: makeThread(makePost(), []) }));
  // One survivor: nothing to pick between either.
  assert.deepEqual(model.calls, ['write']);
  assert.equal(out.angle.changed, false);
  assert.equal(out.angle.refined, 'Explain why payouts stall.');
});

test('a thread that could not be read still gets a reply, and says so', async () => {
  const model = fakeModel({ refine: {}, candidates: [good(40)], pick: null });
  const out = await draftProjectReply(model, input({ thread: null }));
  assert.equal(out.threadRead, false);
  assert.equal(out.room.measured, false);
});

test('no usable attempt at all fails the draft', async () => {
  const model = fakeModel({ refine: {}, candidates: [], pick: null });
  await assert.rejects(draftProjectReply(model, input()), ReplyPipelineError);
});

test('the pick prompt numbers from one and states the mention level', () => {
  const comments = room4(20);
  const { user, system } = buildPickPrompt(
    [{ text: 'A', words: 1 }, { text: 'B', words: 1 }],
    POST,
    comments,
    'no',
    parseRefinement(null, 'Angle.'),
    measureRoom(POST, comments, 'no'),
  );
  assert.match(user, /\(1\) \[1 words\]\nA/);
  assert.match(user, /COMPANY MENTION LEVEL: no/);
  assert.match(system, /you must choose one/);
});
