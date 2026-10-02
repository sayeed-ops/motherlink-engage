// The agent's queue, claims and locks against a REAL Firestore — the emulator.
//
// The unit tests prove the decisions; only a database proves the transactions.
// "Two claims cannot both take one account" is a property of how claimNext
// reads the running set INSIDE its transaction, and no fake store can show that.
//
// Run: npm run test:agent   (starts the Firestore emulator; touches nothing live)

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// firebase-admin from the agent's own install, so this tests the version the
// agent actually runs.
const require = createRequire(new URL('../apps/poster-agent/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

import { createStore } from '../apps/poster-agent/agent-core.mjs';
import { lockKeysFor } from '../apps/poster-agent/scheduler.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real database.');
}

const app = initializeApp({ projectId: 'motherlink-engage-test' }, 'agent-store-test');
const db = getFirestore(app);
const store = createStore({ db, FieldValue, Timestamp });

const MIN = 60_000;
const W = { heartbeatStaleMs: 3 * MIN, legacyStaleMs: 20 * MIN };

// Profile → IP, as AdsPower would report it. P1 and P2 share an IP.
const IP = { P1: ['ip:shared'], P2: ['ip:shared'], P3: ['ip:three'], P4: ['ip:four'] };
const keysFor = (job) => lockKeysFor(job, IP[job.adsPowerProfileId] || null);
// Returns the claimed job's ID, never the DocumentReference: a failing assert
// on a reference makes node:test inspect the whole Firestore client, which never
// finishes — a broken lock then showed up as a 20s hang instead of a failure.
const claim = async (agentId = 'mac-test') => {
  const r = await store.claimNext({ agentId, keysFor, nowMs: Date.now(), ...W });
  return { ...r, id: r.ref?.id ?? null, ref: undefined, docRef: r.ref, job: undefined };
};

async function clear() {
  const snap = await db.collection('jobs').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function job(id, over = {}) {
  await db.collection('jobs').doc(id).set({
    status: 'queued',
    kind: 'post',
    accountId: 'A1',
    adsPowerProfileId: 'P1',
    createdAt: Timestamp.fromMillis(Date.now() - MIN),
    ...over,
  });
}

const statusOf = async (id) => (await db.collection('jobs').doc(id).get()).data();

before(clear);
beforeEach(clear);
after(async () => {
  await clear();
  await deleteApp(app);
});

test('a claim writes its locks, its heartbeat and who claimed it', async () => {
  await job('j1', { accountId: 'A1', adsPowerProfileId: 'P3' });
  const c = await claim('mac-a');
  assert.equal(c.id, 'j1');
  const d = await statusOf('j1');
  assert.equal(d.status, 'posting');
  assert.equal(d.claimedBy, 'mac-a');
  assert.deepEqual(d.lockKeys, ['account:A1', 'profile:P3', 'ip:three']);
  assert.ok(d.heartbeatAt, 'no heartbeat on claim — the lock would look dead at once');
  assert.equal(d.platform, 'reddit');
  assert.equal(d.attempts, 1);
});

test('the same account never runs twice, even when two jobs are due', async () => {
  await job('reply', { accountId: 'A1', adsPowerProfileId: 'P3' });
  await job('warm', { kind: 'warmup', accountId: 'A1', adsPowerProfileId: 'P3' });
  const first = await claim();
  assert.equal(first.id, 'reply', 'replies go first');
  const second = await claim();
  assert.equal(second.id, null);
  assert.equal(second.blocked, 1, 'the warm-up should be reported as held by a lock');
  assert.equal((await statusOf('warm')).status, 'queued');
});

test('two accounts on the SAME IP do not overlap; on different IPs they do', async () => {
  await job('a', { accountId: 'A1', adsPowerProfileId: 'P1' });
  await job('b', { accountId: 'A2', adsPowerProfileId: 'P2' }); // same IP as P1
  await job('c', { accountId: 'A3', adsPowerProfileId: 'P3' });
  const taken = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await claim();
    if (c.id) taken.push(c.id);
  }
  assert.equal(taken.length, 2, `expected two to run, got ${taken.join(',')}`);
  assert.ok(taken.includes('c'));
  assert.ok(!(taken.includes('a') && taken.includes('b')), 'two accounts ran on one IP at once');
});

