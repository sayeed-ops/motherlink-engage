// Seeding a Covers client, and the one field whose absence fails silently.
//
// The assertion this file exists for: deriveBrandNames CANNOT RETURN EMPTY for a
// project that has a name. An empty list does not error — it makes three brand
// gates pass everything, which is the failure that put this module here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  brandLabelOf,
  deriveBrandNames,
  outstandingDecisions,
  seedCoversPolicy,
  COMPLIANCE_DECISIONS,
} from '../../apps/web/src/modules/covers/onboarding.ts';
import { variantEligibility } from '../../apps/web/src/modules/covers/policy.ts';

const SECTIONS = [
  { slug: 'nfl-betting-21', name: 'NFL Betting', roles: ['watch', 'reply'], sport: 'nfl' },
  { slug: 'website-promotions-9', name: 'Promotions', roles: ['watch', 'reply', 'promote'], sport: null },
];

// ---------------------------------------------------------------------------
// Brand names
// ---------------------------------------------------------------------------

test('a project with only a name still yields a brand name', () => {
  // The whole point. Every project has a name — the create route requires one —
  // so there is no configuration in which brand detection is silently off.
  const names = deriveBrandNames({ projectName: 'Northwind' });
  assert.ok(names.length > 0);
  assert.ok(names.includes('Northwind'));
});

test('a legal suffix is stripped, and both forms are kept', () => {
  // "Northwind Ltd" is what it is filed as; "Northwind" is what a forum writes.
  const names = deriveBrandNames({ projectName: 'Northwind Ltd' });
  assert.ok(names.includes('Northwind Ltd'));
  assert.ok(names.includes('Northwind'));
});

test('the website domain contributes a name', () => {
  const names = deriveBrandNames({
    projectName: 'The Client',
    clientWebsiteUrl: 'https://www.northwind.example/en/',
  });
  assert.ok(names.includes('Northwind'));
});

test('a two-level public suffix does not yield "co"', () => {
  assert.equal(brandLabelOf('https://northwind.co.uk'), 'northwind');
  assert.equal(brandLabelOf('https://www.northwind.com'), 'northwind');
  assert.equal(brandLabelOf('help.northwind.example'), 'northwind');
  assert.equal(brandLabelOf('not a url at all'), null);
  assert.equal(brandLabelOf(''), null);
});

test('the interview name comes first — it is researched, not typed in a hurry', () => {
  const names = deriveBrandNames({
    projectName: 'nw test',
    interviewClientName: 'Northwind Betting',
  });
  assert.equal(names[0], 'Northwind Betting');
});

test('asset source URLs contribute the names the client publishes under', () => {
  const names = deriveBrandNames({
    projectName: 'Client',
    assetUrls: ['https://help.northwind.example/cashout', 'https://blog.northwindbet.example/x'],
  });
  assert.ok(names.includes('Northwind'));
  assert.ok(names.includes('Northwindbet'));
});

test('duplicates are folded case-insensitively', () => {
  const names = deriveBrandNames({
    projectName: 'Northwind',
    interviewClientName: 'northwind',
    clientWebsiteUrl: 'https://NORTHWIND.example',
  });
  assert.equal(names.filter((n) => n.toLowerCase() === 'northwind').length, 1);
});

test('terms too short or too generic to match on are dropped', () => {
  // Same lesson as the jurisdiction codes and the team abbreviations: at this
  // length a brand name collides with ordinary English, and a false brand hit
  // rejects a good community-only reply for naming a client it never mentioned.
  const names = deriveBrandNames({ projectName: 'Betting', clientWebsiteUrl: 'https://ab.example' });
  assert.ok(!names.some((n) => n.toLowerCase() === 'betting'));
  assert.ok(!names.some((n) => n.length < 3));
});

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

test('a seeded policy is safe to save without anybody typing anything', () => {
  const p = seedCoversPolicy({ projectName: 'Northwind', clientWebsiteUrl: 'https://northwind.example' });

  assert.ok(p.brandNames.length > 0, 'brand detection is live from the first minute');
  assert.equal(p.variants.brandMentioned, false, 'naming a client is never a default');
  assert.equal(p.variants.brandInformed, true);
  assert.equal(p.variants.communityOnly, true);
  assert.equal(p.complianceConfirmed, false, 'nobody has answered the licence questions yet');
  assert.deepEqual(p.jurisdiction, { prohibited: [], licensed: [] });
  assert.equal(p.disclosureWording, '', 'no standard wording is invented');
});

test('the outstanding list names the two decisions nothing can derive', () => {
  const p = seedCoversPolicy({ projectName: 'Northwind' });
  const out = outstandingDecisions(p);
  for (const d of COMPLIANCE_DECISIONS) assert.ok(out.includes(d), d);
});

test('a confirmed policy with brand names has nothing outstanding', () => {
  assert.deepEqual(
    outstandingDecisions({ complianceConfirmed: true, brandNames: ['Northwind'] }),
    [],
  );
});

test('an empty brand list is reported as outstanding even when confirmed', () => {
  const out = outstandingDecisions({ complianceConfirmed: true, brandNames: [] });
  assert.equal(out.length, 1);
  assert.ok(out[0].includes('brand detection is disabled'));
});

// ---------------------------------------------------------------------------
// Confirmation changes behaviour — it is not a checkbox
// ---------------------------------------------------------------------------

const eligibility = (over = {}) =>
  variantEligibility({
    section: 'website-promotions-9',
    sections: SECTIONS,
    hasAssetMatch: true,
    hasCitableClaim: true,
    enabled: { brandMentioned: true, brandInformed: true, communityOnly: true },
    ...over,
  });

test('unconfirmed compliance WITHHOLDS the client-drawing variants', () => {
  const v = eligibility({ complianceConfirmed: false });

  assert.equal(v.variants.brandMentioned, false);
  assert.equal(v.variants.brandInformed, false);
  // Being a useful member of a forum is not the prohibited act — the same
  // reason the community reply survives an actual jurisdiction block.
  assert.equal(v.variants.communityOnly, true);
});

test('and says so, rather than reporting it as a client preference', () => {
  const v = eligibility({ complianceConfirmed: false });
  assert.ok(v.reasons.brandMentioned.includes('compliance'));
  assert.ok(v.reasons.brandInformed.includes('Policy'));
});

test('ABSENT reads as unconfirmed — no client is grandfathered past the check', () => {
  // A policy document written before the field existed has not confirmed
  // anything, and defaulting to true would let every existing project through.
  const v = eligibility({});
  assert.equal(v.variants.brandMentioned, false);
  assert.equal(v.variants.brandInformed, false);
});

test('confirming restores the normal eligibility rules', () => {
  const v = eligibility({ complianceConfirmed: true });
  assert.equal(v.variants.brandMentioned, true);
  assert.equal(v.variants.brandInformed, true);
  assert.equal(v.variants.communityOnly, true);
});

test('confirming does not override the section roles', () => {
  // A confirmed policy still cannot promote in a reply-only section.
  const v = eligibility({ complianceConfirmed: true, section: 'nfl-betting-21' });
  assert.equal(v.variants.brandMentioned, false);
  assert.ok(v.reasons.brandMentioned.includes('does not permit promotion'));
  assert.equal(v.variants.brandInformed, true);
});
