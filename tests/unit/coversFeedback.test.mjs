// The calibration set, and what happened after somebody posted by hand.
//
// The two assertions that matter most here are both about NOT LYING WITH A
// NUMBER: an approval has to be in the dataset or the set can only measure
// failure, and an unmeasured outcome has to stay null or a campaign nobody
// followed up on reports a perfect record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFor,
  buildFeedback,
  calibrationReport,
  isSubstantiveEdit,
  isTriageTag,
  MIN_DECISIONS_TO_FIT,
} from '../../apps/web/src/modules/covers/feedback.ts';
import {
  dueForCheck,
  isMeasured,
  newOutcome,
  summariseCampaign,
} from '../../apps/web/src/modules/covers/outcome.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_788_000_000_000;

const variant = (over = {}) => ({
  kind: 'brand-informed',
  text: 'markets suspend and the button goes with them, it comes back after.',
  words: 12,
  claimIds: ['c1'],
  scores: { suitability: 70, relevance: 80, naturalness: 75, brandFit: 50, risk: 20, factual: 80 },
  recommendation: 'POST',
  why: 'answers it plainly',
  compliancePassed: true,
  complianceFailures: [],
  evidence: [],
  assertions: [],
  disclosure: { required: false, wording: '', why: '' },
  ...over,
});

const input = (over = {}) => ({
  draftId: 'd1',
  analysisId: 'a1',
  section: 'nfl-betting-21',
  action: 'approved',
  variant: variant(),
  selected: 'brand-informed',
  opportunityScore: 80,
  assetIds: ['asset1'],
  after: '',
  tags: [],
  reason: 'reads right',
  by: { uid: 'u1', name: 'Sam' },
  ...over,
});

// ---------------------------------------------------------------------------
// What the person actually did
// ---------------------------------------------------------------------------

test('an "approve" that changed the text is recorded as an edit', () => {
  assert.equal(
    actionFor({ approved: true, declined: false, before: 'one thing', after: 'another thing' }),
    'edited',
  );
  assert.equal(actionFor({ approved: true, declined: false, before: 'one thing', after: '' }), 'approved');
});

test('whitespace is not an edit', () => {
  assert.equal(isSubstantiveEdit('a  b', ' a b '), false);
  assert.equal(isSubstantiveEdit('a b', 'a c'), true);
  assert.equal(
    actionFor({ approved: true, declined: false, before: 'a  b', after: ' a b ' }),
    'approved',
  );
});

test('disagreeing with a decline is its own action', () => {
  assert.equal(actionFor({ approved: true, declined: true, before: '', after: '', overruled: true }), 'overruled-none');
  assert.equal(actionFor({ approved: false, declined: true, before: '', after: '' }), 'agreed-none');
});

test('an approval keeps the text in `after`, never an empty string', () => {
  // Otherwise every approval reads as a deletion to anything comparing the pair.
  const f = buildFeedback(input());
  assert.equal(f.after, f.before);
  assert.ok(f.after.length > 0);
});

test('the scores are COPIED onto the record', () => {
  // A draft can be regenerated and floors can move. The question this set
  // answers is what the system said at the moment somebody disagreed with it.
  const f = buildFeedback(input());
  assert.equal(f.scores.factual, 80);
  assert.equal(f.recommendation, 'POST');
  assert.equal(f.opportunityScore, 80);
});

test('an unknown tag is dropped rather than stored', () => {
  const f = buildFeedback(input({ tags: ['too_salesy', 'not_a_real_tag', 'too_salesy'] }));
  assert.deepEqual(f.tags, ['too_salesy']);
});

test('wasBacked is true only when every assertion found a live claim', () => {
  assert.equal(buildFeedback(input()).wasBacked, false, 'no assertions is not "backed"');

  const backed = buildFeedback(
    input({ variant: variant({ assertions: [{ sentence: 's', backedBy: 'c1' }] }) }),
  );
  assert.equal(backed.wasBacked, true);

  const partly = buildFeedback(
    input({
      variant: variant({
        assertions: [
          { sentence: 's', backedBy: 'c1' },
          { sentence: 't', backedBy: null },
        ],
      }),
    }),
  );
  assert.equal(partly.wasBacked, false);
});

test('a decline records no variant and no scores, and that is not a gap', () => {
  const f = buildFeedback(input({ action: 'agreed-none', variant: null, selected: 'NONE' }));
  assert.equal(f.variant, null);
  assert.equal(f.scores, null);
  assert.equal(f.selected, 'NONE');
});

