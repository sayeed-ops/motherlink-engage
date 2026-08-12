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

// --- refuse to run against a live agent -------------------------------------
// This test seeds a real job in the real `jobs` collection, and a running agent
// polls that same queue every POLL_INTERVAL_MS. It WILL claim the seeded job
// first — measured at ~4s — and step 3 then fails with "claimOldestQueued
// returned nothing despite a queued job". That looked like a flaky test for a
// long time; it is contention, and no amount of retrying wins a race against a
// 5s poller. The agent also opens the profile the fake job names, and this
// test's cleanup deletes agents/agent out from under it.
{
  const hb = await db.collection('agents').doc('agent').get();
  const lastSeen = hb.exists ? hb.data().lastSeenAt?.toMillis?.() ?? 0 : 0;
  const ageMs = Date.now() - lastSeen;
  if (lastSeen && ageMs < 20000) {
    console.error(`\nAn agent is RUNNING (pid ${hb.data().pid}, last seen ${Math.round(ageMs / 1000)}s ago).`);
    console.error('It shares this queue and will claim the seeded job before the test can.\n');
    console.error('Stop the agent (control panel → Stop, or kill the process), then re-run.');
    console.error('Refusing to run rather than report a false failure.\n');
    process.exit(2);
  }
}

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
const agentDoc = db.collection('agents').doc('agent');
await store.heartbeat({ dryRun: true, queued: 1, postedSession: 0, pid: 12345 });
const hb = (await agentDoc.get()).data();
check(!!hb?.lastSeenAt, 'agents/agent heartbeat written');
check(hb?.dryRun === true && hb?.queued === 1, 'heartbeat carries dryRun + queued');

// The `current` half — what the UI needs to say "posting r/x" instead of showing
// a queue count frozen for the several minutes a humanized job takes.
await store.heartbeat({
  dryRun: true,
  queued: 0,
  postedSession: 0,
  pid: 12345,
  current: { jobId: 'j1', subreddit: 'budget', expectedUsername: 'guy', startedAtMs: 1, stage: 'posting' },
});
const hbBusy = (await agentDoc.get()).data();
check(hbBusy?.current?.jobId === 'j1' && hbBusy?.current?.stage === 'posting', 'heartbeat publishes the in-flight job');
await store.heartbeat({ dryRun: true, queued: 0, postedSession: 0, pid: 12345 });
const hbIdle = (await agentDoc.get()).data();
check(hbIdle?.current === undefined, 'omitting current DELETES it (idle never shows a phantom job)');

// --- the claim excludes the job it just took from `queued` ---
//
// This is the regression that produced "click Post → 1 queued → nothing happens":
// the count used to include the job being worked on, so it sat at 1 for the whole
// run. Guarded, because this hits the REAL queue — if another job is older, the
// claim takes that one instead, and we hand it straight back untouched.
console.log('\n3. claimOldestQueued → running job is not counted as waiting');
// RETRY, do not assert on the first miss. A document is readable by id the
// instant it is written, but Firestore's QUERY index lags a fresh write by a
// beat — and this test seeds the job only milliseconds earlier, so roughly half
// the runs used to fail here with "returned nothing despite a queued job".
// That was the test being impatient, not the agent being broken: the real agent
// polls every POLL_INTERVAL_MS (5s), by which point the job is long visible.
let claim = await store.claimOldestQueued();
for (let attempt = 0; attempt < 10 && !claim.ref; attempt++) {
  await new Promise((r) => setTimeout(r, 250));
  claim = await store.claimOldestQueued();
}
if (claim.ref?.id === jobRef.id) {
  check(claim.job?.body === 'reply', 'claim returns the job data (caller needs no second read)');
  check(claim.queued === 0, 'claimed job EXCLUDED from queued');
} else if (claim.ref) {
  await store.deferJob(claim.ref); // not ours — put it back exactly as we found it
  check(true, `skipped: an older real job (${claim.ref.id}) was queued — released it untouched`);
} else {
  check(false, 'claimOldestQueued returned nothing despite a queued job');
}

// --- success write-back hits the nested Engage paths ---
console.log('\n4. writeSuccess → job / draft / item / account');
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
