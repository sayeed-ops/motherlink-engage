// Shopify's own knowledge list, and the model picks in its settings.
//
// The property that matters most: COPY FROM REDDIT ONLY ADDS. A list sync that
// replaced would delete every source somebody added for Shopify alone, and it
// would do it silently — the screen would simply show Reddit's list.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchSources,
  normaliseSource,
  parseSourcesJson,
  planCopyFromReddit,
  planImport,
  sourceKeys,
  SourcesJsonError,
} from '../../apps/web/src/modules/shopify/knowledge.ts';
import { modelRefProblem, normaliseShopifyConfig } from '../../apps/web/src/modules/shopify/config.ts';
import { supportingSources } from '../../apps/web/src/server/shopifyDrafts.ts';

const held = (over = {}) => ({
  sourceId: 'h1',
  type: 'url',
  title: 'Duplicate pages guide',
  url: 'https://northwind.example/guides/duplicates',
  summary: '',
  keyPoints: [],
  answerAngles: [],
  relatedProblems: [],
  origin: 'manual',
  copiedFromSourceId: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  editedAtMs: null,
  ...over,
});

// ---------------------------------------------------------------------------
// One source
// ---------------------------------------------------------------------------

test('a source needs a title, and a URL must be http(s)', () => {
  assert.equal(normaliseSource({}).ok, false);
  assert.equal(normaliseSource({ title: 'x', url: 'javascript:alert(1)' }).ok, false);
  const ok = normaliseSource({ title: '  Pricing ', url: 'https://x.example', keyPoints: ['a', 'a', '', 3] });
  assert.equal(ok.ok, true);
  assert.equal(ok.source.title, 'Pricing');
  assert.deepEqual(ok.source.keyPoints, ['a'], 'duplicates and non-strings survived');
});

test('the same page is recognised however its URL is written', () => {
  assert.equal(
    sourceKeys({ url: 'https://www.X.example/a/#top', title: 't' }).url,
    sourceKeys({ url: 'http://x.example/a', title: 't' }).url,
  );
});

// ---------------------------------------------------------------------------
// JSON import
// ---------------------------------------------------------------------------

test('an import reads an array, one object, a fenced block, or {"sources": […]}', () => {
  assert.equal(parseSourcesJson('[{"title":"a"},{"title":"b"}]').rows.length, 2);
  assert.equal(parseSourcesJson('{"title":"a"}').rows.length, 1);
  assert.equal(parseSourcesJson('```json\n[{"title":"a"}]\n```').rows.length, 1);
  assert.equal(parseSourcesJson('{"sources":[{"title":"a"},{"title":"b"}]}').rows.length, 2);
});

test('an import keeps the good rows and names the bad ones', () => {
  const r = parseSourcesJson('[{"title":"good"},{"summary":"no title"},{"title":"bad url","url":"ftp://x"}]');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.index), [1, 2]);
});

test('an import that is not JSON, or too large, is refused whole', () => {
  assert.throws(() => parseSourcesJson('nope'), SourcesJsonError);
  assert.throws(() => parseSourcesJson(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` })))), SourcesJsonError);
});

test('an import skips what is already held, and duplicates within itself', () => {
  const plan = planImport(
    [
      { ...held(), title: 'New one', url: 'https://northwind.example/new' },
      { ...held(), title: 'Different title, same page', url: 'https://www.northwind.example/guides/duplicates/' },
      { ...held(), title: 'duplicate PAGES guide', url: null },
      { ...held(), title: 'New one', url: null },
    ],
    [held()],
  );
  assert.deepEqual(plan.toAdd.map((s) => s.title), ['New one']);
  assert.equal(plan.duplicates.length, 3);
});

// ---------------------------------------------------------------------------
// Copy from Reddit — adds, never replaces
// ---------------------------------------------------------------------------

test('Copy from Reddit adds what is missing and leaves everything held alone', () => {
  const existing = [held(), held({ sourceId: 'h2', title: 'Shopify-only source', url: null })];
  const reddit = [
    { sourceId: 'r1', title: 'Duplicate pages guide', url: 'https://northwind.example/guides/duplicates' },
    { sourceId: 'r2', title: 'Pricing', url: 'https://northwind.example/pricing' },
    { sourceId: 'r3', summary: 'no title' },
  ];
  const plan = planCopyFromReddit(reddit, existing);
  assert.deepEqual(plan.toAdd.map((s) => s.title), ['Pricing']);
  assert.equal(plan.toAdd[0].copiedFromSourceId, 'r2');
  assert.equal(plan.alreadyHeld, 1);
  assert.equal(plan.unusable, 1);
});

test('a copied source edited here is not copied again beside itself', () => {
  // The edit changed its title and URL, so only the remembered Reddit id can
  // say it is the same source.
  const existing = [held({ title: 'Renamed here', url: 'https://northwind.example/moved', origin: 'reddit', copiedFromSourceId: 'r1' })];
  const plan = planCopyFromReddit([{ sourceId: 'r1', title: 'Original title', url: 'https://northwind.example/orig' }], existing);
  assert.equal(plan.toAdd.length, 0);
  assert.equal(plan.alreadyHeld, 1);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('a source matches on the words that say when it applies, not its summary', () => {
  const s = { sourceId: 's', title: 'Canonical tags for collection pages', summary: 'everything about everything', keyPoints: [], answerAngles: [] };
  assert.equal(matchSources([s], 'my collection pages have canonical problems').length, 1);
  assert.equal(matchSources([s], 'everything about everything').length, 0);
});

test('a draft leans on the sources the analysis judged Brand on, then fresh matches', () => {
  const a = { sourceId: 'a', title: 'Alpha', summary: '', keyPoints: [], answerAngles: [] };
  const b = { sourceId: 'b', title: 'Canonical tags collection', summary: '', keyPoints: [], answerAngles: [] };
  const got = supportingSources([a, b], ['a', 'deleted-since'], 'canonical tags on a collection');
  assert.deepEqual(got.map((s) => s.sourceId), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Model picks
// ---------------------------------------------------------------------------

test('a model pick must be a catalogue model that returns JSON', () => {
  assert.equal(modelRefProblem(null), null, 'the platform default is always allowed');
  assert.equal(modelRefProblem('deepseek:deepseek-chat'), null);
  assert.match(modelRefProblem('made:up'), /not a model this build knows/);
  assert.match(modelRefProblem('deepseek:deepseek-reasoner'), /JSON/);
});

test('a stored pick that can no longer be used reads as the default, not as a crash', () => {
  const c = normaliseShopifyConfig({ analysisModel: 'deepseek:deepseek-reasoner', draftModel: 'gone:model' });
  assert.equal(c.analysisModel, null);
  assert.equal(c.draftModel, null);
  assert.equal(normaliseShopifyConfig({ draftModel: 'openrouter:anthropic/claude-sonnet-5' }).draftModel, 'openrouter:anthropic/claude-sonnet-5');
});