test('RACE: two agents grabbing DIFFERENT jobs for one account at the same instant — only one runs', async () => {
  // The case that actually needs the transaction. Each agent sees only the
  // profile on its own machine (keysFor → null for the other), so they go for
  // DIFFERENT documents at the same moment. Nothing about either document stops
  // the other claim; only reading the running set INSIDE the transaction can.
  // (The first version of this test had both agents reach for the same job, so
  // they serialised on that document and a lock read outside the transaction
  // still passed. Checked by mutation, not assumed.)
  const onlyProfile = (profile) => (j) => (j.adsPowerProfileId === profile ? lockKeysFor(j, IP[profile]) : null);
  const claimAs = async (agentId, profile) => {
    const r = await store.claimNext({ agentId, keysFor: onlyProfile(profile), nowMs: Date.now(), ...W });
    return r.ref?.id ?? null;
  };
  let bothRan = 0;
  for (let round = 0; round < 8; round += 1) {
    await clear();
    await job('x', { accountId: 'A9', adsPowerProfileId: 'P3' });
    await job('y', { accountId: 'A9', adsPowerProfileId: 'P4' });
    const got = (await Promise.all([claimAs('mac-1', 'P3'), claimAs('mac-2', 'P4')])).filter(Boolean);
    const posting = (await db.collection('jobs').where('status', '==', 'posting').get()).size;
    assert.equal(got.length, posting, `round ${round}: claims reported ${got.length} but ${posting} are running`);
    if (posting > 1) bothRan += 1;
  }
  assert.equal(bothRan, 0, `one account ran on two machines at once in ${bothRan} of 8 rounds`);
});

test('RACE: two agents claiming one job — exactly one wins', async () => {
  await job('solo', { accountId: 'A5', adsPowerProfileId: 'P4' });
  const [r1, r2] = await Promise.all([claim('agent-1'), claim('agent-2')]);
  assert.equal([r1.id, r2.id].filter(Boolean).length, 1);
  assert.equal((await statusOf('solo')).attempts, 1);
});

test('a job scheduled for later is not claimed until it is due', async () => {
  await job('later', { accountId: 'A1', adsPowerProfileId: 'P3', notBeforeMs: Date.now() + 10 * MIN });
  const c = await claim();
  assert.equal(c.id, null);
  assert.equal(c.notDue, 1);
});

test('a deferred job releases its locks and waits until its retry time', async () => {
  await job('d', { accountId: 'A1', adsPowerProfileId: 'P3' });
  const c = await claim();
  const retryAt = Date.now() + 15 * MIN;
  await store.deferJob(c.docRef, retryAt);
  const d = await statusOf('d');
  assert.equal(d.status, 'queued');
  assert.equal(d.notBeforeMs, retryAt);
  for (const gone of ['lockKeys', 'claimedBy', 'heartbeatAt', 'claimedAt']) assert.equal(d[gone], undefined, `${gone} survived a defer`);
  assert.equal((await claim()).id, null, 'claimed again before its retry time');
});

test('a job cancelled while it was being checked is NOT re-queued by a defer', async () => {
  await job('cx', { accountId: 'A1', adsPowerProfileId: 'P3' });
  const c = await claim();
  await c.docRef.update({ status: 'cancelled' });
  await store.deferJob(c.docRef, Date.now() + MIN);
  assert.equal((await statusOf('cx')).status, 'cancelled');
});

test('a silent heartbeat frees the account and the job is reclaimed as failed', async () => {
  await job('dead', { accountId: 'A1', adsPowerProfileId: 'P3' });
  await job('next', { accountId: 'A1', adsPowerProfileId: 'P3', kind: 'warmup' });
  const c = await claim();
  assert.equal(c.id, 'dead');
  // The process died: no beat for four minutes.
  await c.docRef.update({ heartbeatAt: Timestamp.fromMillis(Date.now() - 4 * MIN) });

  const next = await claim();
  assert.equal(next.id, 'next', 'a dead job still held its account');

  // …and reclaim marks the dead one failed — but never a job this process runs.
  await db.collection('jobs').doc('next').update({ heartbeatAt: Timestamp.fromMillis(Date.now() - 4 * MIN) });
  const cleared = await store.reclaimStalePosting(20 * MIN, Date.now(), 15 * MIN, {
    heartbeatStaleMs: 3 * MIN,
    isRunningHere: (id) => id === 'next',
  });
  assert.equal(cleared, 1);
  assert.equal((await statusOf('dead')).status, 'failed');
  assert.match((await statusOf('dead')).error, /outcome unknown/);
  assert.equal((await statusOf('next')).status, 'posting', 'reclaimed a job this agent is still running');
});

