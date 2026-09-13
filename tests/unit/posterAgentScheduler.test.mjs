// What the agent may run, and when — the decisions behind running jobs in
// parallel.
//
// The assertions that are really policy:
//   - a FAILED read of the control doc is dry run, never live;
//   - a missing DRY_RUN line is dry run, never live;
//   - a platform other than Reddit is dry until explicitly switched live;
//   - two live jobs never share an account, a profile, or an IP.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  envDryRunDefault,
  findConflict,
  ipKeysFromAdsPower,
  isDue,
  isLive,
  lockKeysFor,
  orderCandidates,
  resolveDryRun,
} from '../../apps/poster-agent/scheduler.mjs';
import { commentGate, gate } from '../../apps/poster-agent/agent-core.mjs';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
const MIN = 60_000;
const ts = (ms) => ({ toMillis: () => ms });
const windows = { heartbeatStaleMs: 3 * MIN, legacyStaleMs: 20 * MIN };

// --- dry run ----------------------------------------------------------------

test('only an explicit DRY_RUN=0 means live', () => {
  assert.equal(envDryRunDefault('0'), false);
  assert.equal(envDryRunDefault(' 0 '), false);
  for (const v of [undefined, '', '1', 'false', 'no', 'off']) {
    assert.equal(envDryRunDefault(v), true, `DRY_RUN=${JSON.stringify(v)} posted for real`);
  }
});

test('a FAILED control read is dry run whatever the env says — the 2026-09-01 bug', () => {
  // The old readDryRunOverride() returned null on error and the caller fell back
  // to the env default, which was live when DRY_RUN was unset.
  assert.equal(resolveDryRun({ ok: false }, 'reddit', false), true);
  assert.equal(resolveDryRun(undefined, 'reddit', false), true);
  assert.equal(resolveDryRun(null, 'shopify', false), true);
});

test('Reddit follows agents/control.dryRun, then the env default', () => {
  assert.equal(resolveDryRun({ ok: true, data: { dryRun: false } }, 'reddit', true), false);
  assert.equal(resolveDryRun({ ok: true, data: { dryRun: true } }, 'reddit', false), true);
  assert.equal(resolveDryRun({ ok: true, data: {} }, 'reddit', false), false, 'unset control uses the env default');
  assert.equal(resolveDryRun({ ok: true, data: {} }, undefined, true), true, 'no platform is Reddit');
});

test('a new platform does not inherit Reddit going live', () => {
  const live = { ok: true, data: { dryRun: false } };
  assert.equal(resolveDryRun(live, 'shopify', false), true);
  assert.equal(resolveDryRun({ ok: true, data: { dryRun: false, dryRunByPlatform: { shopify: 'false' } } }, 'shopify', false), true, 'only the boolean false switches it');
  assert.equal(resolveDryRun({ ok: true, data: { dryRun: true, dryRunByPlatform: { shopify: false } } }, 'shopify', true), false);
});

// --- due and order ------------------------------------------------------------

test('a job scheduled for later is not due; one without a time is', () => {
  assert.ok(isDue({}, NOW));
  assert.ok(isDue({ notBeforeMs: NOW }, NOW));
  assert.ok(!isDue({ notBeforeMs: NOW + 1 }, NOW));
  assert.ok(isDue({ notBeforeMs: 'garbage' }, NOW));
});

test('candidates: due only, replies before comments before warm-ups, then by due time', () => {
  const docs = [
    { id: 'warm-old', data: { kind: 'warmup', createdAt: ts(NOW - 60 * MIN) } },
    { id: 'post-later', data: { kind: 'post', notBeforeMs: NOW + 5 * MIN, createdAt: ts(NOW - 90 * MIN) } },
    { id: 'post-new', data: { createdAt: ts(NOW - 1 * MIN) } },
    { id: 'post-sched', data: { kind: 'post', notBeforeMs: NOW - 30 * MIN, createdAt: ts(NOW - 2 * MIN) } },
    { id: 'comment', data: { kind: 'comment', createdAt: ts(NOW - 100 * MIN) } },
  ];
  assert.deepEqual(orderCandidates(docs, NOW).map((d) => d.id), ['post-sched', 'post-new', 'comment', 'warm-old']);
});

// --- lock keys ----------------------------------------------------------------

const prof = (proxy, ip) => ({ user_proxy_config: proxy, ip });

test('profiles with no proxy share the machine IP, so they lock each other', () => {
  const a = ipKeysFromAdsPower(prof({ proxy_soft: 'no_proxy' }), 'mac-1');
  const b = ipKeysFromAdsPower(prof({}), 'mac-1');
  assert.deepEqual(a, b);
  assert.notDeepEqual(ipKeysFromAdsPower(prof({}), 'mac-2'), a, 'another machine is another IP');
});

