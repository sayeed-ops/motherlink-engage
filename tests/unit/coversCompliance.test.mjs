// The compliance gate and the selection.
//
// ════════════════════════════════════════════════════════════════════════════
// THE BRAND-MENTIONED PATH IS EXERCISED HERE, ON FIXTURE CLAIMS
//
// It cannot be exercised against the live client: that library has ZERO claims,
// because imported answers carry none by design, so every brand-mentioned draft
// there would fail at the same first hurdle and prove only that the hurdle
// exists. That would leave the most dangerous path in the system — the one that
// names a regulated client in public and states facts about them — verified by
// reading it.
//
// So the claims below are fixtures, and they cover the whole path: a live claim
// backing a stated fact and passing, an EXPIRED claim failing as `dead-claim`, a
// number with nothing behind it failing as `unbacked-assertion`, a cited id that
// was never offered, the section that forbids promotion, the mention ceiling,
// the disclosure flag, and the evidence trail that comes out the other end.
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCompliance,
  inventedExperience,
  BRAND_MENTION_CEILING,
} from '../../apps/web/src/modules/covers/compliance.ts';
import {
  dropBeforeCritic,
  fromCritic,
  noneFromDrops,
  parseCriticVerdict,
  soleSurvivor,
  buildCriticPrompt,
} from '../../apps/web/src/modules/covers/selectVariant.ts';
import { DEFAULT_FLOORS } from '../../apps/web/src/modules/covers/score.ts';
import { profileSection, targetLength } from '../../apps/web/src/modules/covers/register.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECTIONS = [
  { slug: 'nfl-betting-21', name: 'NFL Betting', roles: ['watch', 'reply'], sport: 'nfl' },
  { slug: 'website-promotions-9', name: 'Website Promotions', roles: ['watch', 'reply', 'promote'], sport: null },
];

// Six posts of ordinary forum prose, so the length band is realistic rather
// than degenerate. Register is MEASURED here exactly as it is in production.
const POSTS = [
  { body: 'anyone know why cash out vanished on my ticket last night it was there the whole first half and then gone' },
  { body: 'happens to me constantly and i have never worked out why it goes away like that' },
  { body: 'same here honestly thought it was just my connection playing up again' },
  { body: 'i had it on a live bet at half time and it just went, came back later' },
  { body: 'annoying when it happens on a big one you actually wanted to take' },
  { body: 'yeah it usually comes back after a bit in my experience of it' },
];

const REGISTER = profileSection(POSTS);
const LENGTH = targetLength(REGISTER);

const LIVE_CLAIM = {
  claimId: 'c1',
  text: 'Cashout is withdrawn while a market is suspended and returns when the market reopens.',
  sourceUrl: 'https://help.northwind.example/cashout',
  assetId: 'a1',
  assetTitle: 'Cashout availability',
  live: true,
};

const EXPIRED_CLAIM = {
  claimId: 'c2',
  text: 'Withdrawals are processed within 24 hours for verified accounts.',
  sourceUrl: 'https://help.northwind.example/withdrawals',
  assetId: 'a2',
  assetTitle: 'Withdrawal times',
  live: false,
};

const ctx = (over = {}) => ({
  section: 'website-promotions-9',
  sections: SECTIONS,
  register: REGISTER,
  length: LENGTH,
  claims: [LIVE_CLAIM, EXPIRED_CLAIM],
  brandNames: ['Northwind'],
  jurisdiction: { prohibited: [], licensed: [] },
  threadText: 'cash out disappearing mid game\nwhy does cash out vanish during a game',
  disclosureWording: '',
  ...over,
});

const draft = (over = {}) => ({
  kind: 'brand-mentioned',
  text: '',
  words: 0,
  claimIds: [],
  ...over,
});

const withText = (over) => {
  const d = draft(over);
  return { ...d, words: d.text.trim().split(/\s+/).filter(Boolean).length };
};

