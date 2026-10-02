// The question-only analysis: what it is shown, and the rules that are not the
// model's to break.
//
// The assertions that matter are the ones a model could quietly get wrong and
// nobody would notice from the screen: that the replies never reach this
// prompt, that the thread's numbers always do, that Brand cannot outscore the
// evidence behind it, and that a re-analysis carries the reviewer's words.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_CAP_WITHOUT_SOURCE,
  buildAssessPrompt,
  isBrandOpportunity,
  isUnreadable,
  parseAssessment,
  scorableModes,
  SYSTEM_PROMPT,
  topScore,
  UNREADABLE,
} from '../../apps/web/src/modules/shopify/assess.ts';
import { emptyClientProfile } from '../../apps/web/src/modules/shopify/client.ts';

const client = {
  ...emptyClientProfile(),
  companyDescription: 'Northwind builds SEO tooling for small stores',
  productService: 'An app that fixes duplicate pages',
  brandMentionStyle: 'Once, plainly',
};
const source = { sourceId: 's1', title: 'Duplicate pages guide', summary: 'How duplicates happen', keyPoints: ['canonical tags'], answerAngles: [] };

const counts = { replies: 12, views: 340, likes: 5, solved: true, closed: false, daysOld: 14, daysSinceLastPost: 2 };

const input = (over = {}) => ({
  title: 'Collection pages vanished from Google',
  board: 'SEO',
  question: 'After changing theme my collection pages dropped out of Google. Why?',
  askedBy: 'merchant42',
  counts,
  client,
  sources: [source],
  ...over,
});

const reply = (over = {}) =>
  JSON.stringify({
    question: 'Why did collection pages drop out of Google after a theme change?',
    askerContext: 'a merchant',
    needs: 'canonical and noindex checks',
    open: { score: 8, why: 'clear', angle: 'walk through checks' },
    growth: { score: 6, why: 'field fits', angle: 'crawl diagnosis' },
    brand: { score: 9, why: 'the guide covers it', angle: 'name the app once', sourceIds: ['s1', 'INVENTED'] },
    suggested: 'brand',
    confidence: 0.7,
    ...over,
  });

// ---------------------------------------------------------------------------
// What the prompt carries
// ---------------------------------------------------------------------------

test('the prompt carries the thread numbers, and says the replies were not shown', () => {
  // THE OPERATOR'S DESIGN, WITH ITS ONE GUARD: without the numbers an
  // unanswered question and a solved thirty-reply one look identical.
  const p = buildAssessPrompt(input());
  assert.match(p, /12 replies/);
  assert.match(p, /340 views/);
  assert.match(p, /SOLVED/);
  assert.match(p, /not shown to you/);
  assert.match(SYSTEM_PROMPT, /NOT shown the replies/);
});

test('an unanswered thread says so rather than implying hidden replies', () => {
  const p = buildAssessPrompt(input({ counts: { ...counts, replies: 0, solved: false } }));
  assert.match(p, /Nobody has replied yet/);
  assert.ok(!/not shown to you/.test(p));
});

test('a very long question is cut, and says it was', () => {
  const p = buildAssessPrompt(input({ question: 'word '.repeat(5000) }));
  assert.match(p, /rest of the post not shown/);
  assert.ok(p.length < 9000);
});

test('with no matched source, the prompt states the Brand cap', () => {
  assert.match(buildAssessPrompt(input({ sources: [] })), new RegExp(`BRAND must be ${BRAND_CAP_WITHOUT_SOURCE} or lower`));
});

test('with no client, the prompt says Growth and Brand are 0 and carries no company', () => {
  const p = buildAssessPrompt(input({ client: emptyClientProfile() }));
  assert.match(p, /None described/);
  assert.ok(!p.includes('Northwind'));
});

test('a re-analysis carries the reviewer’s comment and the scores it is reconsidering', () => {
  const previous = parseAssessment(reply(), { client, offeredSourceIds: ['s1'] });
  const p = buildAssessPrompt(input({ steer: { comment: 'Read it as an AGENCY', previous } }));
  assert.match(p, /RECONSIDER/);
  assert.match(p, /Read it as an AGENCY/);
  assert.match(p, /BRAND 9/);
});

