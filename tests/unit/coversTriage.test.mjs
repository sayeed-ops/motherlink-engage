// One post, from harvested to ranked — or to a recorded reason it is not.
//
// The assertions that matter most are about the BILL: which posts reach the paid
// call and which are decided for free. A funnel that classifies everything and
// screens afterwards produces the same queue and a very different invoice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  triagePost,
  buildGaps,
  rankOpportunities,
  triageSummary,
  paidCalls,
  scoreOpportunity,
} from '../../apps/web/src/modules/covers/triage.ts';
import { parseIntent, UNREADABLE, isDraftable } from '../../apps/web/src/modules/covers/intent.ts';

const HOUR = 3_600_000;
const NOW = 1_788_000_000_000;

const SECTIONS = [
  { slug: 'nfl-betting-21', name: 'NFL Betting', roles: ['watch', 'reply'], sport: 'nfl' },
  { slug: 'website-promotions-9', name: 'Promotions', roles: ['watch', 'reply', 'promote'], sport: null },
  { slug: 'general-discussion-25', name: 'General', roles: ['watch'], sport: null },
];

const asset = (over = {}) => ({
  assetId: 'a1',
  projectId: 'p',
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'When cashout is and is not offered',
  problems: ['cashout disappeared', 'cannot cash out'],
  triggers: ['cash out', 'cashout', 'cash-out'],
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

const reading = (over = {}) => ({
  intent: 'question',
  problem: 'They cannot work out why cashout vanished on a live bet.',
  concepts: ['cashout', 'market suspended'],
  asksSomething: true,
  confidence: 0.8,
  ...over,
});

const post = (over = {}) => ({
  postId: 'p1',
  threadId: 't1',
  number: 4,
  author: 'someone',
  authorId: '2',
  createdAtMs: NOW - HOUR,
  page: 1,
  body: 'My cash out button disappeared halfway through the game and I could not close the bet, is that normal?',
  ...over,
});

const input = (over = {}) => ({
  itemId: 'proj_covers_1',
  threadTitle: 'Cashout vanished mid-game',
  threadLastPostAtMs: NOW - HOUR,
  section: 'nfl-betting-21',
  sectionName: 'NFL Betting',
  sections: SECTIONS,
  paceMs: 2 * HOUR,
  footprint: { inThread: 0, inSection: 0, ourAuthors: [] },
  kickoffMs: null,
  jurisdiction: { prohibited: ['Ontario'], licensed: [] },
  assets: [asset()],
  liveClaimsByAsset: { a1: 2 },
  nowMs: NOW,
  ...over,
  // After the spread: over.post is a PARTIAL, and letting it through whole
  // would hand the screen an object with no author or body.
  post: post(over.post),
});

/** An intent reader that records whether it was called at all. */
const spy = (result = reading()) => {
  const calls = [];
  const fn = async (i) => {
    calls.push(i.post.postId);
    return result;
  };
  fn.calls = calls;
  return fn;
};

// ---------------------------------------------------------------------------
// Cost order
// ---------------------------------------------------------------------------

test('a post that fails a free check never reaches the paid call', () => {
  return (async () => {
    const reader = spy();
    const t = await triagePost(input({ section: 'general-discussion-25' }), reader);

    assert.equal(t.outcome, 'screened');
    assert.deepEqual(reader.calls, [], 'a watch-only section is knowable for nothing');
    assert.equal(t.intent, null, 'null intent is the record that we spent nothing');
  })();
});

test('a jurisdiction takes away the client, not the thread', async () => {
  // ⚠️ THE GATE IS RIGHT ONLY IN COMBINATION. Offering a sportsbook to somebody
  // who says they bet from a place it cannot serve is the prohibited act. Being
  // a useful member of the same forum is not — so the community reply survives
  // and only the variants that put the client in front of them are removed.
  const reader = spy();
  const t = await triagePost(
    input({ post: { body: 'Best book for someone betting from Ontario with a decent cash out button on live bets?' } }),
    reader,
  );

  assert.deepEqual(t.jurisdiction.matched, ['Ontario']);
  assert.equal(t.variants.brandMentioned, false);
  assert.equal(t.variants.brandInformed, false);
  assert.equal(t.variants.communityOnly, true, 'we may still answer as a member');
  assert.match(t.eligibilityReasons.brandInformed, /cannot serve/);
  assert.equal(reader.calls.length, 1, 'it needs the classification to know what is being offered');
});

test('a country named in passing does not block anything', async () => {
  // The live failure: two posts in a political argument about healthcare were
  // hard-rejected because the sentence said "in US".
  const t = await triagePost(
    input({
      post: {
        body: 'In both US and Canada, illegal immigrants do not qualify for public healthcare plans, only citizens do.',
      },
    }),
    spy(reading({ intent: 'question', concepts: ['healthcare'], problem: 'Asking about healthcare eligibility.' })),
  );

  assert.equal(t.jurisdiction.blocked, false);
  assert.notEqual(t.outcome, 'jurisdiction');
});

test('a live post in a reply section does reach the paid call, exactly once', async () => {
  const reader = spy();
  const t = await triagePost(input(), reader);

  assert.equal(reader.calls.length, 1);
  assert.equal(t.outcome, 'opportunity');
  assert.ok(t.intent);
});

// ---------------------------------------------------------------------------
// What happens after the call
// ---------------------------------------------------------------------------

test('a complaint leaves the pipeline entirely — it is not a low score', async () => {
  // ⚠️ "They took my money" is a support and reputation event. A pipeline that
  // treats an angry customer as a placement is the fastest way to get an account
  // banned with a client's name attached.
  const t = await triagePost(input(), spy(reading({ intent: 'complaint' })));

  assert.equal(t.outcome, 'complaint');
  assert.equal(t.score, 0);
  assert.equal(t.variants.communityOnly, false, 'nothing may be drafted, not even a neutral reply');
  assert.equal(isDraftable('complaint'), false);
});

test('banter is not an opportunity and not a failure', async () => {
  const t = await triagePost(input(), spy(reading({ intent: 'banter', asksSomething: false })));
  assert.equal(t.outcome, 'not-draftable');
});

test('an unreadable classification cannot become a reply', async () => {
  const t = await triagePost(input(), spy(UNREADABLE));
  assert.equal(t.outcome, 'unreadable');
  assert.equal(t.score, 0);
});

test('a failing intent call is an unreadable post, not a crash', async () => {
  const t = await triagePost(input(), async () => {
    throw new Error('model timed out');
  });
  assert.equal(t.outcome, 'unreadable');
});

test('a record is written for every post, including the ones that stopped at once', async () => {
  const t = await triagePost(input({ section: 'general-discussion-25' }), spy());
  assert.equal(t.postId, 'p1');
  assert.equal(t.itemId, 'proj_covers_1');
  assert.ok(t.screenReasons.length > 0, 'and it says why');
});

// ---------------------------------------------------------------------------
// The library's answer
// ---------------------------------------------------------------------------

test('an exclusion veto is recorded, because "found and rejected" is not "found nothing"', async () => {
  const vetoed = asset({ exclusions: ['cash out'] });
  const t = await triagePost(input({ assets: [vetoed] }), spy());

  assert.equal(t.retrieval.matched.length, 0);
  assert.equal(t.retrieval.vetoed.length, 1);
  assert.equal(t.retrieval.vetoed[0].exclusion, 'cash out');
  assert.equal(t.retrieval.vetoed[0].title, 'Cashout availability', 'named, not just an id');
  // Only the community reply survives — we can still be useful without them.
  assert.equal(t.variants.communityOnly, true);
  assert.equal(t.variants.brandInformed, false);
});

test('a match records WHY it matched, not just that it did', async () => {
  // "This asset matched" is unreviewable. "It matched because the post says
  // 'cash out' and the asset lists that as a trigger" is the difference between
  // a reviewer being able to fix the library and only being able to disagree.
  const t = await triagePost(input(), spy());

  const top = t.retrieval.matched[0];
  assert.equal(top.assetId, 'a1');
  assert.equal(top.title, 'Cashout availability');
  assert.ok(top.score > 0);
  assert.ok(
    top.why.triggers.length > 0 || top.why.problems.length > 0,
    'the phrase that fired is kept',
  );
});

test('a matched asset with no live claim can inform a reply but not be named in one', async () => {
  const t = await triagePost(
    input({ section: 'website-promotions-9', liveClaimsByAsset: {} }),
    spy(),
  );

  assert.equal(t.variants.brandInformed, true);
  assert.equal(t.variants.brandMentioned, false);
  assert.match(t.eligibilityReasons.brandMentioned, /no live claim/);
});

test('nothing in the library is a GAP, and the record keeps what was asked', async () => {
  const t = await triagePost(
    input({ assets: [] }),
    spy(reading({ concepts: ['same game multi tracking'] })),
  );

  assert.equal(t.outcome, 'no-asset-match');
  assert.ok(t.intent, 'the classification is kept — it is what makes it a finding');
  assert.equal(t.variants.communityOnly, true, 'we can still answer as a member');
});

// ---------------------------------------------------------------------------
// The gap board
// ---------------------------------------------------------------------------

test('gaps are counted by thread as well as by post', () => {
  // Twenty replies inside one argument is one conversation, not twenty pieces
  // of demand — ranking on raw posts sends somebody off to write an asset for
  // an argument.
  const gapRow = (itemId, concept, problem) => ({
    postId: `${itemId}-${Math.random()}`,
    itemId,
    section: 'nfl-betting-21',
    outcome: 'no-asset-match',
    screenReasons: [],
    jurisdiction: { blocked: false, matched: [] },
    intent: reading({ concepts: [concept], problem }),
    retrieval: null,
    variants: { brandMentioned: false, brandInformed: false, communityOnly: true },
    eligibilityReasons: {},
    score: 0,
    measured: { postAgeMs: null, threadQuietMs: null, paceMs: null },
  });

  const gaps = buildGaps([
    gapRow('thread-a', 'sgm tracking', 'Cannot follow a same game multi.'),
    gapRow('thread-a', 'sgm tracking', 'Cannot follow a same game multi.'),
    gapRow('thread-a', 'sgm tracking', 'Wants leg-by-leg progress.'),
    gapRow('thread-b', 'withdrawal times', 'Waiting on a payout.'),
    gapRow('thread-c', 'withdrawal times', 'Waiting on a payout.'),
  ]);

  assert.equal(gaps[0].concept, 'withdrawal times', 'two threads beats three posts in one');
  assert.equal(gaps[0].threads, 2);
  assert.equal(gaps[1].concept, 'sgm tracking');
  assert.equal(gaps[1].posts, 3);
  assert.equal(gaps[1].threads, 1);
  assert.equal(gaps[1].examples.length, 2, 'the same sentence twice is one example');
});

test('nobody asking anything is not unmet demand', () => {
  // ⚠️ THE FIRST LIVE RUN PRODUCED NINE GAPS FROM FOUR THREADS, and most were
  // somebody narrating their card: "aaron donald", "star-studded d-line",
  // "16-10-1 overall". A gap board built from every unmatched post measures what
  // the forum TALKS about, and this forum talks about football — so it would
  // send a person off to write an asset about a contract, for a sportsbook.
  const row = (over) => ({
    postId: `p${Math.random()}`,
    itemId: 'thread-a',
    section: 'nfl-betting-21',
    outcome: 'no-asset-match',
    screenReasons: [],
    jurisdiction: { blocked: false, matched: [] },
    retrieval: null,
    variants: { brandMentioned: false, brandInformed: false, communityOnly: true },
    eligibilityReasons: {},
    score: 0,
    measured: { postAgeMs: null, threadQuietMs: null, paceMs: null },
    ...over,
  });

  const gaps = buildGaps([
    row({ intent: reading({ intent: 'pick-sharing', asksSomething: false, concepts: ['aaron donald'] }) }),
    row({ intent: reading({ intent: 'education', asksSomething: false, concepts: ['star-studded d-line'] }) }),
    row({ intent: reading({ intent: 'question', asksSomething: true, concepts: ['cashout timing'] }) }),
  ]);

  assert.equal(gaps.length, 1, 'only the one somebody actually asked');
  assert.equal(gaps[0].concept, 'cashout timing');
});

test('only unmet demand becomes a gap', () => {
  const opportunity = {
    postId: 'x', itemId: 't', section: 's', outcome: 'opportunity',
    screenReasons: [], jurisdiction: { blocked: false, matched: [] },
    intent: reading({ concepts: ['cashout'] }), retrieval: null,
    variants: { brandMentioned: false, brandInformed: true, communityOnly: true },
    eligibilityReasons: {}, score: 50,
    measured: { postAgeMs: null, threadQuietMs: null, paceMs: null },
  };
  assert.deepEqual(buildGaps([opportunity]), []);
});

// ---------------------------------------------------------------------------
// Ranking and the bill
// ---------------------------------------------------------------------------

test('a question about something we cover outranks a card nobody asked about', () => {
  const asked = scoreOpportunity({
    intent: reading({ intent: 'question', asksSomething: true }),
    topAssetScore: 80,
    variants: { brandMentioned: false, brandInformed: true, communityOnly: true },
    postAgeMs: HOUR,
    paceMs: 2 * HOUR,
  });
  const narrated = scoreOpportunity({
    intent: reading({ intent: 'pick-sharing', asksSomething: false, confidence: 0.8 }),
    topAssetScore: 20,
    variants: { brandMentioned: false, brandInformed: false, communityOnly: true },
    postAgeMs: HOUR,
    paceMs: 2 * HOUR,
  });

  assert.ok(asked > narrated, `${asked} should beat ${narrated}`);
  assert.ok(asked <= 100 && narrated >= 0);
});

test('freshness is judged against the section\'s own pace, not in hours', () => {
  const args = {
    intent: reading(),
    topAssetScore: 50,
    variants: { brandMentioned: false, brandInformed: true, communityOnly: true },
    postAgeMs: 4 * HOUR,
  };
  const onAFastBoard = scoreOpportunity({ ...args, paceMs: HOUR / 2 });
  const onASlowBoard = scoreOpportunity({ ...args, paceMs: 24 * HOUR });

  assert.ok(onASlowBoard > onAFastBoard, 'four hours is nothing on a slow board');
});

test('the summary and the bill both add up', async () => {
  const rows = await Promise.all([
    triagePost(input(), spy()),
    triagePost(input({ section: 'general-discussion-25' }), spy()),
    triagePost(input(), spy(reading({ intent: 'complaint' }))),
  ]);

  const counts = triageSummary(rows);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), rows.length);
  assert.equal(counts.opportunity, 1);
  assert.equal(counts.screened, 1);
  assert.equal(counts.complaint, 1);

  assert.equal(paidCalls(rows), 2, 'the screened post cost nothing');
  assert.equal(rankOpportunities(rows).length, 1);
});

