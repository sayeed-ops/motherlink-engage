// Two faults found in comment-karma scans on 2026-10-16.
//
//   - A length band whose floor sat above its ceiling ("band 23–8"), so every
//     candidate failed the length check.
//   - Network failures filed as a bare "terminated" / "fetch failed", with no
//     word on which service dropped the line or why, and no second try.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capLength } from '../../apps/web/src/modules/forum/reply/roomProfile.ts';
import { describeNetworkError, isTransientNetworkError, withNetworkRetry } from '../../apps/web/src/lib/netError.ts';

const dropped = (message, code, why) => Object.assign(new TypeError(message), { cause: Object.assign(new Error(why), { code }) });

test('a ceiling below the floor brings the floor down with it', () => {
  const band = capLength({ min: 23, max: 80, target: 53 }, 8);
  assert.equal(band.max, 8);
  assert.ok(band.min <= band.max, JSON.stringify(band));
  assert.ok(band.target >= band.min && band.target <= band.max, JSON.stringify(band));
});

test('a ceiling that leaves room changes only the top', () => {
  assert.deepEqual(capLength({ min: 10, max: 60, target: 30 }, 40), { min: 10, max: 40, target: 30 });
  assert.deepEqual(capLength({ min: 10, max: 60, target: 30 }, 20), { min: 10, max: 20, target: 20 });
});

test('no ceiling, no change', () => {
  const band = { min: 23, max: 80, target: 53 };
  assert.equal(capLength(band, null), band);
});

test('every band the cap can produce is passable', () => {
  for (let min = 2; min < 120; min += 7) {
    for (let ceiling = 8; ceiling < 120; ceiling += 5) {
      const b = capLength({ min, max: min + 40, target: min + 15 }, ceiling);
      assert.ok(b.min >= 2 && b.min <= b.max && b.target >= b.min && b.target <= b.max, JSON.stringify({ min, ceiling, b }));
    }
  }
});

test('a dropped line says which service and why', () => {
  const err = dropped('terminated', 'UND_ERR_SOCKET', 'other side closed');
  assert.equal(describeNetworkError('Reddit feed r/travel new (via proxy)', err), 'Reddit feed r/travel new (via proxy): terminated (UND_ERR_SOCKET other side closed)');
  assert.equal(describeNetworkError('Crawlzo', new TypeError('fetch failed')), 'Crawlzo: fetch failed');
});

test('a dropped line is transient; an answer from the service is not', () => {
  assert.ok(isTransientNetworkError(new TypeError('terminated')));
  assert.ok(isTransientNetworkError(new TypeError('fetch failed')));
  assert.ok(isTransientNetworkError(dropped('socket hang up', 'ECONNRESET', 'reset')));
  assert.ok(!isTransientNetworkError(new Error('r/travel new feed: HTTP 403')));
  assert.ok(!isTransientNetworkError(new SyntaxError('Unexpected token')));
});

test('a dropped line is tried once more, and only once', async () => {
  let calls = 0;
  assert.equal(await withNetworkRetry(async () => (++calls === 1 ? Promise.reject(new TypeError('terminated')) : 'ok'), { delayMs: 1 }), 'ok');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw new TypeError('fetch failed'); }, { delayMs: 1 }), /fetch failed/);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(withNetworkRetry(async () => { calls++; throw new Error('HTTP 500'); }, { delayMs: 1 }), /HTTP 500/);
  assert.equal(calls, 1);
});
