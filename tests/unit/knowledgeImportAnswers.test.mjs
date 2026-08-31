// Importing research that was done somewhere else.
//
// The fixture is six records cut from a REAL file an operator brought in: 80
// answered questions about Northwind, researched outside this system. It is not one
// of our own exports and does not pretend to be — its statuses say `found` where
// ours say `answered`, its answers are prose where ours are structured objects,
// and its `notFoundReason` is a sentence where ours is one of four causes. Those
// mismatches are the point: a file that already matched would need no importer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { decideDedupe } from '../../apps/web/src/modules/knowledge/interview.ts';
import { tokenise } from '../../apps/web/src/modules/knowledge/retrieval.ts';
import {
  importedAnswer,
  triggerPhrases,
  planAnswerImport,
  questionKey,
  readImportFile,
  readNotFoundReason,
  readRecord,
  readStatus,
  isWriting,
} from '../../apps/web/src/modules/knowledge/importAnswers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = JSON.parse(
  readFileSync(resolve(here, '../fixtures/knowledge/imported-answers.json'), 'utf8'),
);

const ACTOR = { uid: 'uid_sayeed', name: 'Sayeed', fileLabel: 'client-knowledge-answered.json', nowMs: 1_788_000_000_000 };

const question = (over = {}) => ({
  questionId: 'q1',
  projectId: 'p1',
  category: 'Sports Betting Features',
  question: "How does cash-out work on Northwind's sportsbook, and what conditions apply?",
  rationale: '',
  priority: 4,
  origin: 'generated',
  status: 'pending',
  review: 'none',
  answer: null,
  notFoundReason: null,
  note: '',
  sourcesRead: [],
  dedupe: null,
  assetId: null,
  provokedBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const researched = (over = {}) => ({
  shortAnswer: 'Cashout is available on selected markets.',
  assetTitle: 'Cashout availability',
  assetKind: 'help',
  problemsSolved: [],
  conversationTriggers: ['cash out'],
  notRelevantWhen: [],
  claims: [{ claim: 'Cashout is not available for Same Game Multis.', quote: 'not available for Same Game Multis', sourceUrl: 'https://help.northwind.example/x' }],
  sourceUrls: ['https://help.northwind.example/x'],
  sourceKind: 'official',
  brandAttributionHelps: true,
  complianceCaveats: [],
  confidence: 0.8,
  model: 'deepseek',
  promptVersion: 'v1',
  researchedAt: new Date(0),
  ...over,
});

// ---------------------------------------------------------------------------
// Reading a foreign file
// ---------------------------------------------------------------------------

test('a real file that is not one of our exports is read, not rejected', () => {
  const records = readImportFile(FILE);
  assert.equal(records.length, 6);

  const cashout = records.find((r) => r.question.startsWith('How does cash-out'));
  assert.equal(cashout.status, 'answered', '`found` and `answered` are the same finding');
  assert.match(cashout.answerText, /settle an eligible sports bet before the event finishes/);
  assert.deepEqual(cashout.sourcesRead, [
    'https://northwind.example/policies/sportsbook',
    'https://help.northwind.example/en/articles/4872560-why-is-cashout-not-available-for-my-bet',
  ]);
  assert.equal(cashout.category, 'Sports Betting Features');
  assert.equal(cashout.priority, 4);
});

test('an unknown status never becomes "answered" by accident', () => {
  assert.equal(readStatus('found', true), 'answered');
  assert.equal(readStatus('answered', true), 'answered');
  assert.equal(readStatus('not_found', false), 'not-found');
  assert.equal(readStatus('banana', false), 'pending', 'unrecognised and no text: pending');
  // A record with prose in `answer` and no status at all is an answer.
  assert.equal(readStatus(undefined, true), 'answered');
});

test('a prose not-found reason is kept as words, never sorted into one of the four causes', () => {
  // ⚠️ The four causes are different findings — `blocked` is work to do,
  // `not-covered` is a fact about the client. Keyword-matching somebody else's
  // sentence into one of them manufactures a signal nobody assigned.
  const record = readImportFile(FILE).find((r) => r.question.includes('changing your username'));
  assert.equal(record.status, 'not-found');
  assert.equal(record.notFoundReason, null, 'we do not know which of our four causes this was');
  assert.match(record.note, /No official public documentation found/);

  // An exact enum value IS kept.
  assert.deepEqual(readNotFoundReason('blocked'), { reason: 'blocked', note: '' });
  assert.deepEqual(readNotFoundReason('not covered'), { reason: 'not-covered', note: '' });
});

test('a record with no real question is dropped rather than imported as an empty row', () => {
  assert.equal(readRecord({ answer: 'lots of detail', status: 'found' }), null);
  assert.equal(readRecord({ question: 'why?' }), null);
  assert.equal(readRecord(null), null);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('a question we do not have arrives with its answer', () => {
  const plan = planAnswerImport([], readImportFile(FILE));
  const cashout = plan.rows.find((r) => r.question.startsWith('How does cash-out'));

  assert.equal(cashout.decision, 'add-answered');
  assert.deepEqual(cashout.choices, ['add-answered', 'add', 'skip']);
  assert.equal(cashout.existing, null);
});

test('a question we have but never answered defaults to taking the answer', () => {
  const plan = planAnswerImport([question()], readImportFile(FILE));
  const cashout = plan.rows.find((r) => r.question.startsWith('How does cash-out'));

  assert.equal(cashout.decision, 'fill');
  assert.deepEqual(cashout.choices, ['fill', 'skip']);
  assert.equal(cashout.existing.questionId, 'q1');
  assert.match(cashout.reason, /unanswered/);
});

test('an answer we already researched is NEVER overwritten by default', () => {
  // Ours was researched against pages this server read, with quotes checked.
  // Theirs was not. Replacing it silently would be a downgrade dressed as an
  // import — so the default is keep, and the row says what replacing would cost.
  const plan = planAnswerImport([question({ status: 'answered', answer: researched() })], readImportFile(FILE));
  const cashout = plan.rows.find((r) => r.question.startsWith('How does cash-out'));

  assert.equal(cashout.decision, 'keep');
  assert.deepEqual(cashout.choices, ['keep', 'replace', 'skip']);
  assert.equal(cashout.losesEvidence, true, 'ours carries a quote-checked claim');
  assert.match(cashout.reason, /1 quote-checked claim/);
  assert.equal(cashout.existing.answerText, 'Cashout is available on selected markets.');
  assert.equal(cashout.existing.claimCount, 1);
});

test('replacing an answer that carries no claims is not flagged as losing evidence', () => {
  const noClaims = question({ status: 'answered', answer: researched({ claims: [] }) });
  const plan = planAnswerImport([noClaims], readImportFile(FILE));
  const cashout = plan.rows.find((r) => r.question.startsWith('How does cash-out'));

  assert.equal(cashout.decision, 'keep');
  assert.equal(cashout.losesEvidence, false);
  assert.ok(cashout.choices.includes('replace'));
});

test('an exact duplicate is skipped', () => {
  const records = readImportFile(FILE);
  const cashout = records.find((r) => r.question.startsWith('How does cash-out'));
  const mirror = question({
    status: 'answered',
    answer: researched({ shortAnswer: cashout.answerText, claims: [] }),
    sourcesRead: cashout.sourcesRead,
  });

  const plan = planAnswerImport([mirror], records);
  const row = plan.rows.find((r) => r.question.startsWith('How does cash-out'));
  assert.equal(row.decision, 'skip');
  assert.match(row.reason, /Identical/);
});

test('a question already here that the file does not answer adds nothing', () => {
  const records = [readRecord({ question: 'How does cash-out work on Northwind’s sportsbook?', status: 'pending' })];
  const plan = planAnswerImport(
    [question({ question: 'How does cash-out work on Northwind’s sportsbook?' })],
    records,
  );
  assert.equal(plan.rows[0].decision, 'skip');
  assert.match(plan.rows[0].reason, /adds nothing/);
});

test('the same question WORD FOR WORD twice in one file is imported once', () => {
  const twice = readImportFile({
    questions: [
      { question: 'What are the withdrawal limits?', status: 'found', answer: 'No maximum.' },
      { question: 'What are the withdrawal limits?', status: 'found', answer: 'Different wording, same question.' },
    ],
  });

  const plan = planAnswerImport([], twice);
  assert.equal(plan.rows[0].decision, 'add-answered', 'the first one wins');
  assert.equal(plan.rows[1].decision, 'skip');
  // Shown as a skipped row rather than silently dropped: a file that quietly
  // lost half its records would look like a successful import.
  assert.match(plan.rows[1].reason, /appears earlier in this file/);
});

test('three ways of asking about void bets are three questions, and that is deliberate', () => {
  // ⚠️ A REAL PROPERTY OF THE REAL FILE, not a gap. The questionnaire generator
  // produced the same subject three times across categories, worded differently
  // each time. Matching is exact, so all three import — because deciding that a
  // paraphrase is the same question is a judgement, and it is made later against
  // ANSWERS, where a shared source URL is near-proof they landed on one page.
  const plan = planAnswerImport([], readImportFile(FILE));
  const voids = plan.rows.filter((r) => r.question.toLowerCase().includes('void bets'));

  assert.equal(voids.length, 3);
  assert.ok(voids.every((r) => r.decision === 'add-answered'));
  assert.equal(new Set(voids.map((r) => r.key)).size, 3, 'three distinct keys');
});

test('the counts add up to the rows, so the summary cannot overstate the import', () => {
  const plan = planAnswerImport([question()], readImportFile(FILE));
  const total = Object.values(plan.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, plan.rows.length);
});

// ---------------------------------------------------------------------------
// What an imported answer is allowed to be
// ---------------------------------------------------------------------------

test('an imported answer carries NO claims, whatever the file says', () => {
  const record = readRecord({
    question: 'What are the withdrawal limits?',
    status: 'found',
    answer: {
      shortAnswer: 'There is no maximum crypto withdrawal.',
      assetTitle: 'Withdrawal limits',
      assetKind: 'help',
      claims: [{ claim: 'No maximum', quote: 'there is no maximum', sourceUrl: 'https://help.northwind.example/x' }],
      sourceUrls: ['https://help.northwind.example/x'],
    },
  });

  const answer = importedAnswer(record, ACTOR);
  assert.deepEqual(answer.claims, [], 'a quote nobody here checked is not evidence');
  assert.equal(answer.answerSource, 'imported');
  assert.equal(answer.confidence, 0, 'a confidence we did not measure is not invented');
  assert.equal(answer.model, '');
  assert.equal(answer.promptVersion, 'imported');
  assert.equal(answer.importedByName, 'Sayeed');
  assert.equal(answer.importedFrom, 'client-knowledge-answered.json');
});

test('an imported answer gets SHORT triggers, never the whole question', () => {
  // ⚠️ THE FIRST VERSION STORED THE QUESTION WHOLE, and every imported asset was
  // therefore unretrievable — retrieval requires every token of a trigger to be
  // present, and no forum post contains a whole interview question. A live run
  // found it: a post about deposit bonuses matched nothing in a library holding
  // several assets about deposit bonuses.
  const record = readImportFile(FILE).find((r) => r.question.startsWith('How does cash-out'));
  const answer = importedAnswer(record, ACTOR);

  assert.ok(answer.conversationTriggers.length > 0, 'an asset with no triggers is inert');
  assert.ok(
    !answer.conversationTriggers.includes(record.question),
    'the question itself is never a trigger',
  );
  assert.ok(
    answer.conversationTriggers.every((t) => t.split(/\s+/).length <= 2),
    `expected short phrases, got ${JSON.stringify(answer.conversationTriggers)}`,
  );
  // The fields a model proposes and a person confirms stay empty rather than
  // being invented — notRelevantWhen above all, being the only veto.
  assert.deepEqual(answer.problemsSolved, []);
  assert.deepEqual(answer.notRelevantWhen, []);
  assert.equal(answer.brandAttributionHelps, false);
  assert.deepEqual(answer.sourceUrls, record.sourcesRead);
});

test('a title is derived from the question as a placeholder, not left blank', () => {
  const record = readImportFile(FILE).find((r) => r.question.includes('In which countries'));
  const answer = importedAnswer(record, ACTOR);
  assert.ok(answer.assetTitle.length > 0);
  assert.ok(!answer.assetTitle.endsWith('?'));
  assert.ok(answer.assetTitle.length <= 90);
});

test('only the decisions that add information write anything', () => {
  assert.equal(isWriting('add'), true);
  assert.equal(isWriting('add-answered'), true);
  assert.equal(isWriting('fill'), true);
  assert.equal(isWriting('replace'), true);
  assert.equal(isWriting('keep'), false);
  assert.equal(isWriting('skip'), false);
});

// ---------------------------------------------------------------------------
// Approving the whole queue without minting a duplicate per question
// ---------------------------------------------------------------------------

test('three ways of asking about void bets approve into ONE asset, not three', () => {
  // ⚠️ THE REASON BULK APPROVE CHECKS AGAINST A LIBRARY THAT GROWS AS IT RUNS.
  // The real file asks about void bets three times, in three categories, all
  // citing the same two pages. Approved one at a time against a FIXED snapshot
  // of the library, that is three assets for one page — and retrieval then
  // returns three near-identical matches and spends the prompt budget repeating
  // itself.
  const voids = readImportFile(FILE)
    .filter((r) => r.question.toLowerCase().includes('void bets'))
    .map((r) => importedAnswer(r, ACTOR));

  assert.equal(voids.length, 3);

  // The library as this run builds it.
  const library = [];
  const outcomes = voids.map((answer) => {
    const verdict = decideDedupe(answer, library);
    if (verdict.action === 'new') {
      library.push({
        assetId: `asset_${library.length}`,
        title: answer.assetTitle,
        sourceUrl: answer.sourceUrls[0] ?? '',
        triggers: answer.conversationTriggers,
      });
    }
    return verdict.action;
  });

  assert.equal(outcomes[0], 'new', 'the first one creates the asset');
  assert.ok(outcomes.slice(1).every((a) => a !== 'new'), 'the rest fold into it');
  assert.equal(library.length, 1);
});

test('answers about different pages still get their own assets', () => {
  const records = readImportFile(FILE);
  const cashout = importedAnswer(records.find((r) => r.question.startsWith('How does cash-out')), ACTOR);
  const countries = importedAnswer(records.find((r) => r.question.includes('In which countries')), ACTOR);

  const library = [
    {
      assetId: 'asset_0',
      title: cashout.assetTitle,
      sourceUrl: cashout.sourceUrls[0],
      triggers: cashout.conversationTriggers,
    },
  ];

  // Different first source URL, different wording: nothing to fold into.
  assert.equal(decideDedupe(countries, library).action, 'new');
});

test('an answer with no sources at all cannot be folded into something by accident', () => {
  // The not-found row in the fixture read no pages. An empty source URL must not
  // match an asset whose source URL is also empty.
  const record = readImportFile(FILE).find((r) => r.question.includes('changing your username'));
  const answer = importedAnswer(record, ACTOR);
  assert.deepEqual(answer.sourceUrls, []);

  const verdict = decideDedupe(answer, [
    { assetId: 'a', title: 'Something else', sourceUrl: '', triggers: ['unrelated phrase'] },
  ]);
  assert.equal(verdict.action, 'new');
});

// ---------------------------------------------------------------------------
// Trigger derivation
// ---------------------------------------------------------------------------

test('a question becomes phrases a forum post might actually contain', () => {
  const t = triggerPhrases(
    'What types of bonuses does Northwind offer, and what are the wagering requirements?',
    'Northwind',
  );

  assert.ok(t.includes('wagering requirements'), JSON.stringify(t));
  assert.ok(t.some((p) => p.includes('bonus')), JSON.stringify(t));
  // The client's own name is dropped: a trigger containing it would only fire on
  // posts that already name them, which is the case needing no help.
  assert.ok(!t.some((p) => p.includes('northwind')), JSON.stringify(t));
  // Scaffolding is gone.
  assert.ok(!t.some((p) => /\b(what|does|and|are|the)\b/.test(p)), JSON.stringify(t));
});

test('the derived triggers actually retrieve the post they were derived for', () => {
  // The end-to-end claim, in one assertion: an imported answer about deposit
  // bonuses must match a forum post asking about deposit bonuses.
  const record = readRecord({
    question: 'What is a deposit bonus requirement, and how is it calculated?',
    status: 'found',
    answer: 'A deposit bonus requirement is a multiplier applied to the deposit plus bonus.',
    sourcesRead: ['https://help.northwind.example/deposit-bonus'],
  });
  const answer = importedAnswer(record, ACTOR);

  const post = 'Do DraftKings or FanDuel still offer decent deposit bonuses for existing customers?';
  const tokens = new Set(tokenise(post));
  const fires = answer.conversationTriggers.filter((trigger) =>
    tokenise(trigger).every((tok) => tokens.has(tok)),
  );

  assert.ok(fires.length > 0, `no trigger fired: ${JSON.stringify(answer.conversationTriggers)}`);
});
