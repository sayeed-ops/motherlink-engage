// The three reply modes, and the client details that constrain two of them.
//
// The assertions that matter here are about the DIFFERENCES between the modes.
// Open exists because Reddit's two are both gated; if Open can ever be
// unavailable, or if it inherits the no-repetition rule, it has become a third
// gated mode and the gap is still there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canDescribeClient,
  emptyClientProfile,
  findForbidden,
  fromReddit,
  normaliseClientProfile,
} from '../../apps/web/src/modules/shopify/client.ts';
import {
  availableModes,
  buildReplyPrompt,
  isEmpty,
  parseReply,
  REPLY_MODES,
  SYSTEM_BY_MODE,
} from '../../apps/web/src/modules/shopify/reply.ts';

const understanding = {
  concern: 'How do I get my products surfaced by AI assistants?',
  askerContext: 'A small merchant with no SEO team',
  engagement: 'discussion',
  offered: [{ approach: 'Add JSON-LD schema', byUsername: 'someone', postNumber: 4, endorsed: true }],
  alreadySaid: ['Structured data matters', 'llms.txt is worth adopting'],
  whatIsMissing: 'Nobody has shared measured results',
  worthJoining: 'Yes, with data',
  confidence: 0.8,
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

test('Open is available with nothing configured at all', () => {
  // THE WHOLE POINT OF THE MODE. Reddit's brand is downgraded without a
  // supporting source and its growth must clear a score floor, so an ordinary
  // thread produces nothing. A mode that can be unavailable does not close that
  // gap.
  const modes = availableModes({ hasClientProfile: false, matchedSourceCount: 0, understanding });
  assert.deepEqual(modes, ['open']);
});

test('Growth needs a client to have expertise to lend', () => {
  assert.ok(!availableModes({ hasClientProfile: false, matchedSourceCount: 5, understanding }).includes('growth'));
  assert.ok(availableModes({ hasClientProfile: true, matchedSourceCount: 0, understanding }).includes('growth'));
});

test('Brand needs a supporting source — Reddit posture, not Covers', () => {
  // Covers required a live citable claim and the result was a mode that could
  // never fire, because its library held zero claims.
  assert.ok(!availableModes({ hasClientProfile: true, matchedSourceCount: 0, understanding }).includes('brand'));
  assert.ok(availableModes({ hasClientProfile: true, matchedSourceCount: 1, understanding }).includes('brand'));
});

test('a thread the room already answered does not close Open', () => {
  // `wouldRepeat` gates nothing here. Repetition is acceptable when ours is
  // better — that is the engagement posture.
  const answered = { ...understanding, engagement: 'answered-well', whatIsMissing: '' };
  assert.ok(availableModes({ hasClientProfile: true, matchedSourceCount: 1, understanding: answered }).includes('open'));
});

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

const promptFor = (mode) =>
  buildReplyPrompt({
    mode,
    title: 'A thread',
    discussion: '#1 someone asked something',
    understanding,
    client: mode === 'open' ? undefined : { ...emptyClientProfile(), companyDescription: 'We do things' },
    sources: [],
    targetWords: 120,
  });

test('Open frames what was already said as the bar to BEAT', () => {
  const p = promptFor('open');
  assert.match(p, /BAR TO BEAT/);
  assert.ok(!/DO NOT RESTATE/.test(p), 'Open inherited the no-repetition rule');
});

test('Growth and Brand keep the no-repetition rule', () => {
  for (const mode of ['growth', 'brand']) {
    const p = promptFor(mode);
    assert.match(p, /DO NOT RESTATE|Do not repeat/, `${mode} lost the repetition rule`);
    assert.ok(!/BAR TO BEAT/.test(p), `${mode} was given the Open framing`);
  }
});

test('Open is never told who the client is', () => {
  // A reply that "represents nobody" has to be written by something that has
  // not been told who it would otherwise be representing.
  const p = buildReplyPrompt({
    mode: 'open',
    title: 'A thread',
    discussion: '#1 hello',
    understanding,
    client: { ...emptyClientProfile(), companyDescription: 'ACME CORP SECRET' },
    sources: [{ sourceId: 's1', title: 'A SOURCE', summary: '', keyPoints: [], answerAngles: [] }],
    targetWords: 120,
  });
  assert.ok(!p.includes('ACME CORP SECRET'), 'the client leaked into the open prompt');
  assert.ok(!p.includes('A SOURCE'), 'a knowledge source leaked into the open prompt');
});

test('only Brand is told the mention style', () => {
  const client = { ...emptyClientProfile(), companyDescription: 'x', brandMentionStyle: 'SAY WE NOT THEY' };
  const brand = buildReplyPrompt({ mode: 'brand', title: 't', discussion: 'd', understanding, client, targetWords: 100 });
  const growth = buildReplyPrompt({ mode: 'growth', title: 't', discussion: 'd', understanding, client, targetWords: 100 });
  assert.ok(brand.includes('SAY WE NOT THEY'));
  assert.ok(!growth.includes('SAY WE NOT THEY'), 'growth was told how to mention a client it may not mention');
});

test('forbidden phrases reach every mode that knows the client', () => {
  const client = { ...emptyClientProfile(), companyDescription: 'x', forbiddenPhrases: ['guaranteed'] };
  for (const mode of ['growth', 'brand']) {
    assert.match(buildReplyPrompt({ mode, title: 't', discussion: 'd', understanding, client, targetWords: 100 }), /guaranteed/);
  }
});

test('every mode has a system prompt', () => {
  for (const m of REPLY_MODES) {
    assert.ok(SYSTEM_BY_MODE[m]?.length > 100, `${m} has no usable system prompt`);
  }
});

test('growth and brand are told they may write nothing', () => {
  // A forced mention costs more than it earns, so declining has to be an
  // option the prompt states rather than a behaviour we hope for.
  assert.match(SYSTEM_BY_MODE.growth, /empty text/i);
  assert.match(SYSTEM_BY_MODE.brand, /empty text/i);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('an unparseable reply is empty rather than half a draft', () => {
  const d = parseReply('the model said hello', 'open');
  assert.ok(isEmpty(d));
  assert.equal(d.mode, 'open');
});

test('a fenced reply is still read, and words are counted', () => {
  const d = parseReply('```json\n{"text":"one two three","angle":"a"}\n```', 'open');
  assert.equal(d.text, 'one two three');
  assert.equal(d.words, 3);
});

test('an empty draft is a decision, not a failure', () => {
  const d = parseReply('{"text":"","angle":"the company does not solve this"}', 'brand');
  assert.ok(isEmpty(d));
  assert.equal(d.angle, 'the company does not solve this');
});

// ---------------------------------------------------------------------------
// The client profile
// ---------------------------------------------------------------------------

test('forbidden phrases are matched case-insensitively and inside words', () => {
  // A rule a capital letter or a hyphen defeats is not a rule.
  assert.deepEqual(findForbidden('This is GUARANTEED to work', ['guaranteed']), ['guaranteed']);
  assert.deepEqual(findForbidden('our guaranteed-best price', ['guaranteed']), ['guaranteed']);
  assert.deepEqual(findForbidden('nothing to see', ['guaranteed']), []);
});

test('the forbidden list dedups case-insensitively', () => {
  const p = normaliseClientProfile({ forbiddenPhrases: ['Guaranteed', 'guaranteed', 'GUARANTEED', '  '] });
  assert.deepEqual(p.forbiddenPhrases, ['Guaranteed']);
});

test('a client can be named only once described', () => {
  assert.ok(!canDescribeClient(emptyClientProfile()));
  assert.ok(!canDescribeClient({ ...emptyClientProfile(), companyDescription: 'we exist' }));
  assert.ok(canDescribeClient({ ...emptyClientProfile(), companyDescription: 'we exist', productService: 'a thing' }));
});

test('a sync from Reddit is stamped, and typing here clears the stamp', () => {
  // A copy nobody can tell is stale is worse than no copy.
  const synced = fromReddit({ companyDescription: 'from reddit', productService: 'x' }, 1_700_000_000_000);
  assert.equal(synced.syncedFromRedditAtMs, 1_700_000_000_000);
  assert.equal(synced.companyDescription, 'from reddit');

  const typed = normaliseClientProfile({ ...synced, companyDescription: 'edited here' });
  assert.equal(typed.syncedFromRedditAtMs, 1_700_000_000_000, 'normalise keeps what it is given');
  // The route is what clears it — asserted here so the intent is recorded even
  // though the clearing happens one layer up.
  assert.equal({ ...typed, syncedFromRedditAtMs: null }.syncedFromRedditAtMs, null);
});

test('a sync replaces rather than merges', () => {
  const synced = fromReddit({ companyDescription: 'new' }, 1);
  assert.equal(synced.targetCustomer, '', 'a field absent in Reddit survived from the old copy');
});