test('a blank comment is not a steer', () => {
  const previous = parseAssessment(reply(), { client, offeredSourceIds: ['s1'] });
  assert.ok(!/RECONSIDER/.test(buildAssessPrompt(input({ steer: { comment: '   ', previous } }))));
});

test('the Open reasoning is told to leave the company out', () => {
  // The analysis sees the client (it scores Brand), but Open's brief is handed
  // to a draft that must not know the client exists.
  assert.match(SYSTEM_PROMPT, /OPEN reason and angle as if the company below did not exist/);
});

// ---------------------------------------------------------------------------
// The rules the parser enforces
// ---------------------------------------------------------------------------

test('an unparseable or question-less answer is UNREADABLE, not a thread with nothing in it', () => {
  assert.deepEqual(parseAssessment('not json', { client, offeredSourceIds: [] }), UNREADABLE);
  assert.ok(isUnreadable(parseAssessment('{"question":"  "}', { client, offeredSourceIds: [] })));
});

test('an invented source id is dropped from Brand’s evidence', () => {
  const a = parseAssessment(reply(), { client, offeredSourceIds: ['s1'] });
  assert.deepEqual(a.scores.brand.sourceIds, ['s1']);
});

test('Brand is capped when no source matched, whatever the model said', () => {
  const a = parseAssessment(reply({ brand: { score: 9, why: 'fits', angle: 'x', sourceIds: [] } }), {
    client,
    offeredSourceIds: [],
  });
  assert.equal(a.scores.brand.score, BRAND_CAP_WITHOUT_SOURCE);
  assert.notEqual(a.suggested, 'brand', 'suggested a mode that cannot be drafted');
});

test('Growth and Brand are zero with no client — arithmetic, not opinion', () => {
  const a = parseAssessment(reply(), { client: emptyClientProfile(), offeredSourceIds: ['s1'] });
  assert.equal(a.scores.growth.score, 0);
  assert.equal(a.scores.brand.score, 0);
  assert.equal(a.suggested, 'open');
});

test('Brand is zero when the client’s product is not described', () => {
  const a = parseAssessment(reply(), { client: { ...client, productService: '' }, offeredSourceIds: ['s1'] });
  assert.equal(a.scores.brand.score, 0);
  assert.ok(a.scores.growth.score > 0);
});

test('scores are clamped to 0–10 and a zero score carries no angle', () => {
  const a = parseAssessment(reply({ open: { score: 42, why: 'x', angle: 'y' }, growth: { score: -3, why: 'x', angle: 'SHOULD GO' } }), {
    client,
    offeredSourceIds: ['s1'],
  });
  assert.equal(a.scores.open.score, 10);
  assert.equal(a.scores.growth.score, 0);
  assert.equal(a.scores.growth.angle, '');
});

test('a suggestion the model may not make falls back to the best available, or skip', () => {
  assert.equal(parseAssessment(reply({ suggested: 'viral' }), { client, offeredSourceIds: ['s1'] }).suggested, 'brand');
  const weak = reply({
    open: { score: 2, why: '', angle: '' },
    growth: { score: 1, why: '', angle: '' },
    brand: { score: 2, why: '', angle: '', sourceIds: [] },
    suggested: 'nonsense',
  });
  assert.equal(parseAssessment(weak, { client, offeredSourceIds: ['s1'] }).suggested, 'skip');
  assert.equal(parseAssessment(reply({ suggested: 'skip' }), { client, offeredSourceIds: ['s1'] }).suggested, 'skip');
});

test('a brand opportunity needs the score AND a supporting source', () => {
  const a = parseAssessment(reply(), { client, offeredSourceIds: ['s1'] });
  assert.ok(isBrandOpportunity(a, true));
  assert.ok(!isBrandOpportunity(a, false));
  assert.equal(topScore(a), 9);
});

test('what can be scored is decided before any model is asked', () => {
  assert.deepEqual(scorableModes(emptyClientProfile(), 3), { open: true, growth: false, brand: false, brandSupported: false });
  assert.deepEqual(scorableModes(client, 0), { open: true, growth: true, brand: true, brandSupported: false });
  assert.equal(scorableModes(client, 1).brandSupported, true);
});
