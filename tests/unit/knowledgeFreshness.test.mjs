// The claim ledger's rules about when a fact may still be stated.
//
// This is the part of the asset library that has to be right. Everything else
// degrades gracefully — a poor trigger list means a missed opportunity, a poor
// purpose means a weaker reply. Getting freshness wrong means the system states
// a product fact that stopped being true, publicly, under the client's name.
//
// So the cases below are about the ways it could be WRONG, not the happy path:
// staleness beating a valid TTL, an active asset being pulled out of use by a
// re-crawl, and the distinction between "may be used" and "may be cited".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assetReadiness,
  canRefetch,
  claimStatus,
  compareCrawl,
  expiryFor,
  isAssertable,
  needsReview,
} from '../../apps/web/src/modules/knowledge/freshness.ts';
import { CLAIM_TTL_DAYS } from '../../apps/web/src/modules/knowledge/types.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

const asset = (over = {}) => ({
  assetId: 'a1',
  projectId: 'p1',
  title: 'Cashout availability',
  kind: 'help',
  purpose: 'Explains when cashout is offered and when it disappears.',
  problems: ['cashout vanished mid-game'],
  triggers: ['cashout disappeared'],
  exclusions: [],
  sourceUrl: 'https://example.test/help/cashout',
  status: 'active',
  proposedBy: 'model',
  model: 'deepseek-chat',
  promptVersion: 'v1',
  confirmedBy: 'u1',
  confirmedByName: 'Sam',
  confirmedAt: new Date(NOW - 30 * DAY),
  sourceHash: 'abc12345',
  lastCrawledAt: new Date(NOW - 30 * DAY),
  sourceChangedAt: null,
  textSource: 'fetched',
  attestedBy: null,
  attestedByName: null,
  attestedAt: null,
  fetchFailure: null,
  createdBy: 'u1',
  createdAt: new Date(NOW - 30 * DAY),
  updatedAt: new Date(NOW - 30 * DAY),
  ...over,
});

const claim = (over = {}) => {
  const verifiedAt = over.verifiedAt ?? new Date(NOW - 30 * DAY);
  return {
    claimId: 'c1',
    projectId: 'p1',
    assetId: 'a1',
    text: 'Cashout can disappear when the market suspends.',
    quote: 'Cashout may become unavailable if the market is suspended.',
    sourceUrl: 'https://example.test/help/cashout',
    verifiedAt,
    expiresAt: new Date(expiryFor(verifiedAt.getTime())),
    createdBy: 'u1',
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    ...over,
  };
};

// ── the TTL ────────────────────────────────────────────────────────────────

test('a recently verified claim is live and assertable', () => {
  const status = claimStatus(claim(), asset(), NOW);
  assert.equal(status, 'live');
  assert.equal(isAssertable(status), true);
});

test('a claim inside the warning window is still assertable, only flagged', () => {
  // Verified TTL-10 days ago: past the "start asking" line, not past expiry.
  const verifiedAt = new Date(NOW - (CLAIM_TTL_DAYS - 10) * DAY);
  const status = claimStatus(claim({ verifiedAt, expiresAt: new Date(expiryFor(verifiedAt.getTime())) }), asset(), NOW);
  assert.equal(status, 'expiring');
  assert.equal(isAssertable(status), true, 'due for review must not take the library offline');
});

test('a claim past its TTL is expired and NOT assertable', () => {
  const verifiedAt = new Date(NOW - (CLAIM_TTL_DAYS + 1) * DAY);
  const status = claimStatus(claim({ verifiedAt, expiresAt: new Date(expiryFor(verifiedAt.getTime())) }), asset(), NOW);
  assert.equal(status, 'expired');
  assert.equal(isAssertable(status), false);
});

// ── staleness beats everything ─────────────────────────────────────────────

