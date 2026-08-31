// Reading a page, and refusing to believe a model about what it said.
//
// Two jobs are tested here and they meet in the middle:
//
//   extract.ts turns HTML into the text a claim's quote must be found in
//   prompts.ts throws away every proposed claim whose quote is not in it
//
// The meeting point is the reason for the strongest test in this file: a quote
// accepted at ingestion has to still be findable by the re-crawl that checks it
// months later. Those two use ONE normaliser, and if that ever forks, every
// asset goes stale on its first check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contentHash,
  crawlFromHtml,
  decodeEntities,
  extractText,
  extractTitle,
  forPrompt,
  normaliseForMatch,
  normalisePasted,
} from '../../apps/web/src/modules/knowledge/extract.ts';
import { parseProposal } from '../../apps/web/src/modules/knowledge/prompts.ts';
import { compareCrawl } from '../../apps/web/src/modules/knowledge/freshness.ts';

const PAGE = `<!doctype html>
<html>
  <head><title>Cashout | Help</title><style>.x{color:red}</style></head>
  <body>
    <nav><a href="/">Home</a></nav>
    <h1>Cashout</h1>
    <p>Cashout lets you settle a bet before the event finishes.</p>
    <p>Cashout may become unavailable if the market is suspended.</p>
    <ul><li>Availability depends on the market.</li></ul>
    <script>console.log('tracking')</script>
    <footer>Gamble responsibly.</footer>
  </body>
</html>`;

// ── extraction ─────────────────────────────────────────────────────────────

test('the document title wins over the h1', () => {
  assert.equal(extractTitle(PAGE), 'Cashout | Help');
});

test('a page with no title falls back to its h1', () => {
  assert.equal(extractTitle('<html><body><h1>Cashout</h1></body></html>'), 'Cashout');
});

test('script, style, nav and footer contents never reach the text', () => {
  const text = extractText(PAGE);
  assert.ok(!text.includes('tracking'), 'script body leaked');
  assert.ok(!text.includes('color:red'), 'style body leaked');
  assert.ok(!text.includes('Gamble responsibly'), 'footer leaked');
  assert.ok(!text.includes('Home'), 'nav leaked');
});

test('prose survives, one block per line', () => {
  const lines = extractText(PAGE).split('\n');
  assert.ok(lines.includes('Cashout may become unavailable if the market is suspended.'));
  assert.ok(lines.includes('Availability depends on the market.'));
});

test('block boundaries are not welded together', () => {
  // Without a break at </p> the whole page becomes one sentence and every quote
  // match spans two unrelated headings.
  const text = extractText('<p>First sentence.</p><p>Second sentence.</p>');
  assert.equal(text, 'First sentence.\nSecond sentence.');
});

test('entities are decoded, including numeric ones', () => {
  assert.equal(decodeEntities('caf&eacute;&nbsp;&amp;&#38;&#x26;'), 'caf&eacute; &&&');
  assert.equal(extractText('<p>Bet &amp; win &pound;10</p>'), 'Bet & win £10');
});

// ── the hash ───────────────────────────────────────────────────────────────

test('the same text hashes the same way twice', () => {
  assert.equal(contentHash('cashout may become unavailable'), contentHash('cashout may become unavailable'));
});

test('a one-character difference changes the hash', () => {
  assert.notEqual(contentHash('cashout is available'), contentHash('cashout is unavailable'));
});

test('the hash is stable across an unchanged re-crawl of the same HTML', () => {
  assert.equal(crawlFromHtml('u', PAGE, 1).hash, crawlFromHtml('u', PAGE, 2).hash);
});

test('a change anywhere in the prose moves the hash', () => {
  const edited = PAGE.replace('may become unavailable', 'is always available');
  assert.notEqual(crawlFromHtml('u', PAGE, 1).hash, crawlFromHtml('u', edited, 1).hash);
});

// ── truncation ─────────────────────────────────────────────────────────────

test('a long page is cut on a line boundary, never mid-sentence', () => {
  const text = Array.from({ length: 500 }, (_, i) => `Line number ${i} of the document.`).join('\n');
  const cut = forPrompt(text, 400);
  assert.ok(cut.length <= 400);
  assert.ok(!cut.endsWith(' '), 'cut mid-word');
  assert.ok(text.startsWith(cut), 'truncation must not alter what it keeps');
});

test('a short page is returned whole', () => {
  assert.equal(forPrompt('short', 400), 'short');
});

// ── believing the model ────────────────────────────────────────────────────

const pageText = extractText(PAGE);

const proposal = (over = {}) => ({
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'When cashout is offered and when it is not.',
  problems: ['cashout vanished mid game'],
  triggers: ['cashout disappeared'],
  exclusions: ['bank transfer'],
  claims: [],
  ...over,
});

test('a claim whose quote is on the page is kept', () => {
  const out = parseProposal(
    proposal({
      claims: [{ text: 'Cashout can disappear when the market suspends.', quote: 'Cashout may become unavailable if the market is suspended.' }],
    }),
    pageText,
  );
  assert.equal(out.proposal.claims.length, 1);
  assert.equal(out.rejected.length, 0);
});

test('a claim whose quote is NOT on the page is dropped, not flagged', () => {
  // Dropped rather than shown-with-a-warning on purpose: a reviewer handed
  // twelve claims approves twelve claims.
  const out = parseProposal(
    proposal({ claims: [{ text: 'Withdrawals are instant.', quote: 'All withdrawals are processed instantly, every time.' }] }),
    pageText,
  );
  assert.equal(out.proposal.claims.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /not on the page/i);
});