// ---------------------------------------------------------------------------
// Brand-mentioned: the whole path, on fixture claims
// ---------------------------------------------------------------------------

test('brand-mentioned PASSES when a live claim backs the fact it states', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is usually what people are seeing.',
    claimIds: ['c1'],
  });

  const result = checkCompliance(d, ctx());

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.failures.length, 0);
});

test('and the evidence trail comes out with the claim and its source URL', () => {
  // Requirement: a reviewer must be able to see WHY the system believed the
  // statement was safe to make, beside the statement.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is usually what people are seeing.',
    claimIds: ['c1'],
  });

  const { evidence } = checkCompliance(d, ctx());

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].claimId, 'c1');
  assert.equal(evidence[0].sourceUrl, LIVE_CLAIM.sourceUrl);
  assert.equal(evidence[0].assetTitle, 'Cashout availability');
  assert.equal(evidence[0].live, true);
});

test('an EXPIRED claim fails as dead-claim, distinct from having no claim at all', () => {
  // The two have completely different fixes: re-verify a page, versus write a
  // different reply. Collapsing them into one code would hide which.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind processes withdrawals within 24 hours for verified accounts, so it should land today.',
    claimIds: ['c2'],
  });

  const result = checkCompliance(d, ctx());

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'dead-claim'));
});

test('a stated number with nothing behind it fails as unbacked-assertion', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind settles about 92% of these within 5 minutes, so give it a moment before you worry.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'unbacked-assertion'));
  // And the assertion is recorded with no backing, so the screen can show the
  // sentence rather than only the verdict.
  assert.ok(result.assertions.some((a) => a.backedBy === null));
});

test('citing a claim id that was never offered is refused', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is what you saw.',
    claimIds: ['c1', 'c99'],
  });

  const result = checkCompliance(d, ctx());
  assert.ok(result.failures.some((f) => f.code === 'dead-claim' && f.detail.includes('c99')));
});

test('citing an UNRELATED live claim does not launder an unbacked number', () => {
  // The declared id is the model's word; the overlap check is the check on it.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind refunds around 40% of suspended tickets automatically, so you are covered there.',
    claimIds: ['c1'],
  });

  const result = checkCompliance(d, ctx());
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'unbacked-assertion'));
});

test('a section that forbids promotion fails brand-mentioned even with a good claim', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is what you saw.',
    claimIds: ['c1'],
  });

  const result = checkCompliance(d, ctx({ section: 'nfl-betting-21' }));
  assert.ok(result.failures.some((f) => f.code === 'section-forbids-promotion'));
});

test('a brand-mentioned reply that never names the client is refused', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Cashout goes when a market is suspended and comes back when the market reopens, that is all it is.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());
  assert.ok(result.failures.some((f) => f.code === 'brand-absent'));
});

test('naming the client more than once trips the frequency ceiling', () => {
  assert.equal(BRAND_MENTION_CEILING, 1);
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout when a market suspends. Northwind brings it back when the market reopens again.',
    claimIds: ['c1'],
  });

  const result = checkCompliance(d, ctx());
  assert.ok(result.failures.some((f) => f.code === 'brand-frequency'));
});

test('the disclosure flag is raised, and never applied silently', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is what you saw.',
    claimIds: ['c1'],
  });

  const wording = 'Posted on behalf of Northwind.';
  const result = checkCompliance(d, ctx({ disclosureWording: wording }));

  assert.equal(result.disclosure.required, true);
  assert.equal(result.disclosure.wording, wording);
  // The text is untouched — a reviewer approves what gets posted.
  assert.ok(!result.evidence.some((e) => e.text.includes(wording)));
  assert.equal(d.text.includes(wording), false);
});

test('no disclosure wording configured means no flag, not invented standard text', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pulls cashout while a market is suspended and it returns when the market reopens, which is what you saw.',
    claimIds: ['c1'],
  });
  assert.equal(checkCompliance(d, ctx()).disclosure.required, false);
});