// ---------------------------------------------------------------------------
// Reading the model
// ---------------------------------------------------------------------------

test('a post the budget never reached is not a finding about the post', async () => {
  // ⚠️ A run that stops calling the model because it ran out of money must not
  // leave posts marked `unreadable`. That reads as a fact about the post, lands
  // in the counts, and makes a queue cut short by budget look like a quiet
  // forum. Null from the reader means NOT ATTEMPTED.
  const t = await triagePost(input(), async () => null);

  assert.equal(t.outcome, 'budget');
  assert.equal(t.intent, null, 'nothing was learned, so nothing is recorded');
  assert.equal(t.score, 0);

  // And it is distinguishable from a classification that genuinely failed.
  const failed = await triagePost(input(), spy(UNREADABLE));
  assert.equal(failed.outcome, 'unreadable');
  assert.notEqual(failed.outcome, t.outcome);
});

test('an unrecognised intent is refused rather than coerced to the nearest one', () => {
  // Coercing would turn a model that misunderstood the task into a confident
  // classification, and the two are indistinguishable downstream.
  assert.equal(parseIntent({ intent: 'sales-opportunity', problem: 'x' }), UNREADABLE);
  assert.equal(parseIntent({ intent: 'question' }).confidence, 0, 'no problem statement, no reading');
  assert.equal(parseIntent(null), UNREADABLE);
  assert.equal(parseIntent('{"intent":"question"}'), UNREADABLE, 'a string is not a parsed object');
});