test('a triage finding is separable from a writing finding', () => {
  assert.equal(isTriageTag('not_an_opportunity'), true);
  assert.equal(isTriageTag('too_salesy'), false);
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

const row = (over = {}) => ({
  ...buildFeedback(input(over)),
  feedbackId: 'f',
  projectId: 'p',
  createdAt: new Date(NOW),
  ...(over.scoresOverride ? { scores: over.scoresOverride } : {}),
});

test('nothing is fittable below the minimum, and the report says so', () => {
  assert.equal(MIN_DECISIONS_TO_FIT, 20);
  const r = calibrationReport([row(), row()]);
  assert.equal(r.decisions, 2);
  assert.equal(r.fittable, false);
});

test('approvals are IN the set — without them nothing can measure success', () => {
  const feedback = [
    row({ action: 'approved' }),
    row({ action: 'approved' }),
    row({ action: 'rejected' }),
    row({ action: 'edited', after: 'a different reply entirely' }),
  ];
  const r = calibrationReport(feedback);
  assert.equal(r.approvalRate, 0.75);
  assert.equal(r.editRate, 0.25);
});

test('separation is signed, so a dimension pointing the wrong way looks wrong', () => {
  const kept = row({
    action: 'approved',
    variant: variant({ scores: { suitability: 90, relevance: 90, naturalness: 90, brandFit: 90, risk: 10, factual: 90 } }),
  });
  const refused = row({
    action: 'rejected',
    variant: variant({ scores: { suitability: 30, relevance: 30, naturalness: 30, brandFit: 30, risk: 80, factual: 30 } }),
  });

  const r = calibrationReport([kept, refused]);
  assert.equal(r.byDimension.suitability.separation, 60, 'kept scores higher');
  // risk is inverted: refused SHOULD score higher, so a correct risk dimension
  // separates negatively.
  assert.equal(r.byDimension.risk.separation, -70);
});

test('a dimension that predicts nothing shows separation 0', () => {
  const same = { suitability: 70, relevance: 70, naturalness: 70, brandFit: 70, risk: 20, factual: 70 };
  const r = calibrationReport([
    row({ action: 'approved', variant: variant({ scores: same }) }),
    row({ action: 'rejected', variant: variant({ scores: same }) }),
  ]);
  assert.equal(r.byDimension.naturalness.separation, 0);
});

test('the overrule rate is measured over declines only', () => {
  const r = calibrationReport([
    row({ action: 'approved' }),
    row({ action: 'agreed-none', variant: null, selected: 'NONE' }),
    row({ action: 'agreed-none', variant: null, selected: 'NONE' }),
    row({ action: 'overruled-none', variant: null, selected: 'NONE' }),
  ]);
  assert.equal(r.overruleRate, 0.33);
  assert.equal(r.approvalRate, 1, 'the one offered draft was kept');
});

test('an empty set reports zeros and nulls, and never divides by zero', () => {
  const r = calibrationReport([]);
  assert.equal(r.decisions, 0);
  assert.equal(r.fittable, false);
  assert.equal(r.approvalRate, 0);
  assert.equal(r.byDimension.factual.kept, null);
  assert.equal(r.byDimension.factual.separation, null);
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

const outcome = (over = {}) => ({
  ...newOutcome({
    draftId: 'd1',
    itemId: 'i1',
    section: 'nfl-betting-21',
    variant: 'community-only',
    postedText: 'markets suspend',
    permalink: null,
    postedAtMs: NOW,
  }),
  outcomeId: 'o1',
  projectId: 'p',
  createdBy: 'u1',
  createdAt: new Date(NOW),
  ...over,
});

test('a new outcome measures NOTHING, and says so with nulls', () => {
  const o = outcome();
  assert.equal(o.replies, null);
  assert.equal(o.quoted, null);
  assert.equal(o.threadPostsAfter, null);
  assert.equal(o.moderation, 'unknown');
  assert.equal(o.consequence, 'unknown');
  assert.equal(o.measuredAtMs, null);
  assert.equal(isMeasured(o), false);
});

test('a campaign nobody followed up on does NOT report a perfect record', () => {
  // ⚠️ THE FAILURE THIS PREVENTS: 20 posted, 8 checked, and a report reading
  // "0.4 replies, 100% survived" — a confident measurement of nothing.
  const outcomes = [
    outcome({ measuredAtMs: NOW + DAY, replies: 2, moderation: 'survived', quoted: true }),
    outcome({ measuredAtMs: NOW + DAY, replies: 0, moderation: 'survived', quoted: false }),
    outcome(),
    outcome(),
  ];

  const s = summariseCampaign(outcomes);
  assert.equal(s.posted, 4);
  assert.equal(s.measured, 2);
  assert.equal(s.notChecked, 2);
  assert.equal(s.meanReplies, 1, 'the mean is over the MEASURED ones');
  assert.equal(s.survived, 2);
  assert.equal(s.moderationUnknown, 2, 'unchecked is not "survived"');
});

test('a campaign with nothing measured reports null, not zero', () => {
  const s = summariseCampaign([outcome(), outcome()]);
  assert.equal(s.meanReplies, null);
  assert.equal(s.quotedCount, null);
  assert.equal(s.measured, 0);
});

test('removed and deleted are counted apart', () => {
  const s = summariseCampaign([
    outcome({ measuredAtMs: NOW, moderation: 'removed' }),
    outcome({ measuredAtMs: NOW, moderation: 'deleted' }),
  ]);
  assert.equal(s.removed, 1, 'we took the other one down ourselves');
});

test('any consequence worse than none is counted — it is what stops a pilot', () => {
  const s = summariseCampaign([
    outcome({ consequence: 'none' }),
    outcome({ consequence: 'unknown' }),
    outcome({ consequence: 'warned' }),
    outcome({ consequence: 'banned' }),
  ]);
  assert.equal(s.consequences, 2);
});

test('a reply is not due for a check before the first window', () => {
  assert.equal(dueForCheck({ postedAtMs: NOW, measuredAtMs: null }, NOW + HOUR), false);
  assert.equal(dueForCheck({ postedAtMs: NOW, measuredAtMs: null }, NOW + DAY + HOUR), true);
});

test('a reply measured once comes due again at the second window', () => {
  const measuredOnce = { postedAtMs: NOW, measuredAtMs: NOW + DAY };
  assert.equal(dueForCheck(measuredOnce, NOW + 2 * DAY), false);
  assert.equal(dueForCheck(measuredOnce, NOW + 8 * DAY), true);
  // And not a third time.
  assert.equal(dueForCheck({ postedAtMs: NOW, measuredAtMs: NOW + 8 * DAY }, NOW + 30 * DAY), false);
});

test('outcomes are counted by variant, which is what phase 7 fits against', () => {
  const s = summariseCampaign([
    outcome({ variant: 'community-only' }),
    outcome({ variant: 'community-only' }),
    outcome({ variant: 'brand-informed' }),
  ]);
  assert.deepEqual(s.byVariant, { 'community-only': 2, 'brand-informed': 1 });
});
