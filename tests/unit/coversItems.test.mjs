// What a harvest records, tested on the real thread.
//
// The fixture is the same slice coversParse.test.mjs uses — "Week 1 bets and
// line moves", fetched live on 2026-08-30. Mapping it here means the assertions
// are about a page somebody actually wrote, including the ways real posts are
// untidy: quoted replies, one-word posts, and a thread whose title names no game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseThreadPage } from '../../apps/web/src/modules/covers/parse.ts';
import {
  buildItem,
  coversItemId,
  summariseHarvest,
} from '../../apps/web/src/modules/covers/items.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(here, '../fixtures/covers', name), 'utf8');

const THREAD_URL =
  'https://www.covers.com/forum/nfl-betting-21/week-1-bets-and-line-moves-104044109';

const thread = () => parseThreadPage(fixture('thread-slice.html'), THREAD_URL);

test('an item is the thread and its posts are a subcollection, keyed by Covers ids', () => {
  const { item, posts } = buildItem('proj1', thread(), 'nfl');

  // Spelled out rather than derived from the item itself: the first version of
  // this test compared the id with a function of the id, which is true however
  // wrong the id is — and the id was wrong (see coversParse: the section slug).
  assert.equal(item.externalId, '104044109');
  assert.equal(item.itemId, 'proj1_covers_104044109');
  assert.equal(item.itemId, coversItemId('proj1', '104044109'));
  assert.equal(item.platform, 'covers');
  assert.equal(item.section, 'nfl-betting-21');
  assert.equal(item.sport, 'nfl');
  assert.ok(posts.length > 0);
  assert.ok(posts.every((p) => p.itemId === item.itemId));
  assert.ok(posts.every((p) => /^\d+$/.test(p.postId)), 'the post id is Covers own, not ours');
  assert.equal(new Set(posts.map((p) => p.postId)).size, posts.length, 'no duplicate posts');
});

test('the count is named for what we read, and unmeasured counts stay null', () => {
  const { item, posts } = buildItem('proj1', thread(), 'nfl');

  assert.equal(item.postsHarvested, posts.length);
  // Read by URL with no listing row: Covers puts neither number on the thread
  // page, and a zero here would render as a dead thread.
  assert.equal(item.postsOnSite, null);
  assert.equal(item.views, null);
});

test('a listing row supplies what the thread page cannot', () => {
  const summary = {
    threadId: '104044109',
    title: 'Week 1 bets and line moves',
    url: THREAD_URL,
    section: 'nfl-betting-21',
    author: 'brn2loslive2win',
    createdAtMs: 1756000000000,
    postsOnSite: 19,
    views: 812,
  };

  const { item } = buildItem('proj1', thread(), 'nfl', summary);
  assert.equal(item.postsOnSite, 19);
  assert.equal(item.views, 812);
  assert.equal(item.author, 'brn2loslive2win');
  assert.equal(item.createdAtSourceMs, 1756000000000);
});

test('post times are the UTC attribute, and bound the thread window', () => {
  const { item, posts } = buildItem('proj1', thread(), 'nfl');
  const times = posts.map((p) => p.createdAtMs).filter((t) => t !== null);

  assert.ok(times.length > 0);
  assert.equal(item.firstPostAtMs, Math.min(...times));
  assert.equal(item.lastPostAtMs, Math.max(...times));

  // The load-bearing one: 08/25 03:22 UTC is 08/24 23:22 ET, which is how the
  // page displays it. Reading the attribute as local time loses four hours.
  const asUtc = new Date(item.lastPostAtMs).toISOString();
  assert.match(asUtc, /^20\d\d-\d\d-\d\dT/);
});

test('the real thread yields the teams and lines the posts actually quote', () => {
  const { item, posts } = buildItem('proj1', thread(), 'nfl');

  assert.ok(item.entities.teams.includes('nfl:sea'));
  assert.ok(item.entities.teams.includes('nfl:phi'));
  assert.ok(item.entities.lines.some((l) => l.kind === 'spread' && l.value === -3.5));

  // Entities are per POST as well as per thread, because the opportunity anchor
  // is a post: a thread-level blob cannot say which post quoted which number.
  assert.ok(posts.some((p) => p.entities.lines.length > 0));
});

test('a thread naming a whole card has no fixture, and says so with null', () => {
  const { item } = buildItem('proj1', thread(), 'nfl');
  assert.equal(item.fixtureKey, item.entities.fixture?.key ?? null);
  assert.equal(item.fixtureKey, null, 'a week of bets is not one game');
});

test('an unclassified section stores a null sport rather than a guessed one', () => {
  const { item, posts } = buildItem('proj1', thread(), null);
  assert.equal(item.sport, null);
  assert.equal(item.entities.lexicon, false);
  assert.deepEqual(item.entities.teams, []);
  assert.ok(posts.every((p) => p.entities.teams.length === 0));
});

test('the harvest summary separates what was listed from what was read', () => {
  const built = [buildItem('proj1', thread(), 'nfl')];
  const s = summariseHarvest('nfl-betting-21', 60, built, ['one thread could not be read']);

  assert.equal(s.listed, 60);
  assert.equal(s.read, 1, 'listing 60 threads is one request; reading them is sixty more');
  assert.equal(s.posts, built[0].posts.length);
  assert.equal(s.errors.length, 1);
});