test('a claim with no quote at all is dropped', () => {
  const out = parseProposal(proposal({ claims: [{ text: 'Cashout is great.', quote: '' }] }), pageText);
  assert.equal(out.proposal.claims.length, 0);
  assert.match(out.rejected[0].reason, /no supporting quote/i);
});

test('a quote too short to mean anything is dropped', () => {
  // "Cashout" appears on a cashout page a dozen times and supports nothing.
  const out = parseProposal(proposal({ claims: [{ text: 'Cashout exists.', quote: 'Cashout' }] }), pageText);
  assert.equal(out.proposal.claims.length, 0);
  assert.match(out.rejected[0].reason, /too short/i);
});

test('an unparseable response is null, but a claimless proposal is valid', () => {
  assert.equal(parseProposal('not an object', pageText), null);
  assert.equal(parseProposal({ title: '', purpose: 'x' }, pageText), null);
  const out = parseProposal(proposal({ claims: [] }), pageText);
  assert.ok(out, 'a landing page with no assertable facts is a normal outcome, not an error');
  assert.equal(out.proposal.claims.length, 0);
});

test('an unknown kind falls back rather than failing the whole page', () => {
  assert.equal(parseProposal(proposal({ kind: 'nonsense' }), pageText).proposal.kind, 'guide');
});

test('field lists are capped so one runaway response cannot bloat an asset', () => {
  const many = Array.from({ length: 40 }, (_, i) => `trigger ${i}`);
  assert.equal(parseProposal(proposal({ triggers: many }), pageText).proposal.triggers.length, 8);
});

// ── the meeting point ──────────────────────────────────────────────────────

test('a quote accepted at ingestion is still found by a later re-crawl', () => {
  // THE test in this file. Ingestion and the freshness check share one
  // normaliser; if that ever forks, every asset goes stale on its first check
  // and the loop reads as broken rather than as working.
  const quote = 'Cashout may become unavailable if the market is suspended.';
  const accepted = parseProposal(proposal({ claims: [{ text: 'It can vanish.', quote }] }), pageText);
  assert.equal(accepted.proposal.claims.length, 1, 'precondition: ingestion accepted it');

  const page = crawlFromHtml('u', PAGE, 1);
  const out = compareCrawl(
    { assetId: 'a1', sourceHash: page.hash },
    { hash: page.hash, text: page.text },
    [{ claimId: 'c1', assetId: 'a1', quote }],
  );
  assert.equal(out.verdict, 'unchanged');
  assert.equal(out.missingQuotes.length, 0, 'ingestion and the re-crawl disagree — the normalisers have forked');
});

test('the normaliser forgives presentation and nothing else', () => {
  assert.equal(normaliseForMatch('It’s  a  “test” — really'), normaliseForMatch("It's a \"test\" - really"));
  assert.notEqual(normaliseForMatch('cashout may vanish'), normaliseForMatch('cashout can vanish'));
});

// ── the manual route ───────────────────────────────────────────────────────
//
// Forced into existence by a real 403 on a real client help centre. The rule it
// has to satisfy: pasted text goes through EXACTLY the same extraction and the
// same quote check as fetched text. The manual route is a different source of
// text, not a lower standard.

test('pasted HTML is reduced the same way a fetched page is', () => {
  assert.equal(normalisePasted(PAGE), extractText(PAGE));
});

test('pasted plain prose keeps its lines and loses its padding', () => {
  const out = normalisePasted('  Cashout lets you settle early.  \n\n   It can disappear.  \n');
  assert.equal(out, 'Cashout lets you settle early.\nIt can disappear.');
});

test('prose containing an angle bracket is not mangled as markup', () => {
  // "5 < 10" must not send this through the tag stripper. The HTML test looks
  // for a closing tag, not merely a bracket, for exactly this case.
  const out = normalisePasted('If the margin is 5 < 10 you are fine.');
  assert.equal(out, 'If the margin is 5 < 10 you are fine.');
});

test('a quote check against pasted text behaves identically to fetched text', () => {
  // The claim that would be accepted from a fetched page is accepted from the
  // same content pasted, and the one that would be rejected is still rejected.
  // If these ever diverged, the manual route would quietly be the lax one.
  const pastedText = normalisePasted(PAGE);
  const supported = { text: 'It can vanish.', quote: 'Cashout may become unavailable if the market is suspended.' };
  const invented = { text: 'Withdrawals are instant.', quote: 'All withdrawals are processed instantly, every time.' };

  const fromPasted = parseProposal(proposal({ claims: [supported, invented] }), pastedText);
  const fromFetched = parseProposal(proposal({ claims: [supported, invented] }), pageText);

  assert.equal(fromPasted.proposal.claims.length, 1);
  assert.equal(fromPasted.rejected.length, 1);
  assert.deepEqual(
    fromPasted.proposal.claims.map((c) => c.text),
    fromFetched.proposal.claims.map((c) => c.text),
  );
});

test('pasted text hashes the same as the fetched page it came from', () => {
  // So a page that later becomes fetchable can be compared against the snapshot
  // taken while it was blocked, rather than reporting a spurious change.
  assert.equal(contentHash(normalisePasted(PAGE)), crawlFromHtml('u', PAGE, 1).hash);
});