test('a beating job is never reclaimed, however long it has been running', async () => {
  await job('long', { accountId: 'A1', adsPowerProfileId: 'P3' });
  const c = await claim();
  await c.docRef.update({ claimedAt: Timestamp.fromMillis(Date.now() - 60 * MIN) });
  await store.beatJob(c.docRef, 'typing');
  const cleared = await store.reclaimStalePosting(20 * MIN, Date.now(), 15 * MIN, { heartbeatStaleMs: 3 * MIN });
  assert.equal(cleared, 0);
  const d = await statusOf('long');
  assert.equal(d.status, 'posting');
  assert.equal(d.stage, 'typing');
});

test('a job claimed by an OLDER agent (no lock keys, no heartbeat) still blocks its account', async () => {
  await db.collection('jobs').doc('legacy').set({
    status: 'posting',
    kind: 'post',
    accountId: 'A1',
    adsPowerProfileId: 'P3',
    claimedAt: Timestamp.fromMillis(Date.now() - 5 * MIN),
  });
  await job('new', { accountId: 'A1', adsPowerProfileId: 'P4' });
  const c = await claim();
  assert.equal(c.id, null, 'ran alongside an old agent on the same account');
  assert.equal(c.blocked, 1);
});

test('the control read tells a failure apart from an empty doc', async () => {
  await db.collection('agents').doc('control').delete().catch(() => {});
  assert.deepEqual(await store.readControl(), { ok: true, data: {} });
  await db.collection('agents').doc('control').set({ dryRun: false });
  const r = await store.readControl();
  assert.equal(r.ok, true);
  assert.equal(r.data.dryRun, false);
  await db.collection('agents').doc('control').delete();
});

// --- Shopify Community -------------------------------------------------------

test('a Shopify job and a Reddit job on the SAME AdsPower profile never run together', async () => {
  // One browser signed in to both sites (a real setup on the posting Mac): different accounts,
  // different platforms, one profile. The profile lock is what keeps them apart.
  await job('reddit-reply', { accountId: 'reddit-acct', adsPowerProfileId: 'P3' });
  await job('shopify-reply', { accountId: 'shopify-acct', adsPowerProfileId: 'P3', platform: 'shopify' });
  const first = await claim();
  const second = await claim();
  assert.ok(first.id, 'nothing claimed');
  assert.equal(second.id, null, 'both ran on one browser at once');
  assert.equal(second.blocked, 1);
  assert.equal((await statusOf('shopify-reply')).platform ?? (await statusOf('reddit-reply')).platform, 'shopify');
});

test('a Shopify success marks the job posted, the SHOPIFY draft posted, and advances the account', async () => {
  const pid = 'proj-shopify-test';
  await db.collection('projects').doc(pid).collection('shopifyDrafts').doc('d1').set({ draftId: 'd1', status: 'approved', text: 'x' });
  await db.collection('accounts').doc('sa1').set({ platform: 'shopify', postCountToday: 0, dailyCap: 3 });
  await job('sj', { accountId: 'sa1', adsPowerProfileId: 'P4', platform: 'shopify', projectId: pid, draftId: 'd1', expectedUsername: 'merchant_helper' });
  const c = await claim();
  const jobData = (await c.docRef.get()).data();
  const account = (await db.collection('accounts').doc('sa1').get()).data();
  await store.writeShopifySuccess(c.docRef, jobData, account, 'https://community.shopify.com/t/x/1/9', [{ type: 'reply', ok: true }]);

  const j = await statusOf('sj');
  assert.equal(j.status, 'posted');
  assert.equal(j.permalink, 'https://community.shopify.com/t/x/1/9');
  const d = (await db.collection('projects').doc(pid).collection('shopifyDrafts').doc('d1').get()).data();
  assert.equal(d.status, 'posted');
  assert.equal(d.postedPermalink, 'https://community.shopify.com/t/x/1/9');
  assert.equal(d.postedByUsername, 'merchant_helper');
  assert.equal((await db.collection('accounts').doc('sa1').get()).data().postCountToday, 1);
  const redditDraft = await db.collection('projects').doc(pid).collection('drafts').doc('d1').get();
  assert.equal(redditDraft.exists, false, 'wrote to the Reddit drafts collection');
  await db.collection('projects').doc(pid).collection('shopifyDrafts').doc('d1').delete();
  await db.collection('accounts').doc('sa1').delete();
});
