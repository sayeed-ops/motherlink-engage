// The deep client interview: not duplicating what we already know, and being
// honest about what we could not find.
//
// Three things here decide whether the questionnaire is worth running:
//
//   DEDUPE — a hundred questions circle the same dozen features. If this is
//   wrong, approving the queue creates five assets for one page and retrieval
//   then returns five near-identical hits.
//
//   NOT FOUND — a researcher that always finds something has learned nothing;
//   it has laundered the model's priors into a knowledge base with the client's
//   name on it.
//
//   QUOTE CHECKING ACROSS SEVERAL PAGES — research reads three pages at once, so
//   a claim can cite a page that was never actually supplied.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coverage,
  decideDedupe,
  keywords,
  nextToResearch,
  rankCorpus,
} from '../../apps/web/src/modules/knowledge/interview.ts';
import {
  parseQuestions,
  parseResearch,
} from '../../apps/web/src/modules/knowledge/interviewPrompts.ts';
import { normaliseForMatch } from '../../apps/web/src/modules/knowledge/extract.ts';

// ── question generation ────────────────────────────────────────────────────

test('questions and categories parse, with sane defaults', () => {
  const out = parseQuestions({
    categories: ['Cashout', 'Withdrawals'],
    questions: [
      { category: 'Cashout', question: 'Why can a cashout offer disappear mid-game?', rationale: 'r', priority: 5 },
      { question: 'What does the company document about payout times?' },
    ],
  });
  assert.deepEqual(out.categories, ['Cashout', 'Withdrawals']);
  assert.equal(out.questions.length, 2);
  assert.equal(out.questions[1].category, 'General', 'a question with no category still counts');
  assert.equal(out.questions[1].priority, 3);
});

test('a model repeating itself does not produce two research tasks', () => {
  // Asked for a hundred questions, a model repeats itself somewhere in the
  // eighties. Catching it here means the operator never sees the same task
  // twice and never pays to research it twice.
  const out = parseQuestions({
    questions: [
      { question: 'Why can a cashout disappear?' },
      { question: 'why can a cashout disappear' },
      { question: 'Why can a cashout disappear???' },
    ],
  });
  assert.equal(out.questions.length, 1);
});

test('junk questions are dropped rather than filed', () => {
  const out = parseQuestions({ questions: [{ question: 'huh' }, { question: '' }, { notAQuestion: 1 }] });
  assert.equal(out.questions.length, 0);
});

test('an unusable response is empty rather than throwing', () => {
  assert.deepEqual(parseQuestions(null), { categories: [], questions: [] });
  assert.deepEqual(parseQuestions({ questions: 'no' }).questions, []);
});

// ── researching one question ───────────────────────────────────────────────

const SOURCES = [
  {
    url: 'https://northwind.example/help/cashout',
    title: 'Cashout',
    text: 'Cashout may become unavailable if the market is suspended. Availability depends on the market.',
  },
  {
    url: 'https://northwind.example/help/withdrawals',
    title: 'Withdrawals',
    text: 'Withdrawal requests are usually processed within twenty four hours of approval.',
  },
];

const answer = (over = {}) => ({
  found: true,
  shortAnswer: 'Cashout can vanish when a market suspends.',
  assetTitle: 'Cashout availability',
  assetKind: 'help',
  problemsSolved: ['cashout disappeared'],
  conversationTriggers: ['cashout button gone'],
  notRelevantWhen: ['bank transfer questions'],
  claims: [],
  brandAttributionHelps: true,
  complianceCaveats: [],
  confidence: 0.9,
  ...over,
});

test('a claim quoted from a supplied page is kept, and keeps THAT page as its source', () => {
  const out = parseResearch(
    answer({
      claims: [
        {
          claim: 'Cashout can become unavailable when the market suspends.',
          quote: 'Cashout may become unavailable if the market is suspended.',
          // The model attributed it to the wrong page. The text decides.
          sourceUrl: 'https://northwind.example/help/withdrawals',
        },
      ],
    }),
    SOURCES,
    normaliseForMatch,
  );
  assert.equal(out.found, true);
  assert.equal(out.answer.claims.length, 1);
  assert.equal(
    out.answer.claims[0].sourceUrl,
    'https://northwind.example/help/cashout',
    'the page the sentence is actually on wins over the one the model named',
  );
});