test('one gateway host, different sticky usernames → different IP keys', () => {
  const base = { proxy_soft: 'other', proxy_type: 'http', proxy_host: 'gw.example.net', proxy_port: '7777' };
  const a = ipKeysFromAdsPower(prof({ ...base, proxy_user: 'session-a' }), 'm');
  const b = ipKeysFromAdsPower(prof({ ...base, proxy_user: 'session-b' }), 'm');
  assert.notDeepEqual(a, b);
  assert.deepEqual(ipKeysFromAdsPower(prof({ ...base, proxy_host: 'GW.example.net ', proxy_user: 'session-a' }), 'm'), a, 'case and whitespace do not make a new IP');
});

test('two sessions that landed on the same exit IP collide on that IP', () => {
  const base = { proxy_soft: 'other', proxy_type: 'http', proxy_host: 'gw.example.net', proxy_port: '7777' };
  const a = ipKeysFromAdsPower(prof({ ...base, proxy_user: 'a' }, '203.0.113.9'), 'm');
  const b = ipKeysFromAdsPower(prof({ ...base, proxy_user: 'b' }, '203.0.113.9'), 'm');
  assert.ok(a.some((k) => b.includes(k)));
});

test('lock keys never carry a proxy credential in the clear', () => {
  const keys = ipKeysFromAdsPower(prof({ proxy_soft: 'other', proxy_host: 'gw.example.net', proxy_user: 'SECRET-USER', proxy_password: 'SECRET-PASS' }, '203.0.113.9'), 'm');
  const all = keys.join(' ');
  for (const leak of ['SECRET', 'gw.example.net', '203.0.113.9']) assert.ok(!all.includes(leak), `${leak} is readable in a lock key`);
});

test('a job locks its account and profile, plus any IP keys, without duplicates', () => {
  assert.deepEqual(lockKeysFor({ accountId: 'A', adsPowerProfileId: 'P' }, ['ip:1', 'ip:1']), ['account:A', 'profile:P', 'ip:1']);
  assert.deepEqual(lockKeysFor({ accountId: 'A', adsPowerProfileId: 'P' }, null), ['account:A', 'profile:P']);
});

// --- conflicts ----------------------------------------------------------------

const runningJob = (id, keys, beatAgoMs) => ({ id, keys, data: { heartbeatAt: ts(NOW - beatAgoMs) } });

test('a live job holding the same account blocks the candidate', () => {
  const c = findConflict(['account:A', 'profile:P2', 'ip:x'], [runningJob('j1', ['account:A', 'profile:P1', 'ip:y'], 10_000)], NOW, windows);
  assert.deepEqual(c, { key: 'account:A', jobId: 'j1' });
});

test('different accounts on the same IP are blocked; on different IPs they are not', () => {
  const run = [runningJob('j1', ['account:A', 'profile:P1', 'ip:same'], 10_000)];
  assert.equal(findConflict(['account:B', 'profile:P2', 'ip:same'], run, NOW, windows)?.key, 'ip:same');
  assert.equal(findConflict(['account:B', 'profile:P2', 'ip:other'], run, NOW, windows), null);
});

test('a job whose heartbeat went silent no longer holds its locks', () => {
  const run = [runningJob('dead', ['account:A'], 4 * MIN)];
  assert.equal(findConflict(['account:A'], run, NOW, windows), null);
});

test('a job from an older agent (no heartbeat) holds its locks through the old claim window', () => {
  const legacy = { id: 'old', keys: ['account:A'], data: { claimedAt: ts(NOW - 10 * MIN) } };
  assert.ok(findConflict(['account:A'], [legacy], NOW, windows), 'freed after 10 minutes — the old agent may still be typing');
  assert.ok(!isLive({ claimedAt: ts(NOW - 25 * MIN) }, NOW, windows));
  assert.ok(!isLive({}, NOW, windows), 'no heartbeat and no claim time is not running');
});

// --- rails say when to come back ---------------------------------------------

test('a soft rail says when it clears, so a deferred job waits instead of spinning', () => {
  const g = gate({ status: 'active', dailyCap: 5, minIntervalMinutes: 30, lastPostAt: ts(NOW - 10 * MIN) }, NOW);
  assert.equal(g.ok, false);
  assert.equal(g.hard, false);
  assert.equal(g.retryAtMs, NOW + 20 * MIN);

  const c = commentGate({ status: 'active', commentKarma: { minIntervalMinutes: 90 }, lastCommentAt: ts(NOW - 30 * MIN) }, NOW);
  assert.equal(c.hard, false);
  assert.equal(c.retryAtMs, NOW + 60 * MIN);
});

test('a hard rail carries no retry time — it is not coming back today', () => {
  const g = gate({ status: 'active', dailyCap: 1, postCountToday: 1, postCountResetAt: ts(NOW - MIN) }, NOW);
  assert.equal(g.hard, true);
  assert.equal(g.retryAtMs, undefined);
});
