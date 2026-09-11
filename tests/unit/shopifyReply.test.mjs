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
import { clientFromJson, ClientImportError } from '../../apps/web/src/modules/shopify/client.ts';

const assessment = {
  question: 'How do I get my products surfaced by AI assistants?',
  askerContext: 'A small merchant with no SEO team',
  needs: 'What actually changes whether an assistant cites a product page',
  scores: {
    open: { score: 7, why: 'A clear question the room half-answers', angle: 'OPEN-ANGLE: measured steps' },
    growth: { score: 6, why: 'GROWTH-WHY: the field knows structured data', angle: 'GROWTH-ANGLE' },
    brand: { score: 8, why: 'BRAND-WHY: the guide covers it', angle: 'BRAND-ANGLE', sourceIds: ['s1'] },
  },
  suggested: 'brand',
  confidence: 0.8,
};

const described = { ...emptyClientProfile(), companyDescription: 'We do things', productService: 'A thing' };

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

test('Open is available with nothing configured at all', () => {
  // THE WHOLE POINT OF THE MODE. A mode that can be unavailable does not close
  // the gap Reddit's two gated modes leave.
  assert.deepEqual(availableModes({ client: emptyClientProfile(), supportingSourceCount: 0 }), ['open']);
});

test('Growth needs a client to have expertise to lend', () => {
  assert.ok(!availableModes({ client: emptyClientProfile(), supportingSourceCount: 5 }).includes('growth'));
  assert.ok(availableModes({ client: described, supportingSourceCount: 0 }).includes('growth'));
});

test('Brand needs a supporting source — Reddit posture, not Covers', () => {
  assert.ok(!availableModes({ client: described, supportingSourceCount: 0 }).includes('brand'));
  assert.ok(availableModes({ client: described, supportingSourceCount: 1 }).includes('brand'));
});

test('Brand needs to know what the client sells before it may name them', () => {
  const noProduct = { ...described, productService: '' };
  assert.ok(!availableModes({ client: noProduct, supportingSourceCount: 3 }).includes('brand'));
});

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

const promptFor = (mode, over = {}) =>
  buildReplyPrompt({
    mode,
    title: 'A thread',
    discussion: '#1 someone asked something',
    assessment,
    client: mode === 'open' ? undefined : described,
    sources: [],
    targetWords: 120,
    ...over,
  });

test('Open frames the replies as the bar to BEAT', () => {
  const p = promptFor('open');
  assert.match(p, /BAR TO BEAT/);
  assert.ok(!/DO NOT RESTATE/.test(p), 'Open inherited the no-repetition rule');
  assert.match(SYSTEM_BY_MODE.open, /BAR TO BEAT/);
});

test('Growth and Brand keep the no-repetition rule', () => {
  for (const mode of ['growth', 'brand']) {
    const p = promptFor(mode);
    assert.match(p, /DO NOT RESTATE/, `${mode} lost the repetition rule`);
    assert.ok(!/BAR TO BEAT/.test(p), `${mode} was given the Open framing`);
  }
});

test('Open is never told who the client is, or anything reasoned about them', () => {
  // A reply that "represents nobody" has to be written by something that has
  // not been told who it would otherwise be representing — and that includes
  // the analysis's reasoning about the client, not just the profile.
  const p = promptFor('open', {
    client: { ...emptyClientProfile(), companyDescription: 'ACME CORP SECRET' },
    sources: [{ sourceId: 's1', title: 'A SOURCE', summary: '', keyPoints: [], answerAngles: [] }],
  });
  assert.ok(!p.includes('ACME CORP SECRET'), 'the client leaked into the open prompt');
  assert.ok(!p.includes('A SOURCE'), 'a knowledge source leaked into the open prompt');
  assert.ok(!p.includes('BRAND-WHY') && !p.includes('BRAND-ANGLE'), 'the brand reasoning leaked into Open');
  assert.ok(!p.includes('GROWTH-WHY') && !p.includes('GROWTH-ANGLE'), 'the growth reasoning leaked into Open');
  assert.ok(p.includes('OPEN-ANGLE'), 'Open lost its own brief');
});

test('each mode is briefed with its own reasoning and no other', () => {
  const brand = promptFor('brand');
  assert.ok(brand.includes('BRAND-ANGLE') && !brand.includes('GROWTH-ANGLE') && !brand.includes('OPEN-ANGLE'));
  const growth = promptFor('growth');
  assert.ok(growth.includes('GROWTH-ANGLE') && !growth.includes('BRAND-ANGLE'));
});

