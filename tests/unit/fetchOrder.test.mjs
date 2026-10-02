// Which subreddit a fetch takes first.
//
// The bug this replaces: a fetch always walked the project's list from the
// top and stopped at the first failure, so the communities at the bottom were
// lost on every short run and nothing remembered it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchOrder,
  listSubreddits,
  nextFetchRecord,
  normalizeFetchState,
} from '../../apps/web/src/modules/reddit/fetchOrder.ts';

const SUBS = ['stake', 'sportsbetting', 'onlinegambling', 'poker', 'casino'];
const T = 1_800_000_000_000;
const ok = (atMs) => ({ atMs, ok: true, okAtMs: atMs });

test('with nothing recorded the order is the one in Settings', () => {
  assert.deepEqual(fetchOrder(SUBS, {}, 'new'), SUBS);
});

test('the subreddits a run never reached go first on the next one', () => {
  // The last run got through the first three and was cut short.
  const state = { new: { stake: ok(T), sportsbetting: ok(T + 1), onlinegambling: ok(T + 2) } };
  assert.deepEqual(fetchOrder(SUBS, state, 'new'), ['poker', 'casino', 'stake', 'sportsbetting', 'onlinegambling']);
});

test('a subreddit that failed is as overdue as it was before it failed', () => {
  // poker was last fetched yesterday and failed just now; the rest are fresh.
  const day = 86_400_000;
  const state = {
    new: {
      stake: ok(T),
      sportsbetting: ok(T),
      onlinegambling: ok(T),
      casino: ok(T),
      poker: nextFetchRecord(ok(T - day), false, T),
    },
  };
  assert.equal(fetchOrder(SUBS, state, 'new')[0], 'poker');
  // A failure never makes a community look freshly fetched.
  assert.deepEqual(nextFetchRecord(ok(T - day), false, T), { atMs: T, ok: false, okAtMs: T - day });
  assert.deepEqual(nextFetchRecord(undefined, false, T), { atMs: T, ok: false, okAtMs: 0 });
  assert.deepEqual(nextFetchRecord(ok(T - day), true, T), { atMs: T, ok: true, okAtMs: T });
});

test('the oldest successful fetch goes first, whatever the list order', () => {
  const state = { new: { stake: ok(T + 50), sportsbetting: ok(T + 10), onlinegambling: ok(T + 40), poker: ok(T + 30), casino: ok(T + 20) } };
  assert.deepEqual(fetchOrder(SUBS, state, 'new'), ['sportsbetting', 'casino', 'poker', 'onlinegambling', 'stake']);
});

test('a search and a plain fetch keep separate records', () => {
  const state = { search: { stake: ok(T) } };
  assert.deepEqual(fetchOrder(SUBS, state, 'new'), SUBS);
  assert.equal(fetchOrder(SUBS, state, 'search').at(-1), 'stake');
});

test('names are matched whatever their case', () => {
  const state = normalizeFetchState({ new: { Stake: { atMs: T, ok: true, okAtMs: T } } });
  assert.equal(fetchOrder(['Stake', 'poker'], state, 'new')[0], 'poker');
});

test('a damaged record reads as never fetched rather than crashing', () => {
  assert.deepEqual(normalizeFetchState(undefined), {});
  assert.deepEqual(normalizeFetchState('nonsense'), {});
  const state = normalizeFetchState({ new: { stake: 'x', poker: { atMs: 'y', ok: 'yes', okAtMs: -4 } }, other: {} });
  assert.deepEqual(state, { new: { poker: { atMs: 0, ok: false, okAtMs: 0 } } });
});

test('the missed list is short enough to read', () => {
  assert.equal(listSubreddits(['a', 'b']), 'r/a, r/b');
  assert.equal(listSubreddits(['a', 'b', 'c', 'd', 'e', 'f']), 'r/a, r/b, r/c, r/d and 2 more');
});
