// Which threads count as already looked at — so a scan never opens, pays for
// and drafts the same thread twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RECHECK_TOO_YOUNG_MS, seenThreadIds } from '../../apps/web/src/modules/forum/reply/drafts.ts';
import { explainTraceLine } from '../../apps/web/src/modules/forum/reply/explain.ts';

const NOW = Date.UTC(2026, 9, 16, 9);
const rec = (over) => ({ thread: null, trace: [], createdAtMs: NOW - 60_000, ...over });

test('a thread with a record is seen, whatever happened to the draft', () => {
  const seen = seenThreadIds(
    [
      rec({ status: 'pending', thread: { redditPostId: '1x6xno2' } }),
      rec({ status: 'rejected', thread: { redditPostId: 't3_1x6lqht' } }),
      rec({ status: 'skipped', thread: { redditPostId: '1x6k36c' } }),
    ],
    NOW,
  );
  assert.deepEqual([...seen].sort(), ['1x6k36c', '1x6lqht', '1x6xno2']);
});

test('a thread a scan opened and turned down is seen', () => {
  const seen = seenThreadIds(
    [rec({ trace: ['read 1x78kw4: rejected — media', 'read 1x768js: gone since the listing', 'read 1x6uws9: ok (score 0.98)'] })],
    NOW,
  );
  assert.ok(seen.has('1x78kw4'));
  assert.ok(seen.has('1x768js'));
  // Read and accepted is the record's own thread, not a trace rejection.
  assert.ok(!seen.has('1x6uws9'));
});

test('a thread turned down only for being too new comes back later', () => {
  const line = ['read 1abc: rejected — too-young'];
  assert.ok(seenThreadIds([rec({ trace: line })], NOW).has('1abc'));
  assert.ok(!seenThreadIds([rec({ trace: line, createdAtMs: NOW - RECHECK_TOO_YOUNG_MS - 1 })], NOW).has('1abc'));
});

test('the skip reads plainly in the panel', () => {
  assert.equal(explainTraceLine('seen before: 3 thread(s) skipped'), 'Skipped 3 threads an earlier scan already looked at.');
});