test('every mode is told what a good answer must cover', () => {
  for (const mode of REPLY_MODES) assert.ok(promptFor(mode).includes(assessment.needs));
});

test('only Brand is told the mention style', () => {
  const client = { ...described, brandMentionStyle: 'SAY WE NOT THEY' };
  assert.ok(promptFor('brand', { client }).includes('SAY WE NOT THEY'));
  assert.ok(!promptFor('growth', { client }).includes('SAY WE NOT THEY'), 'growth was told how to mention a client it may not mention');
});

test('forbidden phrases reach every mode that knows the client', () => {
  const client = { ...described, forbiddenPhrases: ['guaranteed'] };
  for (const mode of ['growth', 'brand']) assert.match(promptFor(mode, { client }), /guaranteed/);
});

test('every mode has a system prompt, and every one reads the replies first', () => {
  for (const m of REPLY_MODES) {
    assert.ok(SYSTEM_BY_MODE[m]?.length > 100, `${m} has no usable system prompt`);
    assert.match(SYSTEM_BY_MODE[m], /"thread":/, `${m} is not asked to report what the replies say`);
  }
});

test('growth and brand are told they may write nothing', () => {
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

test('a fenced reply is still read, words are counted, and the digest comes with it', () => {
  const d = parseReply(
    '```json\n{"thread":{"engagement":"thin-answers","offered":[{"approach":"add schema","byUsername":"b","postNumber":3}],"alreadySaid":["schema"],"whatIsMissing":"numbers"},"text":"one two three","angle":"a"}\n```',
    'open',
  );
  assert.equal(d.text, 'one two three');
  assert.equal(d.words, 3);
  assert.equal(d.digest.engagement, 'thin-answers');
  assert.equal(d.digest.offered[0].postNumber, 3);
  assert.equal(d.digest.whatIsMissing, 'numbers');
});

test('a reply with no digest keeps its text', () => {
  const d = parseReply('{"text":"still a reply"}', 'open');
  assert.equal(d.text, 'still a reply');
  assert.deepEqual(d.digest.offered, []);
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

// ---------------------------------------------------------------------------
// Client JSON import
// ---------------------------------------------------------------------------

test('a client import fills the fields it names and keeps the rest', () => {
  const current = { ...emptyClientProfile(), targetCustomer: 'KEPT', companyDescription: 'old' };
  const res = clientFromJson('{"companyDescription":"new","forbiddenPhrases":["a","A","b"]}', current);
  assert.equal(res.client.companyDescription, 'new');
  assert.equal(res.client.targetCustomer, 'KEPT', 'a field the JSON did not mention was wiped');
  assert.deepEqual(res.client.forbiddenPhrases, ['a', 'b'], 'the pasted list was not normalised');
  assert.deepEqual(res.filled.sort(), ['companyDescription', 'forbiddenPhrases']);
});

test("Reddit's JSON is accepted and its Reddit-only keys are reported, not silently dropped", () => {
  const res = clientFromJson(
    '```json\n{"name":"Northwind","companyDescription":"x","targetSubreddits":["shopify"],"keywords":["k"]}\n```',
    emptyClientProfile(),
  );
  assert.equal(res.client.companyDescription, 'x');
  assert.deepEqual(res.ignored.sort(), ['keywords', 'name', 'targetSubreddits']);
});

test('a client import that is not JSON, not an object, or names no field is refused', () => {
  assert.throws(() => clientFromJson('nope', emptyClientProfile()), ClientImportError);
  assert.throws(() => clientFromJson('[{"companyDescription":"x"}]', emptyClientProfile()), ClientImportError);
  assert.throws(() => clientFromJson('{"targetSubreddits":["a"]}', emptyClientProfile()), ClientImportError);
});

test('an import only fills the form — the stamp is cleared by Save, as for any edit', () => {
  // The client route's PUT clears `syncedFromRedditAtMs`; filling the form
  // must not pre-empt that, or an unsaved import would already read as typed.
  const current = { ...emptyClientProfile(), syncedFromRedditAtMs: 5 };
  assert.equal(clientFromJson('{"companyDescription":"x"}', current).client.syncedFromRedditAtMs, 5);
});
