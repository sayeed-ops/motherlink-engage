// Verify the poster agent's Firestore wiring against Engage — WITHOUT a browser.
//
// The browser automation (AdsPower, old.reddit posting) can only be checked on
// the posting Mac. But the part that CHANGED in the port — the Engage collection
// paths for the heartbeat, the queue claim, and the success write-back — is pure
// Firestore and testable here. This seeds a job on a throwaway project, exercises
// agent-core against Engage, and asserts every write lands where the app reads.
//
//   cd tools && node e2e-poster-agent.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore, gate, nextCounters } from '../apps/poster-agent/agent-core.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();
const store = createStore({ db, FieldValue, Timestamp });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- pure rails ---
console.log('1. rails (pure)');
const acct0 = { status: 'active', dailyCap: 5, minIntervalMinutes: 45, postCountToday: 0, postCountResetAt: Timestamp.now(), lastPostAt: null };
check(gate(acct0, Date.now()).ok === true, 'active account may post');
check(gate({ ...acct0, status: 'banned' }, Date.now()).hard === true, 'banned is a hard block');
check(gate({ ...acct0, lastPostAt: Timestamp.fromMillis(Date.now() - 10 * 60000) }, Date.now()).hard === false, 'interval block is soft (defer, not fail)');
const nc = nextCounters(acct0, Date.now(), Timestamp, FieldValue);
check(nc.postCountToday === 1, 'nextCounters increments the daily count');

// --- seed a throwaway project + job ---
const pid = `e2e-agent-${Date.now()}`;
const proj = db.collection('projects').doc(pid);
await proj.set({ projectId: pid, name: 'e2e-agent', status: 'active', enabledModules: ['reddit'], migratedFrom: null });
const itemId = `${pid}_A1`;
await proj.collection('items').doc(itemId).set({ itemId, projectId: pid, platform: 'reddit', externalId: 'A1', subreddit: 'budget', processingStatus: 'drafted', isFavorite: false });
const draftRef = proj.collection('drafts').doc();
await draftRef.set({ draftId: draftRef.id, projectId: pid, itemId, body: 'reply', status: 'draft', createdAt: FieldValue.serverTimestamp() });
const acctRef = db.collection('accounts').doc();
await acctRef.set({ accountId: acctRef.id, label: 'e2e-agent-acct', username: 'guy', adsPowerProfileId: 'k1', status: 'active', dailyCap: 5, minIntervalMinutes: 45, postCountToday: 0, postCountResetAt: Timestamp.now(), lastPostAt: null, karma: 0, notes: '', createdBy: 'e2e', createdByName: 'e2e', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
const jobRef = db.collection('jobs').doc();
await jobRef.set({
  jobId: jobRef.id, projectId: pid, postId: itemId, draftId: draftRef.id, redditPostId: 'A1',
  subreddit: 'budget', threadUrl: 'https://reddit.com/r/budget/comments/A1/x', accountId: acctRef.id,
  adsPowerProfileId: 'k1', expectedUsername: 'guy', body: 'reply', status: 'queued', attempts: 0,
  createdBy: 'e2e', createdByName: 'e2e', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
});

// --- heartbeat lands where the app reads it ---
console.log('\n2. heartbeat → agents/agent');
await store.heartbeat({ dryRun: true, queued: 1, postedSession: 0, pid: 12345 });
const hb = (await db.collection('agents').doc('agent').get()).data();
check(!!hb?.lastSeenAt, 'agents/agent heartbeat written');
check(hb?.dryRun === true && hb?.queued === 1, 'heartbeat carries dryRun + queued');

// --- success write-back hits the nested Engage paths ---
console.log('\n3. writeSuccess → job / draft / item / account');
const job = (await jobRef.get()).data();
const account = (await acctRef.get()).data();
await store.writeSuccess(jobRef, job, account, 'https://reddit.com/r/budget/comments/A1/x/c1');
const j = (await jobRef.get()).data();
const d = (await draftRef.get()).data();
const it = (await proj.collection('items').doc(itemId).get()).data();
const ac = (await acctRef.get()).data();
check(j.status === 'posted' && j.permalink?.endsWith('/c1'), 'job → posted + permalink');
check(d.status === 'posted' && d.postedByAccountId === acctRef.id && !!d.postedAt, 'draft → posted + attribution (answered ledger)');
check(it.processingStatus === 'drafted', 'item → drafted');
check(ac.postCountToday === 1 && !!ac.lastPostAt, 'account counter advanced');

// --- cleanup (incl. the heartbeat doc, so the chip does not read a stale agent) ---
await jobRef.delete();
await acctRef.delete();
await db.recursiveDelete(proj);
await db.collection('agents').doc('agent').delete();

console.log(`\n${failures === 0 ? 'Agent wiring OK' : `${failures} FAILURE(S)`}: heartbeat, rails, and success write-back use Engage's schema.`);
console.log('(Browser posting via AdsPower/old.reddit is verified separately, on the Mac, in dry run.)');
process.exit(failures === 0 ? 0 : 1);
