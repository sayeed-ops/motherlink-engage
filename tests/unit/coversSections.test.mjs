// Which parts of Covers we may read, and where a brand mention is even legal.
//
// The promotion rule is the one that matters. Covers permits commercial posts in
// Website Promotions and treats them as bannable elsewhere, so this list is the
// forum's own rules written down — and `promotionPermitted` is what the variant
// eligibility mask asks before a model is called.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SECTIONS,
  normaliseSection,
  promotionPermitted,
  sectionUrl,
  sectionsForRole,
} from '../../apps/web/src/modules/covers/sections.ts';

test('a section is recognised however it was typed', () => {
  for (const input of [
    'nfl-betting-21',
    '/nfl-betting-21/',
    'https://www.covers.com/forum/nfl-betting-21',
    'https://www.covers.com/forum/nfl-betting-21/3',
    'NFL-Betting-21',
  ]) {
    assert.equal(normaliseSection(input), 'nfl-betting-21', input);
  }
});

test('NO default section permits promotion', () => {
  // The whole point of the list. Every sports forum is reply-only; commercial
  // content belongs in Website Promotions, which an operator adds deliberately.
  const promoting = DEFAULT_SECTIONS.filter((s) => s.roles.includes('promote'));
  assert.deepEqual(promoting, [], `these would allow a brand mention: ${promoting.map((s) => s.slug).join(', ')}`);
});

test('an unknown section never permits promotion', () => {
  // A section scraped but never classified is not one anyone has said we may
  // advertise in. Defaulting the other way would make every new forum on the
  // site promotable the moment it appeared.
  assert.equal(promotionPermitted(DEFAULT_SECTIONS, 'some-new-forum-99'), false);
  assert.equal(promotionPermitted(DEFAULT_SECTIONS, ''), false);
});

test('promotion is permitted only where it is configured', () => {
  const withPromo = [
    ...DEFAULT_SECTIONS,
    { slug: 'website-promotions-9', name: 'Website Promotions', roles: ['promote'], sport: null },
  ];
  assert.equal(promotionPermitted(withPromo, 'website-promotions-9'), true);
  assert.equal(promotionPermitted(withPromo, 'nfl-betting-21'), false);
  // And through a full URL, the way a scraped thread would carry it.
  assert.equal(promotionPermitted(withPromo, 'https://www.covers.com/forum/website-promotions-9'), true);
});

test('roles select sections without four parallel lists', () => {
  const reply = sectionsForRole(DEFAULT_SECTIONS, 'reply').map((s) => s.slug);
  const watch = sectionsForRole(DEFAULT_SECTIONS, 'watch').map((s) => s.slug);
  assert.ok(reply.includes('nfl-betting-21'));
  assert.ok(watch.includes('general-discussion-35'));
  assert.ok(!reply.includes('general-discussion-35'), 'general discussion is watch-only by default');
});

test('every default slug is one the live forum index actually links to', () => {
  // ⚠️ TWO OF THE NINE WERE WRONG. `general-discussion-25` 302s and
  // `tennis-37` answers 200 while not being the slug the index uses — a wrong
  // slug does not fail loudly, it redirects or serves something else, so a
  // harvest would quietly read the wrong board. Checked against /forum on
  // 2026-08-31; re-check when adding one.
  const fromIndex = new Set([
    'nfl-betting-21', 'nba-betting-22', 'mlb-betting-27', 'nhl-betting-23',
    'college-football-33', 'college-basketball-40', 'soccer-36', 'tennis-38',
    'general-discussion-35',
  ]);
  for (const s of DEFAULT_SECTIONS) {
    assert.ok(fromIndex.has(s.slug), `${s.slug} is not a slug the forum index links to`);
  }
});

test('page 1 has no suffix, later pages do', () => {
  assert.equal(sectionUrl('nfl-betting-21'), 'https://www.covers.com/forum/nfl-betting-21');
  assert.equal(sectionUrl('nfl-betting-21', 1), 'https://www.covers.com/forum/nfl-betting-21');
  assert.equal(sectionUrl('nfl-betting-21', 3), 'https://www.covers.com/forum/nfl-betting-21/3');
});

test('every default section carries a slug that survives normalisation', () => {
  for (const s of DEFAULT_SECTIONS) {
    assert.equal(normaliseSection(s.slug), s.slug, `${s.slug} would not compare equal to a scraped section`);
  }
});
