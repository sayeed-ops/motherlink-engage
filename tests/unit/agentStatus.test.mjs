// The agent chip, reading either heartbeat shape.
//
// An agent from before poster-agent-concurrency writes one `current`; a newer
// one writes `running[]` and `slots`. The app and the agent are deployed
// separately — Vercel on one side, a restart on the posting Mac on the other —
// so for a while each will meet the other's older self.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readAgentStatus } from '../../apps/web/src/lib/agentStatus.ts';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const seen = (msAgo) => ({ toMillis: () => NOW - msAgo });
const job = (id, over = {}) => ({ jobId: id, kind: 'post', subreddit: 'shopify', expectedUsername: 'u1', startedAtMs: NOW - 120_000, stage: 'posting', ...over });

test('an older agent with a single `current` still renders', () => {
  const s = readAgentStatus({ lastSeenAt: seen(2000), queued: 2, current: job('a') }, NOW);
  assert.equal(s.online, true);
  assert.equal(s.busy, true);
  assert.equal(s.running.length, 1);
  assert.equal(s.slots, 1);
  assert.match(s.activity, /posting r\/shopify · 2m · 2 waiting/);
});

test('a newer agent running two jobs says so', () => {
  const s = readAgentStatus(
    { lastSeenAt: seen(2000), queued: 1, slots: 2, running: [job('a'), job('b', { kind: 'warmup', stage: 'warming up' })], current: job('a') },
    NOW,
  );
  assert.equal(s.running.length, 2);
  assert.equal(s.current.jobId, 'a');
  assert.equal(s.activity, '2 of 2 running · 1 waiting');
});

test('an empty running list is idle, even if a stale `current` is left over', () => {
  // `running` wins over `current` when present — the newer agent deletes
  // `current` when idle, but a merge-write that lost that delete must not
  // resurrect a finished job.
  const s = readAgentStatus({ lastSeenAt: seen(2000), queued: 0, slots: 2, running: [], current: job('old') }, NOW);
  assert.equal(s.busy, false);
  assert.equal(s.activity, 'idle');
});

test('a stale heartbeat shows nothing running, whatever the doc says', () => {
  const s = readAgentStatus({ lastSeenAt: seen(60_000), running: [job('a')], current: job('a') }, NOW);
  assert.equal(s.online, false);
  assert.equal(s.running.length, 0);
  assert.equal(s.current, null);
});
