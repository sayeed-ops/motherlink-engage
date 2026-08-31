// The gap-board domain filter.
//
// The assertions that matter most are the ones about what is KEPT. A filter that
// only proves it rejects the right things is half-tested: the expensive failure
// here is silently deleting a real unmet need because the library has no words
// for it — which is the definition of an unmet need.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDomainLexicon,
  ruleConcept,
  rulePost,
  OFF_DOMAIN_TOPIC_LABEL,
} from '../../apps/web/src/modules/covers/domain.ts';
import { buildGaps } from '../../apps/web/src/modules/covers/triage.ts';

const asset = (over = {}) => ({
  assetId: 'a1',
  projectId: 'p',
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'When cashout is and is not offered',
  problems: ['cashout disappeared', 'cannot cash out'],
  triggers: ['cash out', 'cashout', 'market suspended'],
  exclusions: [],
  sourceUrl: 'https://help.northwind.example/cashout',
  status: 'active',
  proposedBy: 'model',
  model: '',
  promptVersion: '',
  textSource: 'fetched',
  attestedBy: null,
  attestedByName: null,
  attestedAt: null,
  fetchFailure: null,
  sourceHash: '',
  lastCrawledAt: null,
  sourceChangedAt: null,
  confirmedBy: null,
  confirmedByName: null,
  confirmedAt: null,
  createdBy: 'u',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const lex = (over = {}) =>
  buildDomainLexicon({ assets: [asset()], sport: 'nfl', ...over });

// ---------------------------------------------------------------------------
// The three verdicts
// ---------------------------------------------------------------------------

test('the client library is the primary definition of the domain', () => {
  const r = ruleConcept('cash out', lex());
  assert.equal(r.verdict, 'in-domain');
  assert.equal(r.evidence, 'library');
  assert.ok(r.matched.includes('cash out'));
});

test('the vertical lexicon keeps a concept the library has never heard of', () => {
  // The row a gap board exists to surface: real betting demand, no asset.
  const r = ruleConcept('same game parlay', lex());
  assert.equal(r.verdict, 'in-domain');
  assert.equal(r.evidence, 'vertical');
});

test("a team in this section's sport is in domain", () => {
  const r = ruleConcept('seahawks', lex());
  assert.equal(r.verdict, 'in-domain');
  assert.equal(r.evidence, 'sport');
});

test('a league with no lexicon yields no team evidence, and says so', () => {
  const soccer = buildDomainLexicon({ assets: [asset()], sport: 'soccer' });
  assert.equal(soccer.sportKnown, false);
  assert.equal(ruleConcept('arsenal', soccer).verdict, 'unclassified');
});

test('an explicit off-domain topic is rejected, with the term recorded', () => {
  const r = ruleConcept('healthcare system', lex());
  assert.equal(r.verdict, 'off-domain');
  assert.equal(r.topic, 'healthcare');
  assert.ok(r.matched.includes('healthcare'));
  assert.ok(r.reason.includes(OFF_DOMAIN_TOPIC_LABEL.healthcare));
});

test('an unrecognised concept is KEPT as unclassified, never dropped', () => {
  // The whole point. Nobody has an asset about this and nobody has a word for
  // it either — which is exactly what unmet demand looks like from outside.
  const r = ruleConcept('stadium parking shuttle', lex({ assets: [] }));
  assert.notEqual(r.verdict, 'off-domain');
  assert.ok(r.reason.length > 0);
});

// ---------------------------------------------------------------------------
// Strong vs weak evidence
// ---------------------------------------------------------------------------

test('one ordinary English word alone does not classify anything', () => {
  // "book" is a sportsbook and also a thing you read. On its own it stays
  // unclassified, and the reason says which word was seen.
  const r = ruleConcept('book club', lex());
  assert.equal(r.verdict, 'unclassified');
  assert.deepEqual(r.matched, ['book']);
  assert.ok(r.reason.includes('book'));
});

test('two weak words together are evidence', () => {
  const r = ruleConcept('line movement odds', lex());
  assert.equal(r.verdict, 'in-domain');
});

test('an off-domain term outranks an accidental library token overlap', () => {
  // "system requirements" in the library must not rescue "healthcare system".
  const withSystem = lex({ assets: [asset({ triggers: ['system'], problems: [] })] });
  assert.equal(ruleConcept('healthcare system', withSystem).verdict, 'off-domain');
});

test('a bare place name is unclassified, not rejected', () => {
  // "is this available in Canada" is a real question about a licensed operator.
  const r = ruleConcept('canada', lex());
  assert.equal(r.verdict, 'unclassified');
});

test('gambling-harm vocabulary is not off-domain', () => {
  // Responsible-gambling material is exactly what a regulated client publishes.
  for (const c of ['self exclusion', 'deposit limit', 'responsible gambling']) {
    assert.equal(ruleConcept(c, lex()).verdict, 'in-domain', c);
  }
});

// ---------------------------------------------------------------------------
// The post decides its outliers
// ---------------------------------------------------------------------------

test('an off-domain post carries its abstract outliers with it', () => {
  // The live failure: `compassion` came out of a political argument.
  const rulings = rulePost(['healthcare system', 'compassion', 'the tone in here'], lex());
  const byConcept = Object.fromEntries(rulings.map((r) => [r.concept, r]));

  assert.equal(byConcept['the tone in here'].verdict, 'off-domain');
  assert.equal(byConcept['the tone in here'].evidence, 'post-topic');
  // And it records which sibling decided it, so the call can be argued with.
  assert.ok(byConcept['the tone in here'].reason.includes('healthcare system'));
});

test('one in-domain concept protects the rest of the post from the sweep', () => {
  const rulings = rulePost(['election', 'moneyline', 'weird thing'], lex());
  const byConcept = Object.fromEntries(rulings.map((r) => [r.concept, r]));

  assert.equal(byConcept.moneyline.verdict, 'in-domain');
  // Unclassified stays unclassified — an in-domain sibling never PROMOTES.
  assert.equal(byConcept['weird thing'].verdict, 'unclassified');
});

test('an in-domain sibling never promotes an unclassified concept', () => {
  const rulings = rulePost(['parlay', 'zzzqqq'], lex());
  assert.equal(rulings.find((r) => r.concept === 'zzzqqq').verdict, 'unclassified');
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const triaged = (over = {}) => ({
  postId: 'p1',
  itemId: 'i1',
  section: 'nfl-betting-21',
  outcome: 'no-asset-match',
  screenReasons: [],
  jurisdiction: { blocked: false, matched: [] },
  intent: {
    intent: 'question',
    problem: 'wants to know something',
    concepts: ['parlay'],
    asksSomething: true,
    confidence: 0.8,
  },
  retrieval: null,
  variants: { brandMentioned: false, brandInformed: false, communityOnly: true },
  eligibilityReasons: {},
  score: 0,
  measured: { postAgeMs: null, threadQuietMs: null, paceMs: null },
  ...over,
});

test('the board sorts into three trays and discards nothing', () => {
  const board = buildGaps(
    [
      triaged({ postId: 'a', intent: { ...triaged().intent, concepts: ['same game parlay'] } }),
      triaged({ postId: 'b', itemId: 'i2', intent: { ...triaged().intent, concepts: ['stadium parking shuttle'] } }),
      triaged({ postId: 'c', itemId: 'i3', intent: { ...triaged().intent, concepts: ['healthcare system'] } }),
    ],
    lex(),
  );

  assert.equal(board.gaps.length, 1);
  assert.equal(board.unclassified.length, 1);
  assert.equal(board.offDomain.length, 1);
  assert.deepEqual(board.counts, { inDomain: 1, unclassified: 1, offDomain: 1 });
});

test('every row on every tray carries the reason it is there', () => {
  const board = buildGaps(
    [triaged({ intent: { ...triaged().intent, concepts: ['healthcare system'] } })],
    lex(),
  );
  const row = board.offDomain[0];
  assert.ok(row.domain.reason.length > 0);
  assert.ok(row.domain.matched.length > 0);
  assert.equal(row.domain.topic, 'healthcare');
});

test('unclassified rows record the in-domain concepts they were seen with', () => {
  const board = buildGaps(
    [triaged({ intent: { ...triaged().intent, concepts: ['moneyline', 'novelty market thing'] } })],
    lex(),
  );
  const row = board.unclassified.find((g) => g.concept === 'novelty market thing');
  assert.ok(row, 'the unclassified concept is on the board');
  assert.deepEqual(row.seenWith, ['moneyline']);
});

test('the counts are over every row, not over the capped trays', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    triaged({
      postId: `p${i}`,
      itemId: `i${i}`,
      intent: { ...triaged().intent, concepts: [`unknown thing ${i}`] },
    }),
  );
  const board = buildGaps(many, lex(), 5);
  assert.equal(board.unclassified.length, 5);
  assert.equal(board.counts.unclassified, 30);
});

test('the gap rules from phase 3 still hold: demand only, and no pick-sharing', () => {
  const board = buildGaps(
    [
      triaged({ intent: { ...triaged().intent, asksSomething: false } }),
      triaged({ postId: 'x', intent: { ...triaged().intent, intent: 'pick-sharing' } }),
      triaged({ postId: 'y', outcome: 'opportunity' }),
    ],
    lex(),
  );
  assert.deepEqual(board.counts, { inDomain: 0, unclassified: 0, offDomain: 0 });
});

test('a post sweep does not permanently condemn a concept seen elsewhere', () => {
  // `limits` is swept off-domain by the political post it appears in, and is
  // merely unclassified in the betting one. The kinder ruling wins, because a
  // sweep is one post's opinion about its own outlier rather than a fact about
  // the word.
  const board = buildGaps(
    [
      triaged({ postId: 'a', intent: { ...triaged().intent, concepts: ['healthcare system', 'limits'] } }),
      triaged({
        postId: 'b',
        itemId: 'i2',
        intent: { ...triaged().intent, concepts: ['account limited', 'limits'] },
      }),
    ],
    lex(),
  );

  assert.ok(board.unclassified.some((g) => g.concept === 'limits'), 'not left on the reject tray');
  assert.ok(!board.offDomain.some((g) => g.concept === 'limits'));
  // And the concept that IS betting language is on the primary tray.
  assert.ok(board.gaps.some((g) => g.concept === 'account limited'));
});