test('a claim quoted from no supplied page is dropped', () => {
  const out = parseResearch(
    answer({
      claims: [
        {
          claim: 'Withdrawals are instant.',
          quote: 'All withdrawals are processed instantly, every single time.',
          sourceUrl: 'https://northwind.example/help/withdrawals',
        },
      ],
    }),
    SOURCES,
    normaliseForMatch,
  );
  assert.equal(out.answer.claims.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /not on any of the pages/i);
});

test('a quote from ANOTHER supplied page is fine — research reads several at once', () => {
  const out = parseResearch(
    answer({
      claims: [
        {
          claim: 'Withdrawals take about a day.',
          quote: 'Withdrawal requests are usually processed within twenty four hours of approval.',
          sourceUrl: 'https://northwind.example/help/withdrawals',
        },
      ],
    }),
    SOURCES,
    normaliseForMatch,
  );
  assert.equal(out.answer.claims.length, 1);
});

test('NOT FOUND is a first-class answer and carries its reason', () => {
  const out = parseResearch({ found: false, note: 'Nothing on these pages covers verification.' }, SOURCES, normaliseForMatch);
  assert.equal(out.found, false);
  assert.equal(out.answer, null);
  assert.match(out.note, /verification/);
});

test('an answer missing its essentials is treated as not found, not as a partial answer', () => {
  assert.equal(parseResearch(answer({ assetTitle: '' }), SOURCES, normaliseForMatch).found, false);
  assert.equal(parseResearch(answer({ shortAnswer: '' }), SOURCES, normaliseForMatch).found, false);
  assert.equal(parseResearch('nonsense', SOURCES, normaliseForMatch).found, false);
});

test('confidence is clamped to 0-1 rather than believed', () => {
  assert.equal(parseResearch(answer({ confidence: 7 }), SOURCES, normaliseForMatch).answer.confidence, 1);
  assert.equal(parseResearch(answer({ confidence: -1 }), SOURCES, normaliseForMatch).answer.confidence, 0);
  assert.equal(parseResearch(answer({ confidence: 'high' }), SOURCES, normaliseForMatch).answer.confidence, 0.5);
});

test('brandAttributionHelps defaults to false when the model omits it', () => {
  const out = parseResearch(answer({ brandAttributionHelps: undefined }), SOURCES, normaliseForMatch);
  assert.equal(out.answer.brandAttributionHelps, false);
});

// ── not creating five assets for one feature ───────────────────────────────

const existing = [
  {
    assetId: 'a-cashout',
    title: 'Cashout availability',
    sourceUrl: 'https://northwind.example/help/cashout',
    triggers: ['cashout button gone', 'cashout disappeared'],
  },
  {
    assetId: 'a-withdrawals',
    title: 'Withdrawal times',
    sourceUrl: 'https://northwind.example/help/withdrawals',
    triggers: ['how long do withdrawals take'],
  },
];

test('an answer from a page the library already has is a duplicate', () => {
  const verdict = decideDedupe(
    {
      sourceUrls: ['https://northwind.example/help/cashout'],
      conversationTriggers: ['cashout button gone', 'cashout disappeared'],
      assetTitle: 'Cashout availability',
    },
    existing,
  );
  assert.equal(verdict.action, 'duplicate');
  assert.equal(verdict.assetId, 'a-cashout');
});

test('a different angle on the same page is an update, not a new asset', () => {
  // This is the case the whole function exists for: "can I see why my cashout
  // vanished" and "will a cashout offer stay available" are two questions about
  // one page, and they must not become two assets.
  const verdict = decideDedupe(
    {
      sourceUrls: ['https://northwind.example/help/cashout'],
      conversationTriggers: ['will this cashout still be there later'],
      assetTitle: 'Cashout persistence',
    },
    existing,
  );
  assert.equal(verdict.action, 'update');
  assert.equal(verdict.assetId, 'a-cashout');
});

test('a genuinely new subject is new', () => {
  const verdict = decideDedupe(
    {
      sourceUrls: ['https://northwind.example/help/verification'],
      conversationTriggers: ['kyc documents rejected'],
      assetTitle: 'Account verification',
    },
    existing,
  );
  assert.equal(verdict.action, 'new');
  assert.equal(verdict.assetId, null);
});

test('the same page under a trailing slash or www is still the same page', () => {
  const verdict = decideDedupe(
    {
      sourceUrls: ['https://www.northwind.example/help/cashout/'],
      conversationTriggers: ['cashout gone'],
      assetTitle: 'Cashout',
    },
    existing,
  );
  assert.equal(verdict.assetId, 'a-cashout');
});