test('a changed source page makes a freshly verified claim stale, not live', () => {
  // The whole point: the TTL is nowhere near up, but the page moved underneath
  // it. Positive evidence beats the absence of evidence.
  const status = claimStatus(claim(), asset({ sourceChangedAt: new Date(NOW - DAY) }), NOW);
  assert.equal(status, 'stale');
  assert.equal(isAssertable(status), false);
});

test('a page that changed BEFORE the claim was verified does not make it stale', () => {
  // Re-verification after a change is exactly how a claim comes back. If this
  // regressed, nothing could ever be un-staled and the library would decay to
  // unusable on its first edit.
  const status = claimStatus(
    claim({ verifiedAt: new Date(NOW - DAY) , expiresAt: new Date(expiryFor(NOW - DAY)) }),
    asset({ sourceChangedAt: new Date(NOW - 10 * DAY) }),
    NOW,
  );
  assert.equal(status, 'live');
});

// ── usable vs citable ──────────────────────────────────────────────────────

test('an active asset with a live claim is both usable and citable', () => {
  const r = assetReadiness(asset(), [claim()], NOW);
  assert.equal(r.usable, true);
  assert.equal(r.citable, true);
  assert.equal(r.assertable.length, 1);
});

test('an asset whose only claim expired is still usable, but not citable', () => {
  // This is the brand-informed variant surviving. The knowledge still shapes an
  // answer; what it may no longer do is carry an attributed fact.
  const verifiedAt = new Date(NOW - (CLAIM_TTL_DAYS + 1) * DAY);
  const r = assetReadiness(asset(), [claim({ verifiedAt, expiresAt: new Date(expiryFor(verifiedAt.getTime())) })], NOW);
  assert.equal(r.usable, true, 'an expired fact must not withdraw the whole subject');
  assert.equal(r.citable, false);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].status, 'expired');
});

test('an asset with no claims at all is usable and not citable', () => {
  const r = assetReadiness(asset(), [], NOW);
  assert.equal(r.usable, true);
  assert.equal(r.citable, false);
});

test('a changed source page withdraws the asset itself, not just its facts', () => {
  const r = assetReadiness(asset({ sourceChangedAt: new Date(NOW - DAY) }), [claim()], NOW);
  assert.equal(r.usable, false, 'purpose and exclusions may be wrong too, not only the claims');
  assert.equal(r.citable, false);
  assert.match(r.reason, /changed/i);
});

test('a draft asset is never usable, however good its claims', () => {
  const r = assetReadiness(asset({ status: 'draft' }), [claim()], NOW);
  assert.equal(r.usable, false);
  assert.equal(r.citable, false);
  assert.match(r.reason, /not confirmed/i);
});

test('a retired asset is never usable', () => {
  assert.equal(assetReadiness(asset({ status: 'retired' }), [claim()], NOW).usable, false);
});

test('claims belonging to another asset are ignored', () => {
  const r = assetReadiness(asset(), [claim({ claimId: 'c9', assetId: 'other' })], NOW);
  assert.equal(r.assertable.length, 0);
  assert.equal(r.blocked.length, 0);
  assert.equal(r.citable, false);
});

// ── the review queue ───────────────────────────────────────────────────────

test('needsReview lists everything that is not live, soonest expiry first', () => {
  const soon = new Date(NOW - (CLAIM_TTL_DAYS - 5) * DAY);
  const later = new Date(NOW - (CLAIM_TTL_DAYS - 12) * DAY);
  const claims = [
    claim({ claimId: 'later', verifiedAt: later, expiresAt: new Date(expiryFor(later.getTime())) }),
    claim({ claimId: 'soon', verifiedAt: soon, expiresAt: new Date(expiryFor(soon.getTime())) }),
    claim({ claimId: 'fine' }),
  ];
  const due = needsReview(claims, new Map([['a1', asset()]]), NOW);
  assert.deepEqual(due.map((d) => d.claim.claimId), ['soon', 'later']);
});

// ── the re-crawl comparison ────────────────────────────────────────────────

