// Writing the variants, and scoring them.
//
// The assertions that matter most are about what does NOT reach a prompt: an
// ineligible variant, and — for community-only — the client's library. A test
// that only checks the happy parse would pass just as well against a generator
// that quietly writes all three every time and hides two.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBrandPrompt,
  buildCommunityPrompt,
  eligibleKinds,
  isLibraryBacked,
  parseVariants,
  VARIANT_FLAG,
  VARIANT_KINDS,
} from '../../apps/web/src/modules/covers/variants.ts';
import {
  belowFloor,
  buildScorePrompt,
  DEFAULT_FLOORS,
  DIMENSIONS,
  isInverted,
  normaliseFloors,
  overallOf,
  parseAssessments,
} from '../../apps/web/src/modules/covers/score.ts';
import { profileSection, targetLength, renderRegister } from '../../apps/web/src/modules/covers/register.ts';

const asset = (over = {}) => ({
  assetId: 'a1',
  projectId: 'p',
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'When cashout is offered and when it disappears',
  problems: ['cashout disappeared mid-game'],
  triggers: ['cash out', 'cashout'],
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

const CLAIM = {
  claimId: 'c1',
  text: 'Cashout is withdrawn while a market is suspended and returns when it reopens.',
  sourceUrl: 'https://help.northwind.example/cashout',
  assetId: 'a1',
  assetTitle: 'Cashout availability',
};

const POSTS = [
  { body: 'anyone know why cash out vanished on my ticket last night, was there the whole first half' },
  { body: "happens to me all the time, no idea why it goes away" },
  { body: 'same here. thought it was just my connection' },
  { body: 'i had it on a live bet and it just went' },
  { body: 'annoying when it happens on a big one' },
  { body: 'yeah it usually comes back after a bit' },
];

const REGISTER = profileSection(POSTS);
const LENGTH = targetLength(REGISTER);

const promptInput = (over = {}) => ({
  sectionName: 'NFL Betting',
  threadTitle: 'cash out disappearing mid game',
  postBody: 'why does cash out vanish during a game and then come back',
  context: [],
  problem: 'Wants to know why the cashout button disappears mid-game.',
  register: REGISTER,
  length: LENGTH,
  assets: [asset()],
  claims: [CLAIM],
  brandNames: ['Northwind'],
  linksPermitted: false,
  ...over,
});

// ---------------------------------------------------------------------------
// Eligibility decides what is written
// ---------------------------------------------------------------------------

test('only eligible kinds are asked for', () => {
  const kinds = eligibleKinds({ brandMentioned: false, brandInformed: true, communityOnly: true });
  assert.deepEqual(kinds, ['brand-informed', 'community-only']);
});

test('the flag mapping covers every kind', () => {
  for (const k of VARIANT_KINDS) {
    assert.ok(VARIANT_FLAG[k], `${k} has an eligibility flag`);
  }
});

test('an ineligible variant never enters the prompt', () => {
  const { user } = buildBrandPrompt(['brand-informed'], promptInput());
  assert.ok(!user.includes('KIND "brand-mentioned"'));
  assert.ok(user.includes('KIND "brand-informed"'));
});

test('the brand prompt refuses to carry community-only', () => {
  // A programming error, not a recoverable input: putting community-only in a
  // prompt that carries the help centre is exactly the contamination the
  // two-call split exists to prevent.
  assert.throws(() => buildBrandPrompt(['community-only'], promptInput()));
  assert.throws(() => buildBrandPrompt(['brand-informed', 'community-only'], promptInput()));
});

// ---------------------------------------------------------------------------
// The community prompt knows nothing about the client
// ---------------------------------------------------------------------------

test('the community prompt contains no asset, no claim and no brand name', () => {
  const { system, user } = buildCommunityPrompt(promptInput());
  const all = `${system}\n${user}`;

  assert.ok(!all.includes('Northwind'), 'no brand name');
  assert.ok(!all.includes(CLAIM.text), 'no claim text');
  assert.ok(!all.includes('Cashout availability'), 'no asset title');
  assert.ok(!all.includes(CLAIM.claimId), 'no claim id');
});

test('the brand prompt DOES carry the claims, with their ids', () => {
  const { user } = buildBrandPrompt(['brand-mentioned'], promptInput());
  assert.ok(user.includes(CLAIM.claimId));
  assert.ok(user.includes(CLAIM.text));
});

test('no claims is stated out loud rather than left as an empty heading', () => {
  // A model shown a heading with nothing under it fills the gap. This is the
  // live project's actual situation — an imported library carries no claims.
  const { user } = buildBrandPrompt(['brand-mentioned'], promptInput({ claims: [] }));
  assert.ok(/NO verified facts/i.test(user));
});

test('every prompt states the honesty rule', () => {
  const brand = buildBrandPrompt(['brand-mentioned', 'brand-informed'], promptInput());
  const community = buildCommunityPrompt(promptInput());
  for (const p of [brand, community]) {
    assert.ok(/NEVER CLAIM FIRST-HAND EXPERIENCE/.test(p.system));
  }
});

test('link permission is stated, and is off unless the section permits it', () => {
  assert.ok(/LINKS: NOT permitted/.test(buildBrandPrompt(['brand-mentioned'], promptInput()).user));
  assert.ok(
    /LINKS: permitted/.test(
      buildBrandPrompt(['brand-mentioned'], promptInput({ linksPermitted: true })).user,
    ),
  );
});

test('isLibraryBacked splits the kinds the way the two calls do', () => {
  assert.equal(isLibraryBacked('brand-mentioned'), true);
  assert.equal(isLibraryBacked('brand-informed'), true);
  assert.equal(isLibraryBacked('community-only'), false);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a well-formed answer parses, with words counted and claims kept', () => {
  const out = parseVariants(
    {
      variants: [
        { kind: 'brand-mentioned', text: 'Markets suspend and cashout goes with them.', claimIds: ['c1'] },
      ],
    },
    ['brand-mentioned'],
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].words, 7);
  assert.deepEqual(out[0].claimIds, ['c1']);
});

test('a variant of a kind that was not asked for is DISCARDED, not relabelled', () => {
  // It is the one thing the eligibility mask said may not be written here.
  // Keeping it under a different label would smuggle it past the mask.
  const out = parseVariants(
    {
      variants: [
        { kind: 'brand-mentioned', text: 'Northwind does this.', claimIds: [] },
        { kind: 'community-only', text: 'markets suspend, thats all it is', claimIds: [] },
      ],
    },
    ['community-only'],
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'community-only');
});

test('the same kind twice keeps the first and drops the rest', () => {
  const out = parseVariants(
    {
      variants: [
        { kind: 'community-only', text: 'first', claimIds: [] },
        { kind: 'community-only', text: 'second', claimIds: [] },
      ],
    },
    ['community-only'],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'first');
});

test('unreadable input yields an empty array rather than throwing', () => {
  for (const raw of [null, undefined, 'nonsense', 42, {}, { variants: 'no' }]) {
    assert.deepEqual(parseVariants(raw, ['community-only']), []);
  }
});

test('code fences and numbering are stripped off the text', () => {
  const out = parseVariants(
    { variants: [{ kind: 'community-only', text: '```\n1. markets suspend\n```', claimIds: [] }] },
    ['community-only'],
  );
  assert.equal(out[0].text, 'markets suspend');
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const scores = (over = {}) => ({
  suitability: 80,
  relevance: 80,
  naturalness: 75,
  brandFit: 70,
  risk: 20,
  factual: 85,
  ...over,
});

const assessment = (over = {}) => ({
  kind: 'community-only',
  ...scores(),
  recommendation: 'POST',
  why: 'Answers the question in the register of the room.',
  ...over,
});

test('a complete assessment parses', () => {
  const out = parseAssessments({ assessments: [assessment()] }, ['community-only']);
  assert.equal(out.length, 1);
  assert.equal(out[0].scores.factual, 85);
  assert.equal(out[0].recommendation, 'POST');
});

test('a MISSING dimension drops the assessment rather than defaulting to zero', () => {
  // A defaulted zero looks like a real failing score for a reply nobody judged,
  // and downstream cannot tell the two apart.
  const partial = assessment();
  delete partial.factual;
  assert.deepEqual(parseAssessments({ assessments: [partial] }, ['community-only']), []);
});

test('a judgement with no reason is not a judgement', () => {
  assert.deepEqual(
    parseAssessments({ assessments: [assessment({ why: '' })] }, ['community-only']),
    [],
  );
});

test('an unrecognised recommendation is refused, not coerced', () => {
  assert.deepEqual(
    parseAssessments({ assessments: [assessment({ recommendation: 'MAYBE' })] }, ['community-only']),
    [],
  );
});

test('scores are clamped into 0..100', () => {
  const out = parseAssessments(
    { assessments: [assessment({ suitability: 400, risk: -30 })] },
    ['community-only'],
  );
  assert.equal(out[0].scores.suitability, 100);
  assert.equal(out[0].scores.risk, 0);
});

// ---------------------------------------------------------------------------
// The floors
// ---------------------------------------------------------------------------

test('risk is the one inverted scale, and the floors treat it as a ceiling', () => {
  assert.equal(isInverted('risk'), true);
  for (const d of DIMENSIONS.filter((x) => x !== 'risk')) {
    assert.equal(isInverted(d), false, d);
  }

  // High risk fails even with everything else perfect.
  const failures = belowFloor(scores({ risk: 95 }), DEFAULT_FLOORS);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].dimension, 'risk');
  assert.ok(failures[0].detail.includes('lower is better'));
});

test('a clean set of scores clears the floors', () => {
  assert.deepEqual(belowFloor(scores(), DEFAULT_FLOORS), []);
});

test('every failing floor is collected, not just the first', () => {
  const failures = belowFloor(scores({ naturalness: 10, factual: 10, risk: 90 }), DEFAULT_FLOORS);
  assert.equal(failures.length, 3);
});

test('floors are configurable and anything unreadable falls back to the default', () => {
  const f = normaliseFloors({ factual: 90, naturalness: 'high', nonsense: 1 });
  assert.equal(f.factual, 90);
  assert.equal(f.naturalness, DEFAULT_FLOORS.naturalness);
});

test('the overall number is ordering only, and risk pulls it down', () => {
  assert.ok(overallOf(scores({ risk: 0 })) > overallOf(scores({ risk: 80 })));
});

// ---------------------------------------------------------------------------
// The register the scorer judges against
// ---------------------------------------------------------------------------

test('the scorer is given the same register lines the writer was', () => {
  const lines = renderRegister(REGISTER, LENGTH);
  const { user } = buildScorePrompt(
    [{ kind: 'community-only', text: 'markets suspend', words: 2, claimIds: [] }],
    {
      sectionName: 'NFL Betting',
      threadTitle: 't',
      postBody: 'b',
      problem: 'p',
      registerLines: lines,
      claims: [],
      linksPermitted: false,
      brandNames: ['Northwind'],
    },
  );
  for (const line of lines) assert.ok(user.includes(line));
});

test('the register never claims to have measured winners', () => {
  // Covers exposes no score. A prompt saying "8 of 10 WINNING posts" would be
  // the system upgrading its own evidence.
  const lines = renderRegister(REGISTER, LENGTH).join('\n');
  assert.ok(!/winning/i.test(lines));
  assert.ok(/posts here run about/.test(lines));
});

test('a thin thread says so rather than manufacturing a register', () => {
  const thin = profileSection([{ body: 'yeah' }, { body: 'same' }]);
  const lines = renderRegister(thin, targetLength(thin));
  assert.ok(lines.some((l) => l.includes('too thin')));
});
