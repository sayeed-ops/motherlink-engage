// The Covers knowledge bootstrap: the audience map, the research interchange,
// and the boundary that keeps a model's guess out of the claim ledger.
//
// The assertion this file exists for is the last one: a search-enabled model
// proposing a capability is a LEAD, and no path through the import can turn it
// into something a reply may state in public.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateClusters,
  clusterConcepts,
  isMappable,
  isRecurring,
  mapCounts,
  needIdFor,
  parseNeeds,
  buildMapPrompt,
} from '../../apps/web/src/modules/covers/conversationMap.ts';
import {
  buildResearchBrief,
  parseResearchImport,
  repairJsonQuotes,
  toCandidateAsset,
  needsCovered,
} from '../../apps/web/src/modules/covers/research.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const row = (over = {}) => ({
  postId: `p${Math.random()}`,
  itemId: 'thread-a',
  section: 'systems-strategies-79',
  outcome: 'no-asset-match',
  intent: {
    intent: 'question',
    problem: 'Wants to follow which legs of a multi have hit.',
    concepts: ['sgm tracking'],
    asksSomething: true,
  },
  ...over,
});

const withIntent = (over) => row({ intent: { ...row().intent, ...over } });

// ---------------------------------------------------------------------------
// What the map reads
// ---------------------------------------------------------------------------

test('the map reads matched posts too, not only the gaps', () => {
  // ⚠️ THE GAP BOARD'S MISTAKE, AVOIDED. buildGaps reads only `no-asset-match`,
  // because it answers "what can this client NOT do". The map answers "what does
  // this audience need", and that has the same answer whether or not an asset
  // happens to exist — a client with good coverage must not see an empty map.
  assert.equal(isMappable(row({ outcome: 'opportunity' })), true);
  assert.equal(isMappable(row({ outcome: 'no-asset-match' })), true);
});

test('a complaint is not a need', () => {
  // It leaves the marketing pipeline upstream for a reason; mining it for needs
  // is how a system decides people want to be sold to while they are furious.
  assert.equal(isMappable(row({ outcome: 'complaint' })), false);
});

test('a screened post says nothing about the audience', () => {
  assert.equal(isMappable(row({ outcome: 'screened', intent: null })), false);
});

test('nobody asking anything is not demand', () => {
  assert.equal(isMappable(withIntent({ asksSomething: false })), false);
  assert.equal(isMappable(withIntent({ intent: 'pick-sharing' })), false);
});

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

test('phrasings of one need merge; different needs do not', () => {
  const clusters = clusterConcepts([
    withIntent({ concepts: ['sgm tracking'] }),
    withIntent({ concepts: ['tracking sgm legs'] }),
    withIntent({ concepts: ['deposit bonus'] }),
  ]);

  const titles = clusters.map((c) => c.concepts.join('|'));
  assert.equal(clusters.length, 2, titles.join(' / '));
  const merged = clusters.find((c) => c.concepts.some((x) => x.includes('sgm')));
  assert.equal(merged.posts, 2);
});

test('counted by thread as well as by post', () => {
  // Twenty replies inside one argument is one conversation, not twenty pieces
  // of demand — the lesson the gap board already learned.
  const clusters = clusterConcepts([
    withIntent({ concepts: ['cashout'] }),
    withIntent({ concepts: ['cashout'] }),
    row({ itemId: 'thread-b', intent: { ...row().intent, concepts: ['cashout'] } }),
  ]);
  assert.equal(clusters[0].posts, 3);
  assert.equal(clusters[0].threads, 2);
});

test('a thin cluster is not a recurring need', () => {
  // Six credible needs beat twelve manufactured ones. The floor was raised
  // after the first wide run returned fifteen, several of which were the same
  // need under a different brand name.
  assert.equal(isRecurring({ posts: 1, threads: 1 }), false);
  assert.equal(isRecurring({ posts: 2, threads: 2 }), false, 'two threads is not yet a pattern');
  assert.equal(isRecurring({ posts: 3, threads: 3 }), true, 'across three threads it recurs');
  assert.equal(isRecurring({ posts: 4, threads: 1 }), true, 'or four posts, even in one thread');
});