test('an identical page compares as unchanged', () => {
  const out = compareCrawl(asset(), { hash: 'abc12345', text: 'Cashout may become unavailable if the market is suspended.' }, [claim()]);
  assert.equal(out.verdict, 'unchanged');
  assert.equal(out.missingQuotes.length, 0);
});

test('a different hash compares as changed', () => {
  const out = compareCrawl(asset(), { hash: 'ffffffff', text: 'Cashout may become unavailable if the market is suspended.' }, [claim()]);
  assert.equal(out.verdict, 'changed');
});

test('a never-crawled asset reports first-crawl rather than changed', () => {
  const out = compareCrawl(asset({ sourceHash: '' }), { hash: 'abc12345', text: 'anything' }, []);
  assert.equal(out.verdict, 'first-crawl');
});

test('a vanished quote is reported even when the hash still matches', () => {
  // Hash equality is the cheap check; the quote is the one that means something.
  // A CMS that re-renders identically-hashed boilerplate must not hide the fact
  // that our supporting sentence is gone.
  const out = compareCrawl(asset(), { hash: 'abc12345', text: 'This page no longer mentions that behaviour.' }, [claim()]);
  assert.equal(out.missingQuotes.length, 1);
  assert.equal(out.missingQuotes[0].claimId, 'c1');
});

test('quote matching survives curly quotes, dashes and re-flowed whitespace', () => {
  // The harmless differences a CMS introduces. If these counted as changes,
  // every claim would go stale on its first re-crawl and the loop would be
  // discarded as noise — which is worse than not having it.
  const c = claim({ quote: "Cashout won't be offered — see the terms for details." });
  const page = { hash: 'abc12345', text: 'Note:\n  Cashout won’t be offered — see   the terms for details.' };
  assert.equal(compareCrawl(asset(), page, [c]).missingQuotes.length, 0);
});

test('a reworded sentence is NOT forgiven', () => {
  const c = claim({ quote: 'Cashout may become unavailable if the market is suspended.' });
  const page = { hash: 'abc12345', text: 'Cashout is sometimes unavailable when a market suspends.' };
  assert.equal(compareCrawl(asset(), page, [c]).missingQuotes.length, 1);
});

// ── the manual route ───────────────────────────────────────────────────────
//
// A pasted asset exists because the server got a 403 on a page a person can
// read. Everything about its FACTS works identically — the TTL, staleness,
// citability. The one difference is who is able to go and look again.

test('a pasted asset is never re-fetched by the sweep', () => {
  // Trying would fail every night for the same reason it failed the first time,
  // and a report full of expected failures is a report nobody reads.
  assert.equal(canRefetch(asset({ textSource: 'pasted' })), false);
});

test('a fetched asset with a URL is re-fetched', () => {
  assert.equal(canRefetch(asset()), true);
});

test('an asset with no source URL is not re-fetched whatever its provenance', () => {
  assert.equal(canRefetch(asset({ sourceUrl: '' })), false);
});

test('pasted claims obey exactly the same TTL as fetched ones', () => {
  // The manual route is a different source of text, not a lower standard — and
  // NOT a longer leash either. This is what eventually puts a blocked page back
  // in front of a person, since no sweep ever will.
  const verifiedAt = new Date(NOW - (CLAIM_TTL_DAYS + 1) * DAY);
  const stale = claim({ verifiedVia: 'pasted', verifiedAt, expiresAt: new Date(expiryFor(verifiedAt.getTime())) });
  assert.equal(claimStatus(stale, asset({ textSource: 'pasted' }), NOW), 'expired');
  assert.equal(isAssertable(claimStatus(stale, asset({ textSource: 'pasted' }), NOW)), false);
});

test('a pasted asset with a live claim is citable, like any other', () => {
  // The provenance is recorded and displayed; it does not demote the asset.
  // A named person vouched for the text, which is a real form of evidence.
  const r = assetReadiness(asset({ textSource: 'pasted' }), [claim({ verifiedVia: 'pasted' })], NOW);
  assert.equal(r.usable, true);
  assert.equal(r.citable, true);
});