test('a QUALITATIVE claim about the client needs backing too, not just a number', () => {
  // ⚠️ THE LIVE RUN FOUND THIS. "Northwind still runs reload bonuses for
  // existing customers, claimed from the promotions page without a code"
  // reported "states no facts" and passed clean: extractClaims only flags
  // sentences carrying a NUMBER or an appeal to authority, and that sentence is
  // plain prose. It is also a precise assertion about a regulated client's
  // product, published under their name — exactly what the claim ledger exists
  // for. Naming the client and saying something IS the assertion.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind still runs reload bonuses for existing customers, claimed from the promotions page without a code.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'unbacked-brand-claim'));
  assert.ok(result.assertions.some((a) => a.backedBy === null));
});

test('and it PASSES when a live claim actually covers it', () => {
  const claim = {
    claimId: 'c3',
    text: 'Reload bonuses are offered to existing customers and are claimed from the promotions page without a code.',
    sourceUrl: 'https://help.northwind.example/bonuses',
    assetId: 'a3',
    assetTitle: 'Reload bonus eligibility',
    live: true,
  };

  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind still runs reload bonuses for existing customers, claimed from the promotions page without a code.',
    claimIds: ['c3'],
  });

  const result = checkCompliance(d, ctx({ claims: [claim] }));

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  // And the sentence now appears in the evidence trail, backed, rather than as
  // "nothing that needs a claim behind it".
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].backedBy, 'c3');
  assert.equal(result.evidence[0].sourceUrl, claim.sourceUrl);
});

test('an unrelated live claim cannot back a qualitative brand claim either', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind pays out same day on every card withdrawal, which is faster than most.',
    claimIds: ['c1'],
  });

  const result = checkCompliance(d, ctx());
  assert.ok(result.failures.some((f) => f.code === 'unbacked-brand-claim'));
});

test('one sentence is not reported twice under two codes', () => {
  // A numeric sentence that also names the client is handled by the numeric
  // path; the brand path skips what has already been recorded.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind settles about 92% of these within 5 minutes, so give it a moment.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());
  assert.equal(result.assertions.length, 1);
  assert.ok(result.failures.some((f) => f.code === 'unbacked-assertion'));
  assert.ok(!result.failures.some((f) => f.code === 'unbacked-brand-claim'));
});

// ---------------------------------------------------------------------------
// The other two variants
// ---------------------------------------------------------------------------

