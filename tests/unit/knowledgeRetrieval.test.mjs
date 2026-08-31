// Which assets a conversation is actually about — and, mostly, which it is not.
//
// The ranking half of retrieval is ordinary. The half worth testing hard is the
// VETO: a matcher that can only say yes will, given a large enough library,
// find the client relevant to every thread on the forum. That is the failure
// this whole design exists to prevent, so the exclusion cases below are the
// point of this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasMatch, retrieve, tokenise, MIN_SCORE } from '../../apps/web/src/modules/knowledge/retrieval.ts';

const asset = (over = {}) => ({
  assetId: 'a1',
  projectId: 'p1',
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'When cashout is offered and when it disappears.',
  problems: ['cashout vanished mid game'],
  triggers: ['cashout disappeared', 'cashout unavailable'],
  exclusions: [],
  sourceUrl: 'https://example.test/help/cashout',
  status: 'active',
  proposedBy: 'model',
  model: 'deepseek-chat',
  promptVersion: 'v1',
  confirmedBy: 'u1',
  confirmedByName: 'Sam',
  confirmedAt: new Date(0),
  sourceHash: 'abc12345',
  lastCrawledAt: new Date(0),
  sourceChangedAt: null,
  createdBy: 'u1',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const query = (concepts, text = '') => ({ concepts, text });

// ── tokenising ─────────────────────────────────────────────────────────────

test('tokenise drops stop words and punctuation, keeps the meaningful words', () => {
  assert.deepEqual(tokenise('Why did the cashout disappear?'), ['did', 'cashout', 'disappear']);
});

test('tokenise keeps hyphenated betting vocabulary intact', () => {
  assert.ok(tokenise('line-movement on the spread').includes('line-movement'));
});

// ── matching ───────────────────────────────────────────────────────────────

test('a trigger phrase in the concepts is the strongest match', () => {
  const r = retrieve(query(['cashout disappeared']), [asset()]);
  assert.equal(r.matches.length, 1);
  assert.ok(r.matches[0].score >= MIN_SCORE);
  assert.deepEqual(r.matches[0].matched.triggers, ['cashout disappeared']);
});

test('a trigger found only in the thread text still matches, more weakly', () => {
  const strong = retrieve(query(['cashout disappeared']), [asset()]).matches[0].score;
  const weak = retrieve(query([], 'my cashout disappeared halfway through'), [asset()]).matches[0].score;
  assert.ok(weak < strong, 'a curated concept must outrank an incidental mention');
});

test('an empty library returns nothing rather than throwing', () => {
  assert.deepEqual(retrieve(query(['cashout disappeared']), []).matches, []);
});

test('one problem phrase matched against a concept is enough to be considered', () => {
  // The floor is set at exactly this case. A problem statement is somebody's
  // considered description of what the asset addresses; one landing is evidence.
  const a = asset({ triggers: [], problems: ['cashout vanished mid game'], title: 'Zzz' });
  assert.equal(retrieve(query(['cashout vanished mid game']), [a]).matches.length, 1);
});

test('incidental overlap does not accumulate into a match', () => {
  // A problem phrase found loose in the thread text (10) plus the asset's title
  // sharing its words (6) comes to 16, and the floor is 18. That shortfall is
  // deliberate: neither signal is somebody saying "this asset is for this", and
  // two accidents are still an accident.
  const a = asset({ triggers: [], problems: ['cashout vanished mid game'], title: 'Cashout availability' });
  assert.equal(retrieve(query([], 'cashout vanished mid game, and availability was odd'), [a]).matches.length, 0);
  assert.equal(retrieve(query([], 'cashout vanished mid game'), [a]).matches.length, 0);
});

test('every token of a trigger phrase must be present — no partial credit', () => {
  // "movement" alone must not fire "line movement". The whole value of a
  // curated trigger list is that it is more specific than a bag of words.
  const a = asset({ triggers: ['line movement'], problems: [], title: 'Odds movement report' });
  assert.equal(retrieve(query(['movement']), [a]).matches.length, 0);
  assert.equal(retrieve(query(['line movement']), [a]).matches.length, 1);
});

test('a single weak overlap does not clear the floor', () => {
  const a = asset({ triggers: ['cashout disappeared'], problems: [], title: 'Cashout availability' });
  // "cashout" alone hits the title only — deliberately not enough.
  assert.equal(retrieve(query([], 'talking about cashout'), [a]).matches.length, 0);
});

test('matches come back ranked, best first', () => {
  const strong = asset({ assetId: 'strong', triggers: ['cashout disappeared'] });
  const weak = asset({ assetId: 'weak', triggers: ['withdrawal pending'], problems: ['cashout disappeared'] });
  const r = retrieve(query(['cashout disappeared']), [strong, weak]);
  assert.deepEqual(r.matches.map((m) => m.asset.assetId), ['strong', 'weak']);
});

test('topN caps how many reach the prompt', () => {
  const many = Array.from({ length: 9 }, (_, i) => asset({ assetId: `a${i}`, title: `Asset ${i}` }));
  assert.equal(retrieve(query(['cashout disappeared']), many, { topN: 3 }).matches.length, 3);
});

// ── the veto ───────────────────────────────────────────────────────────────

test('an exclusion removes the asset outright', () => {
  const a = asset({ exclusions: ['bank transfer'] });
  const r = retrieve(query(['cashout disappeared', 'bank transfer']), [a]);
  assert.equal(r.matches.length, 0, 'an excluded asset is wrong, not merely low-scoring');
  assert.equal(r.vetoed.length, 1);
  assert.equal(r.vetoed[0].exclusion, 'bank transfer');
});

test('a veto cannot be outrun by scoring well on everything else', () => {
  // The reason exclusions veto rather than subtract: a big enough pile of
  // matches would otherwise carry a wrong asset into the prompt.
  const a = asset({
    triggers: ['cashout disappeared', 'cashout unavailable', 'cashout offer'],
    problems: ['cashout vanished mid game', 'cashout disappeared'],
    exclusions: ['bank transfer'],
  });
  const r = retrieve(query(['cashout disappeared', 'cashout unavailable', 'cashout offer', 'bank transfer']), [a]);
  assert.equal(r.matches.length, 0);
});

test('an exclusion mentioned only in the thread text still vetoes', () => {
  const a = asset({ exclusions: ['bank transfer'] });
  const r = retrieve(query(['cashout disappeared'], 'this was a bank transfer, not a bet'), [a]);
  assert.equal(r.matches.length, 0);
});

test('an unrelated exclusion does not veto', () => {
  const a = asset({ exclusions: ['bank transfer'] });
  assert.equal(retrieve(query(['cashout disappeared']), [a]).matches.length, 1);
});

// ── the freshness filter ───────────────────────────────────────────────────

test('assets outside the usable set are never considered', () => {
  // This is how freshness reaches retrieval without retrieval knowing the time.
  const r = retrieve(query(['cashout disappeared']), [asset()], { usableAssetIds: new Set() });
  assert.equal(r.matches.length, 0);
  assert.equal(r.vetoed.length, 0, 'not offered is not the same as rejected');
});

test('passing no usable set means no freshness filter', () => {
  assert.equal(retrieve(query(['cashout disappeared']), [asset()], { usableAssetIds: null }).matches.length, 1);
});

// ── the answer the pipeline branches on ────────────────────────────────────

test('hasMatch is false when everything was vetoed', () => {
  const a = asset({ exclusions: ['bank transfer'] });
  const r = retrieve(query(['cashout disappeared', 'bank transfer']), [a]);
  assert.equal(hasMatch(r), false);
  assert.equal(r.vetoed.length, 1, 'the pipeline still needs to tell "rejected" from "nothing there"');
});

test('hasMatch is false for an empty library', () => {
  assert.equal(hasMatch(retrieve(query(['cashout disappeared']), [])), false);
});
