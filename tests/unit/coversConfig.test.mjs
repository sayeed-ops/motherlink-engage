// The Covers module's settings, and what happens to a malformed one.
//
// Settings arriving from a browser are input. The interesting assertions here
// are all about what is REFUSED — a section with no role, a duplicate slug, a
// page budget somebody typed as 500 — because each of those, accepted quietly,
// becomes either a wrong promotion decision or a bill.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultCoversConfig,
  normaliseCoversConfig,
  sportForSection,
  MAX_PAGES_PER_SECTION,
  MAX_THREADS_PER_SCAN,
} from '../../apps/web/src/modules/covers/config.ts';
import { promotionPermitted } from '../../apps/web/src/modules/covers/sections.ts';

test('the shipped defaults permit promotion nowhere', () => {
  const config = defaultCoversConfig();
  assert.ok(config.sections.length > 0);
  assert.ok(
    config.sections.every((s) => !s.roles.includes('promote')),
    'Covers treats commercial posts outside Website Promotions as bannable',
  );
  assert.equal(promotionPermitted(config.sections, 'nfl-betting-21'), false);
  assert.equal(promotionPermitted(config.sections, 'a-section-nobody-configured'), false);
});

test('a section with no valid role is dropped, never defaulted to watch', () => {
  const config = normaliseCoversConfig({
    sections: [
      { slug: 'nfl-betting-21', name: 'NFL', roles: ['reply'], sport: 'nfl' },
      { slug: 'mlb-betting-27', name: 'MLB', roles: ['nonsense'], sport: 'mlb' },
      { slug: 'nhl-betting-23', name: 'NHL', roles: [], sport: 'nhl' },
    ],
  });

  assert.deepEqual(
    config.sections.map((s) => s.slug),
    ['nfl-betting-21'],
    'a role invented on a malformed row is how a promotion lands in a section that bans them',
  );
});

test('one row per slug, whatever was sent', () => {
  const config = normaliseCoversConfig({
    sections: [
      { slug: 'nfl-betting-21', roles: ['watch'] },
      { slug: '/forum/nfl-betting-21', roles: ['promote'] },
    ],
  });

  assert.equal(config.sections.length, 1);
  assert.deepEqual(config.sections[0].roles, ['watch'], 'the first row wins; there is no merge');
  assert.equal(promotionPermitted(config.sections, 'nfl-betting-21'), false);
});

test('a section is recognised however it was typed', () => {
  const config = normaliseCoversConfig({
    sections: [{ slug: 'https://www.covers.com/forum/nba-betting-22/2', roles: ['reply'] }],
  });
  assert.equal(config.sections[0].slug, 'nba-betting-22');
  assert.equal(config.sections[0].name, 'NBA Betting', 'the shipped catalogue fills in the name');
  assert.equal(config.sections[0].sport, 'nba');
});

test('the request budget is clamped rather than believed', () => {
  const big = normaliseCoversConfig({ pagesPerSection: 500, maxThreadsPerScan: 9999 });
  assert.equal(big.pagesPerSection, MAX_PAGES_PER_SECTION);
  assert.equal(big.maxThreadsPerScan, MAX_THREADS_PER_SCAN);

  const junk = normaliseCoversConfig({ pagesPerSection: 'lots', maxThreadsPerScan: -4 });
  assert.equal(junk.pagesPerSection, defaultCoversConfig().pagesPerSection);
  assert.equal(junk.maxThreadsPerScan, 0, 'zero threads is a legitimate listing-only run');
});

test('an unclassified section reports a null sport rather than one read off the slug', () => {
  const config = normaliseCoversConfig({
    sections: [{ slug: 'soccer-36', roles: ['watch'] }, { slug: 'made-up-99', roles: ['watch'] }],
  });

  assert.equal(sportForSection(config, 'soccer-36'), 'soccer');
  assert.equal(sportForSection(config, 'made-up-99'), null);
  assert.equal(sportForSection(config, 'not-configured-at-all'), null);
});

test('nothing at all is the shipped defaults, not an empty config', () => {
  assert.deepEqual(normaliseCoversConfig(undefined), defaultCoversConfig());
  assert.deepEqual(normaliseCoversConfig({}), defaultCoversConfig());
});