test('an empty library always says new', () => {
  const verdict = decideDedupe(
    { sourceUrls: ['https://northwind.example/x'], conversationTriggers: ['x'], assetTitle: 'X' },
    [],
  );
  assert.equal(verdict.action, 'new');
});

// ── choosing what to read ──────────────────────────────────────────────────

const corpus = [
  { url: 'https://northwind.example/help/cashout', anchors: ['Why did my cashout disappear?'] },
  { url: 'https://northwind.example/help/withdrawals', anchors: ['How long do withdrawals take?'] },
  { url: 'https://northwind.example/blog/nfl-preview', anchors: ['NFL week 1 preview'] },
];

test('the pages ranked for a question are the ones about it', () => {
  const ranked = rankCorpus('If a bettor asks why their cashout disappeared, what does the company say?', corpus, 2);
  assert.equal(ranked[0].url, 'https://northwind.example/help/cashout');
});

test('a question about something the site does not cover ranks nothing', () => {
  // Which becomes NOT FOUND rather than an answer from a loosely related page.
  assert.deepEqual(rankCorpus('What does the company say about hot air balloons?', corpus), []);
});

test('a URL path match outranks an anchor match', () => {
  const ranked = rankCorpus('withdrawals', corpus, 3);
  assert.equal(ranked[0].url, 'https://northwind.example/help/withdrawals');
});

test('keywords drop the question scaffolding and keep the subject', () => {
  const terms = keywords('What does the company officially say about cashout availability?');
  assert.ok(terms.includes('cashout'));
  assert.ok(terms.includes('availability'));
  for (const noise of ['what', 'does', 'the', 'say', 'about', 'officially']) {
    assert.ok(!terms.includes(noise), `"${noise}" should have been dropped`);
  }
});

// ── coverage ───────────────────────────────────────────────────────────────

const q = (category, status, review = 'none', notFoundReason = null) => ({
  category,
  status,
  review,
  notFoundReason,
});

test('coverage counts each category and puts the weakest first', () => {
  const rows = coverage([
    q('Cashout', 'answered', 'approved'),
    q('Cashout', 'answered', 'approved'),
    q('Verification', 'not-found'),
    q('Verification', 'pending'),
    q('Withdrawals', 'answered', 'pending'),
  ]);
  assert.equal(rows[0].category, 'Verification', 'nothing approved yet, so it needs attention most');
  assert.equal(rows[0].notFound, 1);
  assert.equal(rows[0].pending, 1);
  assert.equal(rows.at(-1).category, 'Cashout');
  assert.equal(rows.at(-1).approved, 2);
});

test('a category where everything came back NOT FOUND is visible, not hidden', () => {
  // That is a finding about the client — either they do not publish it, or the
  // pages that would answer it are behind the block.
  const rows = coverage([q('Verification', 'not-found'), q('Verification', 'not-found')]);
  assert.equal(rows[0].notFound, 2);
  assert.equal(rows[0].answered, 0);
});

test('research is ordered by priority, and only touches pending questions', () => {
  const questions = [
    { questionId: 'c', category: 'A', status: 'answered', priority: 5 },
    { questionId: 'a', category: 'A', status: 'pending', priority: 2 },
    { questionId: 'b', category: 'A', status: 'pending', priority: 5 },
  ];
  assert.deepEqual(nextToResearch(questions, 5).map((x) => x.questionId), ['b', 'a']);
});

// ── telling "they do not publish it" from "they blocked us" ────────────────
//
// These are opposite findings and the first run collapsed them into one
// message, which made forty rows unreadable. One is a fact about the client and
// the point of the exercise; the other is a fact about our access and has a fix.

test('a blocked category is counted separately from a silent one', () => {
  const rows = coverage([
    q('Cashout', 'not-found', 'none', 'blocked'),
    q('Cashout', 'not-found', 'none', 'blocked'),
    q('Verification', 'not-found', 'none', 'not-covered'),
  ]);
  const cashout = rows.find((r) => r.category === 'Cashout');
  const verification = rows.find((r) => r.category === 'Verification');

  assert.equal(cashout.blocked, 2, 'both of these measured our access, not the client');
  assert.equal(cashout.notFound, 2);
  assert.equal(verification.blocked, 0, 'this one really is a gap in what they publish');
  assert.equal(verification.notFound, 1);
});

test('a not-found with no reason recorded does not count as blocked', () => {
  // Questions researched before the reason existed. Defaulting them to blocked
  // would invent an access problem that was never observed.
  const rows = coverage([q('Old', 'not-found')]);
  assert.equal(rows[0].notFound, 1);
  assert.equal(rows[0].blocked, 0);
});