test('examples come from the cluster OWN main concepts first', () => {
  // The first live map printed "Understanding line movements" evidenced by a
  // post about a missing prop, because one post lands in several clusters and
  // any of its problems could be picked.
  const clusters = clusterConcepts([
    withIntent({ concepts: ['cashout'], problem: 'About cashout.' }),
    withIntent({ concepts: ['cashout'], problem: 'Also about cashout.' }),
    row({
      itemId: 'thread-b',
      intent: { ...row().intent, concepts: ['cashout', 'something else entirely'], problem: 'About something else.' },
    }),
  ]);

  const cashout = clusters.find((c) => c.concepts.includes('cashout'));
  assert.equal(cashout.examples[0], 'About cashout.');
});

test('the counts are honest about what was read', () => {
  const counts = mapCounts([
    withIntent({ concepts: ['a thing'] }),
    row({ outcome: 'screened', intent: null }),
    row({ section: 'props-futures-15', itemId: 'thread-b' }),
  ]);
  assert.equal(counts.postsAnalysed, 3);
  assert.equal(counts.postsMappable, 2, 'the screened one is not evidence about the audience');
  assert.deepEqual(counts.sections.sort(), ['props-futures-15', 'systems-strategies-79']);
  assert.equal(counts.threads, 2);
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const cluster = (over = {}) => ({
  concepts: ['sgm tracking'],
  posts: 4,
  threads: 3,
  sections: ['props-futures-15'],
  examples: ['Wants to follow which legs have hit.'],
  intents: { question: 4 },
  ...over,
});

test('a need with no title is DROPPED, not padded into the map', () => {
  // The prompt offers an empty title as the way to reject a cluster. Honouring
  // it is what lets the map return six needs instead of twelve.
  const needs = parseNeeds(
    { needs: [{ index: 0, title: '', whatPeopleWant: 'x' }, { index: 1, title: 'Tracking multi-leg bets' }] },
    [cluster(), cluster()],
  );
  assert.equal(needs.length, 1);
  assert.equal(needs[0].title, 'Tracking multi-leg bets');
});

test('the evidence travels with the need', () => {
  const needs = parseNeeds({ needs: [{ index: 0, title: 'Tracking multi-leg bets' }] }, [cluster()]);
  assert.equal(needs[0].posts, 4);
  assert.equal(needs[0].threads, 3);
  assert.deepEqual(needs[0].sections, ['props-futures-15']);
  assert.ok(needs[0].examples.length > 0);
});

test('an out-of-range cluster index is refused, not clamped', () => {
  assert.deepEqual(parseNeeds({ needs: [{ index: 9, title: 'Invented' }] }, [cluster()]), []);
});

test('unreadable naming yields an empty map rather than throwing', () => {
  for (const raw of [null, 'nonsense', 42, {}, { needs: 'no' }]) {
    assert.deepEqual(parseNeeds(raw, [cluster()]), []);
  }
});

test('need ids are stable across rebuilds', () => {
  assert.equal(needIdFor('Tracking multi-leg bets'), 'tracking-multi-leg-bets');
  assert.equal(needIdFor('Tracking Multi-Leg Bets'), needIdFor('Tracking multi-leg bets'));
});

test('the naming prompt names no company and asks for categories', () => {
  const { system } = buildMapPrompt([cluster()]);
  assert.ok(/categories, not company names/i.test(system));
  assert.ok(/do not know who the client is/i.test(system));
});

// ---------------------------------------------------------------------------
// The brief — the client is data
// ---------------------------------------------------------------------------

const need = (over = {}) => ({
  needId: 'tracking-multi-leg-bets',
  title: 'Tracking multi-leg bets',
  whatPeopleWant: 'Follow which legs have hit and what remains.',
  phrases: ['tracking parlay legs', 'sgm progress'],
  valueAreas: ['bet trackers'],
  posts: 4,
  threads: 3,
  sections: ['props-futures-15'],
  examples: ['Wants to follow which legs have hit.'],
  concepts: ['sgm tracking'],
  ...over,
});

test('swapping the client changes only data, never code', () => {
  const a = buildResearchBrief({
    clientName: 'Northwind', clientDomain: 'northwind.example',
    needs: [need()], postsAnalysed: 200, sections: ['props-futures-15'],
  });
  const b = buildResearchBrief({
    clientName: 'Someone Else', clientDomain: 'other.example',
    needs: [need()], postsAnalysed: 200, sections: ['props-futures-15'],
  });

  assert.ok(a.includes('Northwind'));
  assert.ok(b.includes('Someone Else'));
  assert.ok(!b.includes('Northwind'), 'no client leaks between briefs');
  // Same structure, different data.
  assert.equal(
    a.replace(/Northwind|northwind\.example/g, 'X'),
    b.replace(/Someone Else|other\.example/g, 'X'),
  );
});

test('the WEBSITE leads the brief, and the researcher is told to confirm from it', () => {
  // ⚠️ THE BRIEF USED TO OPEN "Client: test project". A project name is a
  // workspace label; a domain identifies a company unambiguously.
  const brief = buildResearchBrief({
    clientName: 'Northwind', clientDomain: 'https://northwind.example',
    needs: [need()], postsAnalysed: 200, sections: ['props-futures-15'],
  });

  assert.ok(brief.includes('WEBSITE: https://northwind.example'));
  assert.ok(/confirming which company this is/i.test(brief));
  // And the website appears before the needs, not in a footnote.
  assert.ok(brief.indexOf('WEBSITE:') < brief.indexOf('NEED 1'));
});

test('with no website the brief says so rather than pretending', () => {
  const brief = buildResearchBrief({
    clientName: 'test project', clientDomain: '',
    needs: [need()], postsAnalysed: 1, sections: [],
  });
  assert.ok(/No website was supplied/i.test(brief));
  assert.ok(/researching the wrong company/i.test(brief));
});

test('the brief carries the needs, their phrases and the need ids', () => {
  const brief = buildResearchBrief({
    clientName: 'Northwind', clientDomain: '', needs: [need()],
    postsAnalysed: 200, sections: ['props-futures-15'],
  });
  assert.ok(brief.includes('Tracking multi-leg bets'));
  assert.ok(brief.includes('tracking-multi-leg-bets'), 'the id, so findings can be linked back');
  assert.ok(brief.includes('sgm progress'));
});

test('the brief says an empty answer is a correct answer', () => {
  const brief = buildResearchBrief({
    clientName: 'X', clientDomain: '', needs: [need()], postsAnalysed: 1, sections: [],
  });
  assert.ok(/NOTHING USEFUL FOR A NEED/i.test(brief));
  assert.ok(/Do not force a connection/i.test(brief));
});

test('the brief asks the reverse question too, in the same round trip', () => {
  const brief = buildResearchBrief({
    clientName: 'X', clientDomain: '', needs: [need()], postsAnalysed: 1, sections: [],
  });
  assert.ok(/the other direction/i.test(brief));
  assert.ok(/did not cause you to look for/i.test(brief));
});

// ---------------------------------------------------------------------------
// The import — and the boundary
// ---------------------------------------------------------------------------

const capability = (over = {}) => ({
  title: 'SGM Bet Tracker',
  whatItIs: 'A tool in the sportsbook.',
  whatItDoes: 'Shows each leg of a same-game multi and whether it has hit.',
  whyUseful: 'People are tracking legs by hand.',
  coversNeeds: ['tracking-multi-leg-bets'],
  conversationExamples: ['tracking parlay legs', 'sgm progress'],
  problemsSolved: ['cannot tell which legs have hit'],
  notRelevantWhen: ['single bets'],
  clientSpecificFacts: [
    { text: 'The tracker shows each leg separately.', quote: 'Each leg is shown separately.', sourceUrl: 'https://help.northwind.example/sgm' },
  ],
  sources: ['https://help.northwind.example/sgm'],
  verificationState: 'verified',
  confidence: 'high',
  notes: '',
  ...over,
});

test('a well-formed capability imports', () => {
  const r = parseResearchImport({ client: 'Northwind', capabilities: [capability()] }, ['tracking-multi-leg-bets']);
  assert.equal(r.capabilities.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.capabilities[0].verificationState, 'verified');
});

test('MODEL LEAD → CANNOT SILENTLY BECOME A CLAIM', () => {
  // ⚠️ THE REGRESSION TEST THE OPERATOR ASKED FOR. A search-enabled model's
  // confident sentence is a lead. Even when it claims to be verified, an
  // imported capability lands as a DRAFT asset that retrieval never sees, and
  // its facts stay PROPOSALS — the claim ledger is not reachable from here.
  const c = toCandidateAsset(parseResearchImport({ capabilities: [capability()] }).capabilities[0]);

  // The facts survive as proposals, for a human to verify...
  assert.equal(c.facts.length, 1);
  // ...and nothing in the candidate is a claim, or can be turned into one here.
  assert.equal('claims' in c, false);
  assert.equal('claimIds' in c, false);
  assert.equal('status' in c, false, 'status is set by the writer, and it is always draft');
});

test('claiming verification without a source is downgraded', () => {
  // "verified" with nothing to point at is not verification.
  const r = parseResearchImport({
    capabilities: [capability({ verificationState: 'verified', sources: [], clientSpecificFacts: [] })],
  });
  assert.equal(r.capabilities[0].verificationState, 'unverified');
});

test('silence about verification reads as unverified', () => {
  const c = capability();
  delete c.verificationState;
  const r = parseResearchImport({ capabilities: [c] });
  assert.equal(r.capabilities[0].verificationState, 'unverified');
});

test('a fact without a verbatim quote is dropped, not paraphrased in', () => {
  const r = parseResearchImport({
    capabilities: [capability({ clientSpecificFacts: [{ text: 'It is fast.', sourceUrl: 'https://x.example' }] })],
  });
  assert.deepEqual(r.capabilities[0].facts, []);
});

test('a fact with a non-URL source is dropped', () => {
  const r = parseResearchImport({
    capabilities: [capability({ clientSpecificFacts: [{ text: 'x', quote: 'y', sourceUrl: 'the website' }] })],
  });
  assert.deepEqual(r.capabilities[0].facts, []);
});

test('LONG conversation examples are broken into retrievable triggers', () => {
  // ⚠️ THE PHASE-1 BUG, REINTRODUCED AND THEN FOUND IN LIVE DATA. Retrieval
  // needs EVERY token of a trigger present in the post, so a sentence-shaped
  // trigger can never fire. The phase-1 importer stored whole interview
  // questions and made 64 assets unreachable; this importer mapped a
  // researcher's `conversationExamples` straight through and did it again —
  // 45 of 72 imported triggers were 3+ words, and across 863 analysed posts
  // exactly ONE matched an asset.
  const c = toCandidateAsset(parseResearchImport({ capabilities: [capability()] }).capabilities[0]);

  // "tracking parlay legs" becomes adjacent pairs; "sgm progress" is already
  // short enough to keep whole.
  assert.ok(c.triggers.includes('sgm progress'));
  assert.ok(c.triggers.includes('tracking parlay'));
  assert.ok(!c.triggers.includes('tracking parlay legs'), 'the unmatchable form is gone');
  assert.ok(c.triggers.every((t) => t.split(/\s+/).length <= 2), c.triggers.join(' | '));

  // The long form is not lost — it is a PROBLEM, which is what that field is
  // for and where a phrase can be matched against extracted concepts.
  assert.ok(c.problems.includes('tracking parlay legs'));
  assert.ok(c.problems.includes('cannot tell which legs have hit'));

  assert.deepEqual(c.exclusions, ['single bets']);
});

test('a short example is kept whole rather than mangled', () => {
  const c = toCandidateAsset(
    parseResearchImport({
      capabilities: [capability({ conversationExamples: ['offshore book', 'cashout'] })],
    }).capabilities[0],
  );
  assert.ok(c.triggers.includes('offshore book'));
  assert.ok(c.triggers.includes('cashout'));
});

test('an unknown need id is dropped rather than overstating coverage', () => {
  const r = parseResearchImport(
    { capabilities: [capability({ coversNeeds: ['tracking-multi-leg-bets', 'invented-need'] })] },
    ['tracking-multi-leg-bets'],
  );
  assert.deepEqual(r.capabilities[0].coversNeeds, ['tracking-multi-leg-bets']);
});

test('a row with no title is rejected WITH A REASON, not dropped silently', () => {
  const r = parseResearchImport({ capabilities: [capability({ title: '' }), capability()] });
  assert.equal(r.capabilities.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, 'no title');
});

test('JSON wrapped in prose or fences still parses', () => {
  const json = JSON.stringify({ capabilities: [capability()] });
  for (const wrapped of [`Here you go:\n${json}\nHope that helps!`, '```json\n' + json + '\n```']) {
    assert.equal(parseResearchImport(wrapped).capabilities.length, 1, wrapped.slice(0, 20));
  }
});

test('A STRAY QUOTE INSIDE A SENTENCE NO LONGER KILLS THE WHOLE PASTE', () => {
  // ⚠️ THE REAL FAILURE. A researcher returned seventeen good capabilities and
  // one of them contained:
  //     "quote": "The “Vault" is a secured storage solution for your funds."
  // The model opened with a curly quote and closed with a straight one, which
  // terminates the JSON string early and invalidates the entire document. All
  // seventeen were rejected for one punctuation mark in one of them.
  const broken = `{"capabilities":[
    {"title":"Stake Vault","conversationExamples":["store funds"],
     "clientSpecificFacts":[{"text":"There is a vault.",
       "quote":"The “Vault" is a secured storage solution for your funds.",
       "sourceUrl":"https://help.example.com/vault"}],
     "sources":["https://help.example.com/vault"],"verificationState":"verified"}]}`;

  assert.throws(() => JSON.parse(broken), 'the fixture really is invalid JSON');

  const r = parseResearchImport(broken);
  assert.equal(r.capabilities.length, 1);
  assert.equal(r.repaired, true, 'and the repair is reported, not hidden');
  assert.equal(r.capabilities[0].facts.length, 1, 'the quote survives the repair');
});

test('the repair only escapes quotes that CANNOT be delimiters', () => {
  // A closing quote is always followed by whitespace then , : } ] or the end.
  // Anything else is content. Valid JSON never reaches the repair at all.
  const valid = '{"a":"one","b":["two","three"],"c":{"d":"four"}}';
  assert.equal(repairJsonQuotes(valid), valid, 'valid JSON is returned untouched');

  assert.deepEqual(JSON.parse(repairJsonQuotes('{"a":"he said "hi" to me"}')), {
    a: 'he said "hi" to me',
  });
});

test('an escaped quote inside a string is left alone', () => {
  const already = '{"a":"he said \\"hi\\""}';
  assert.deepEqual(JSON.parse(repairJsonQuotes(already)), JSON.parse(already));
});

test('a trailing comma is survivable too', () => {
  const r = parseResearchImport('{"capabilities":[{"title":"A thing"},]}');
  assert.equal(r.capabilities.length, 1);
  assert.equal(r.repaired, true);
});

test('need ids the map does not have are REPORTED, not silently dropped', () => {
  // Dropping them is right — a link to a need that does not exist overstates
  // coverage — but doing it silently makes "8 of 14 covered" quietly wrong.
  const r = parseResearchImport(
    { capabilities: [capability({ coversNeeds: ['tracking-multi-leg-bets', 'invented-need'] })] },
    ['tracking-multi-leg-bets'],
  );
  assert.deepEqual(r.capabilities[0].coversNeeds, ['tracking-multi-leg-bets']);
  assert.deepEqual(r.unknownNeeds, ['invented-need']);
});

test('a totally unreadable paste explains the usual cause', () => {
  const r = parseResearchImport('this is not json at all, just prose');
  assert.equal(r.capabilities.length, 0);
  assert.ok(/quotation mark/i.test(r.rejected[0].reason), r.rejected[0].reason);
});

test('unreadable input is refused rather than throwing', () => {
  for (const raw of [null, 'not json at all', 42, {}]) {
    const r = parseResearchImport(raw);
    assert.equal(r.capabilities.length, 0);
    assert.ok(r.rejected.length > 0);
  }
});

test('coverage is computed from what was stored, not from what was claimed', () => {
  const covered = needsCovered(
    [{ coversNeeds: ['tracking-multi-leg-bets'] }, { coversNeeds: [] }],
    ['tracking-multi-leg-bets', 'understanding-cashout'],
  );
  assert.deepEqual(covered, ['tracking-multi-leg-bets']);
});

test('an unknown confidence falls to low', () => {
  const r = parseResearchImport({ capabilities: [capability({ confidence: 'certain' })] });
  assert.equal(r.capabilities[0].confidence, 'low');
});