test('betting notation is not a concept', () => {
  // ⚠️ THE FIRST LIVE RUN EXTRACTED `3.5`, `1h +2.5(+102)`, `16-10-1 overall`
  // and `3&1 so far` as things a thread was "about". They are prices and
  // records: they retrieve nothing from a knowledge base, and on the gap board
  // they become entries claiming people keep asking about "3.5".
  const r = parseIntent({
    intent: 'question',
    problem: 'Unsure whether to take the first half or the full game.',
    concepts: ['3.5', '1h +2.5(+102)', '16-10-1 overall', '3&1 so far', 'line dropping', 'ats', 'broncos'],
    confidence: 0.9,
  });

  assert.deepEqual(r.concepts, ['line dropping', 'ats', 'broncos']);
});

test('concepts are deduped, trimmed and capped', () => {
  const r = parseIntent({
    intent: 'question',
    problem: 'They want to know about cashout.',
    concepts: ['Cashout', 'cashout ', 'CASHOUT', 'x', ...Array.from({ length: 20 }, (_, i) => `c${i}`)],
    confidence: 2,
  });

  assert.equal(r.concepts.filter((c) => c === 'cashout').length, 1);
  assert.ok(!r.concepts.includes('x'), 'a single character is not a concept');
  assert.ok(r.concepts.length <= 12);
  assert.equal(r.confidence, 1, 'clamped');
});