test('brand-informed naming the client is refused', () => {
  const d = withText({
    kind: 'brand-informed',
    text: 'Northwind pulls cashout while a market is suspended, so that is probably what happened here.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());
  assert.ok(result.failures.some((f) => f.code === 'brand-named'));
});

test('brand-informed stating a client-specific fact is refused as unattributed', () => {
  // The plan's rule made mechanical: the same claim with the source hidden is
  // worse than naming them, not better.
  const d = withText({
    kind: 'brand-informed',
    text: 'Cashout is withdrawn while a market is suspended and returns when the market reopens, within 30 seconds.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx());
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'unattributed-proprietary'));
});

// ---------------------------------------------------------------------------
// The laundering rule — the exact sentence the live run selected
// ---------------------------------------------------------------------------

const BONUS_CLAIM = {
  claimId: 'c3',
  text: 'Reload bonuses are offered to existing customers and are claimed from the promotions page without a code.',
  sourceUrl: 'https://help.northwind.example/bonuses',
  assetId: 'a3',
  assetTitle: 'Reload bonus eligibility',
  live: true,
};

test('THE LIVE CASE: brand-informed may not launder a claim into generic prose', () => {
  // ⚠️ THIS EXACT SENTENCE WAS SELECTED BY THE CRITIC AND PASSED EVERY GATE.
  // No number, so extractClaims called it defensible. No brand name, so the
  // brand rules did not fire. Hedged into "some books ... usually", so it reads
  // as general advice. It is one client's procedure with the name filed off.
  const d = withText({
    kind: 'brand-informed',
    text: 'Some books still offer reload bonuses to existing customers, usually claimed via the promotions page without a code.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx({ claims: [BONUS_CLAIM] }));

  assert.equal(result.ok, false);
  const failure = result.failures.find((f) => f.code === 'unattributed-proprietary');
  assert.ok(failure, JSON.stringify(result.failures));
  // The reviewer is told WHICH claim it collided with...
  assert.ok(failure.detail.includes('c3'));
  assert.ok(failure.detail.includes('Reload bonus eligibility'));
  // ...and all three ways out, because the fix is a writing decision.
  assert.ok(failure.detail.includes('genuinely general'));
  assert.ok(failure.detail.includes('brand-mentioned with attribution'));
  assert.ok(failure.detail.includes('drop the statement'));
});

test('hedging does not launder it — "most books usually" is not a defence', () => {
  for (const text of [
    'Most books usually let you claim reload bonuses from the promotions page without a code.',
    'Generally speaking reload bonuses go to existing customers and are claimed on the promotions page, no code.',
    'In my understanding reload bonuses for existing customers are claimed from the promotions page without any code.',
  ]) {
    const result = checkCompliance(withText({ kind: 'brand-informed', text }), ctx({ claims: [BONUS_CLAIM] }));
    assert.ok(
      result.failures.some((f) => f.code === 'unattributed-proprietary'),
      text,
    );
  }
});

test('community-only is held to the same boundary', () => {
  const result = checkCompliance(
    withText({
      kind: 'community-only',
      text: 'reload bonuses go to existing customers, claimed from the promotions page without a code.',
    }),
    ctx({ claims: [BONUS_CLAIM] }),
  );
  assert.ok(result.failures.some((f) => f.code === 'unattributed-proprietary'));
});

test('BRAND-INFORMED IS NOT KILLED: a genuinely general answer still passes', () => {
  // The variant must survive the rule. Using the asset to know WHICH part of the
  // conversation to answer is the variant working; reproducing the claim is not.
  // This reply is about the same subject, shaped by the same asset, and states
  // nothing that needs to know which company we mean.
  const d = withText({
    kind: 'brand-informed',
    text: 'worth checking whether you are opted in to marketing at all, that is what usually gates these rather than anything you did.',
  });

  const result = checkCompliance(d, ctx({ claims: [BONUS_CLAIM] }));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('and a general answer about the same topic in the same words is not blocked wholesale', () => {
  // Shares "bonus" and "customers" with the claim, and nothing else. Overlap is
  // a RESTATEMENT test, not a topic ban.
  const d = withText({
    kind: 'brand-informed',
    text: 'bonuses for existing customers dried up across the board once the acquisition spend moved to new signups.',
  });

  const result = checkCompliance(d, ctx({ claims: [BONUS_CLAIM] }));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('the same fact IS allowed in brand-mentioned, attributed', () => {
  // The rule moves information to where it can be attributed; it does not
  // delete it. This is the same procedure, named and cited, and it passes.
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Northwind still does reload bonuses for existing customers, claimed from the promotions page without a code.',
    claimIds: ['c3'],
  });

  const result = checkCompliance(d, ctx({ claims: [BONUS_CLAIM] }));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.assertions[0].backedBy, 'c3');
});

test('a laundered sentence is reported once, not under two codes', () => {
  const d = withText({
    kind: 'brand-informed',
    text: 'Reload bonuses reach existing customers from the promotions page without a code, about 90% of the time.',
  });

  const result = checkCompliance(d, ctx({ claims: [BONUS_CLAIM] }));
  assert.equal(result.assertions.length, 1);
  assert.equal(
    result.failures.filter((f) => f.code === 'unattributed-proprietary' || f.code === 'unbacked-assertion').length,
    1,
  );
});

test('community-only passes when it reasons from the thread', () => {
  const d = withText({
    kind: 'community-only',
    text: 'that is usually the market being suspended. the button goes while it is off and comes back when trading reopens.',
    claimIds: [],
  });

  const result = checkCompliance(d, ctx({ section: 'nfl-betting-21' }));
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('a link is refused everywhere except brand-mentioned in a promote section', () => {
  const text = 'have a look at https://help.northwind.example/cashout for the detail on this one.';

  const community = checkCompliance(withText({ kind: 'community-only', text }), ctx());
  assert.ok(community.failures.some((f) => f.code === 'link-not-permitted'));

  const informed = checkCompliance(withText({ kind: 'brand-informed', text }), ctx());
  assert.ok(informed.failures.some((f) => f.code === 'link-not-permitted'));

  const wrongSection = checkCompliance(
    withText({ kind: 'brand-mentioned', text, claimIds: [] }),
    ctx({ section: 'nfl-betting-21' }),
  );
  assert.ok(wrongSection.failures.some((f) => f.code === 'link-not-permitted'));

  const permitted = checkCompliance(
    withText({ kind: 'brand-mentioned', text: `Northwind covers it — ${text}`, claimIds: [] }),
    ctx(),
  );
  assert.ok(!permitted.failures.some((f) => f.code === 'link-not-permitted'));
});

// ---------------------------------------------------------------------------
// The honesty rule
// ---------------------------------------------------------------------------

test('invented first-hand experience is refused on every variant', () => {
  const lines = [
    "I've been betting with them for years and never had this.",
    'I use them and it happens to me too.',
    'my account had the same thing last week.',
    'when I signed up it did this constantly.',
  ];

  for (const text of lines) {
    assert.ok(inventedExperience(text).length > 0, text);
  }

  for (const kind of ['brand-mentioned', 'brand-informed', 'community-only']) {
    const result = checkCompliance(withText({ kind, text: lines[0] }), ctx());
    assert.ok(
      result.failures.some((f) => f.code === 'invented-experience'),
      kind,
    );
  }
});

test('ordinary first-person hedging is NOT treated as invented experience', () => {
  // Banning "I think" produces the stilted register that gives a machine away.
  for (const text of ['i think it is just the market suspending', "i'd say wait five minutes", "i don't know honestly"]) {
    assert.deepEqual(inventedExperience(text), [], text);
  }
});

test('an appeal to authority is refused even with a claim cited', () => {
  const d = withText({
    kind: 'brand-mentioned',
    text: 'Studies show that cashout is withdrawn while a market is suspended and returns when it reopens.',
    claimIds: ['c1'],
  });
  assert.ok(checkCompliance(d, ctx()).failures.some((f) => f.code === 'appeal-to-authority'));
});

test('jurisdiction is re-checked against the written reply, and spares community-only', () => {
  const jurisdiction = { prohibited: ['Ontario'], licensed: [] };
  const text = 'anyone in Ontario will see this differently because of how the market is run there right now.';

  const informed = checkCompliance(withText({ kind: 'brand-informed', text }), ctx({ jurisdiction }));
  assert.ok(informed.failures.some((f) => f.code === 'jurisdiction'));

  // Being a useful forum member in the same thread is not the prohibited act.
  const community = checkCompliance(withText({ kind: 'community-only', text }), ctx({ jurisdiction }));
  assert.ok(!community.failures.some((f) => f.code === 'jurisdiction'));
});

test('failures are collected, never short-circuited', () => {
  const d = withText({
    kind: 'community-only',
    text: 'Great question! Northwind settles 92% of these in 5 minutes — see https://northwind.example. Hope this helps!',
  });

  const codes = new Set(checkCompliance(d, ctx()).failures.map((f) => f.code));
  assert.ok(codes.size >= 4, [...codes].join(', '));
  assert.ok(codes.has('banned-opener'));
  assert.ok(codes.has('banned-closer'));
  assert.ok(codes.has('brand-named'));
  assert.ok(codes.has('link-not-permitted'));
});

// ---------------------------------------------------------------------------
// Dropping, and the critic
// ---------------------------------------------------------------------------

const okCompliance = { ok: true, failures: [], disclosure: { required: false, wording: '', why: '' }, evidence: [], assertions: [] };
const badCompliance = {
  ok: false,
  failures: [{ code: 'too-long', detail: '400 words' }],
  disclosure: { required: false, wording: '', why: '' },
  evidence: [],
  assertions: [],
};

const scores = (over = {}) => ({
  suitability: 80, relevance: 80, naturalness: 75, brandFit: 70, risk: 20, factual: 85, ...over,
});

const d = (kind, text = 'a reply') => ({ kind, text, words: 2, claimIds: [] });
const a = (kind, over = {}) => ({
  kind,
  scores: scores(over.scores),
  recommendation: over.recommendation ?? 'POST',
  why: over.why ?? 'reads well and answers it',
});

test('all dropped is NONE, and NO model call is made', () => {
  const { survivors, dropped } = dropBeforeCritic({
    eligible: ['community-only'],
    ineligible: [{ kind: 'brand-mentioned', reason: 'Turned off for this client.' }],
    drafts: [d('community-only')],
    assessments: [a('community-only', { recommendation: 'SKIP', why: 'nobody asked this' })],
    compliance: new Map([['community-only', okCompliance]]),
    floors: DEFAULT_FLOORS,
  });

  assert.equal(survivors.length, 0);
  const selection = noneFromDrops(dropped);
  assert.equal(selection.selected, 'NONE');
  assert.equal(selection.criticCalled, false, 'no model call when nothing survived');
  // And the ineligible one is on the record with its phase-3 reason.
  assert.ok(dropped.some((x) => x.stage === 'ineligible' && x.reasons[0].includes('Turned off')));
});

test('one survivor is the answer, with no critic call', () => {
  const { survivors, dropped } = dropBeforeCritic({
    eligible: ['brand-informed', 'community-only'],
    ineligible: [],
    drafts: [d('brand-informed'), d('community-only')],
    assessments: [a('brand-informed', { scores: { naturalness: 10 } }), a('community-only')],
    compliance: new Map([
      ['brand-informed', okCompliance],
      ['community-only', okCompliance],
    ]),
    floors: DEFAULT_FLOORS,
  });

  assert.equal(survivors.length, 1);
  const selection = soleSurvivor(survivors[0], dropped);
  assert.equal(selection.selected, 'community-only');
  assert.equal(selection.criticCalled, false);
});

test('a compliance failure drops a variant before the critic sees it', () => {
  const { survivors, dropped } = dropBeforeCritic({
    eligible: ['brand-mentioned', 'community-only'],
    ineligible: [],
    drafts: [d('brand-mentioned'), d('community-only')],
    assessments: [a('brand-mentioned'), a('community-only')],
    compliance: new Map([
      ['brand-mentioned', badCompliance],
      ['community-only', okCompliance],
    ]),
    floors: DEFAULT_FLOORS,
  });

  assert.equal(survivors.length, 1);
  const drop = dropped.find((x) => x.kind === 'brand-mentioned');
  assert.equal(drop.stage, 'compliance');
  assert.ok(drop.reasons[0].includes('too-long'));
});

test('a variant with no readable assessment is dropped, not passed through unjudged', () => {
  const { survivors, dropped } = dropBeforeCritic({
    eligible: ['community-only'],
    ineligible: [],
    drafts: [d('community-only')],
    assessments: [],
    compliance: new Map([['community-only', okCompliance]]),
    floors: DEFAULT_FLOORS,
  });

  assert.equal(survivors.length, 0);
  assert.equal(dropped[0].stage, 'not-scored');
});

test('an eligible variant the model never wrote is recorded as such', () => {
  const { dropped } = dropBeforeCritic({
    eligible: ['brand-informed'],
    ineligible: [],
    drafts: [],
    assessments: [],
    compliance: new Map(),
    floors: DEFAULT_FLOORS,
  });
  assert.equal(dropped[0].stage, 'not-written');
});

test('a floor drop carries the number and the bar, not just a sentence', () => {
  const { dropped } = dropBeforeCritic({
    eligible: ['community-only'],
    ineligible: [],
    drafts: [d('community-only')],
    assessments: [a('community-only', { scores: { factual: 10 } })],
    compliance: new Map([['community-only', okCompliance]]),
    floors: DEFAULT_FLOORS,
  });

  assert.equal(dropped[0].stage, 'floor');
  assert.equal(dropped[0].floorFailures[0].dimension, 'factual');
  assert.equal(dropped[0].floorFailures[0].score, 10);
  assert.equal(dropped[0].floorFailures[0].floor, DEFAULT_FLOORS.factual);
});

test('the critic is addressed by KIND, and an unoffered kind is a decline', () => {
  const offered = ['brand-informed', 'community-only'];

  assert.equal(parseCriticVerdict({ chosen: 'community-only', reason: 'most useful' }, offered).chosen, 'community-only');
  // Not snapped to the nearest candidate — an answer about something else is
  // not an answer about these.
  assert.equal(parseCriticVerdict({ chosen: 'brand-mentioned', reason: 'x' }, offered).chosen, null);
  assert.equal(parseCriticVerdict({ chosen: null, reason: 'all read as adverts' }, offered).chosen, null);
  // A pick with no reason is not a pick.
  assert.equal(parseCriticVerdict({ chosen: 'community-only', reason: '' }, offered).chosen, null);
  assert.equal(parseCriticVerdict('nonsense', offered).chosen, null);
});

test('the critic keeps its reason even when it declines', () => {
  const v = parseCriticVerdict({ chosen: null, reason: 'they all answer a question nobody asked' }, ['community-only']);
  assert.equal(v.reason, 'they all answer a question nobody asked');
});

test('a critic NONE records every survivor as dropped at the critic', () => {
  const survivors = [
    { draft: d('brand-informed'), assessment: a('brand-informed'), compliance: okCompliance, overall: 70 },
    { draft: d('community-only'), assessment: a('community-only'), compliance: okCompliance, overall: 65 },
  ];

  const selection = fromCritic({ chosen: null, reason: 'neither belongs here' }, survivors, []);

  assert.equal(selection.selected, 'NONE');
  assert.equal(selection.criticCalled, true);
  assert.equal(selection.dropped.length, 2);
  assert.ok(selection.dropped.every((x) => x.stage === 'critic'));
});

test('a critic choice records the others as dropped at the critic, with the reason', () => {
  const survivors = [
    { draft: d('brand-informed'), assessment: a('brand-informed'), compliance: okCompliance, overall: 70 },
    { draft: d('community-only'), assessment: a('community-only'), compliance: okCompliance, overall: 65 },
  ];

  const selection = fromCritic({ chosen: 'community-only', reason: 'answers it without an angle' }, survivors, []);

  assert.equal(selection.selected, 'community-only');
  assert.equal(selection.dropped.length, 1);
  assert.equal(selection.dropped[0].kind, 'brand-informed');
});

test('the critic prompt names the kinds it will accept back', () => {
  const survivors = [
    { draft: d('brand-informed'), assessment: a('brand-informed'), compliance: okCompliance, overall: 70 },
    { draft: d('community-only'), assessment: a('community-only'), compliance: okCompliance, overall: 65 },
  ];

  const { system, user } = buildCriticPrompt(survivors, {
    sectionName: 'NFL Betting',
    threadTitle: 't',
    postBody: 'b',
    problem: 'p',
    registerLines: ['- length: posts here run about 20 words. Write between 8 and 40 words.'],
  });

  assert.ok(user.includes('"brand-informed"'));
  assert.ok(user.includes('"community-only"'));
  assert.ok(/CHOOSE NONE FREELY/.test(system));
  // The community reply is a complete answer, not a fallback — stated, because
  // a critic that treats it as a consolation prize picks the branded one.
  assert.ok(/not a fallback/.test(system));
});
