// Publish enqueue against a running dev server: POST reddit/jobs writes a queued
// job to the top-level queue, re-checking the account rate gate server-side and
// refusing to double-queue a draft. NOTHING posts — no agent drains the queue,
// and Engage's queue is a separate database from ML Studio's — so this only
// proves the enqueue plumbing.
//
// Runs on a throwaway project + throwaway accounts it cleans up. Usage:
//   cd tools && node e2e-reddit-publish.mjs   (dev server up)

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
const env = readFileSync(join(import.meta.dirname, '..', 'apps', 'web', '.env.local'), 'utf8');
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)[1].trim();

initializeApp({ credential: cert(key), projectId: key.project_id });
const auth = getAuth();
const db = getFirestore();
const user = await auth.getUserByEmail('sayeed@motherlink.io');
const custom = await auth.createCustomToken(user.uid);
const { idToken } = await (
  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  })
).json();

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` };
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: H });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

// throwaway project + a draft on a real item
const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `e2e-publish ${Date.now()}` }) });
const pid = created.body.projectId;
const proj = db.collection('projects').doc(pid);
await proj.collection('items').doc(`${pid}_P1`).set({
  itemId: `${pid}_P1`, projectId: pid, platform: 'reddit', externalId: 'P1', subreddit: 'budget',
  title: 't', body: '', author: 'x', permalink: 'https://reddit.com/r/budget/comments/P1/x', url: '',
  processingStatus: 'drafted', isFavorite: false, createdAtSource: FieldValue.serverTimestamp(),
  fetchedAt: FieldValue.serverTimestamp(), createdBy: user.uid,
});
const draftRef = proj.collection('drafts').doc();
await draftRef.set({ draftId: draftRef.id, projectId: pid, itemId: `${pid}_P1`, body: 'the reply', status: 'draft', createdAt: FieldValue.serverTimestamp() });
const draftId = draftRef.id;

// a healthy account and a banned one (top-level)
const acctRef = db.collection('accounts').doc();
await acctRef.set({ accountId: acctRef.id, label: 'e2e-good', username: 'goodguy', adsPowerProfileId: 'k1abcd23', status: 'active', dailyCap: 5, minIntervalMinutes: 45, postCountToday: 0, postCountResetAt: FieldValue.serverTimestamp(), lastPostAt: null, karma: 0, notes: '', createdBy: user.uid, createdByName: 'e2e', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
const bannedRef = db.collection('accounts').doc();
await bannedRef.set({ accountId: bannedRef.id, label: 'e2e-banned', username: 'x', adsPowerProfileId: 'k9', status: 'banned', dailyCap: 5, minIntervalMinutes: 45, postCountToday: 0, postCountResetAt: FieldValue.serverTimestamp(), lastPostAt: null, karma: 0, notes: '', createdBy: user.uid, createdByName: 'e2e', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
const noProfileRef = db.collection('accounts').doc();
await noProfileRef.set({ accountId: noProfileRef.id, label: 'e2e-noprofile', username: 'y', adsPowerProfileId: '', status: 'active', dailyCap: 5, minIntervalMinutes: 45, postCountToday: 0, postCountResetAt: FieldValue.serverTimestamp(), lastPostAt: null, karma: 0, notes: '', createdBy: user.uid, createdByName: 'e2e', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

console.log(`throwaway project ${pid}\n`);
const jobsFor = async () => (await db.collection('jobs').where('projectId', '==', pid).get()).docs;

// --- 1. Validation + gate ---
console.log('1. validation & gate');
check((await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ accountId: acctRef.id }) })).status === 400, 'missing draftId -> 400');
check((await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: 'nope' }) })).status === 400, 'unknown account -> 400');
const noProf = await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: noProfileRef.id }) });
check(noProf.status === 400 && /profile/i.test(noProf.body?.error ?? ''), 'account without profile id -> 400');
const banned = await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: bannedRef.id }) });
check(banned.status === 400 && /banned/i.test(banned.body?.error ?? ''), 'banned account blocked by gate -> 400', banned.body?.error ?? '');
check((await jobsFor()).length === 0, 'nothing queued yet');

// --- 2. Enqueue ---
console.log('\n2. enqueue');
const q = await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: acctRef.id }) });
check(q.status === 200 && !!q.body?.jobId, 'queued -> jobId', `status ${q.status}`);
const jobDocs = await jobsFor();
check(jobDocs.length === 1, 'exactly one job written');
const job = jobDocs[0]?.data();
check(job?.status === 'queued', "status 'queued'");
check(job?.draftId === draftId && job?.accountId === acctRef.id, 'draft + account denormalised');
check(job?.body === 'the reply', 'reply body carried');
check(job?.adsPowerProfileId === 'k1abcd23' && job?.expectedUsername === 'goodguy', 'profile id + username carried for the agent');
check(job?.threadUrl?.includes('/comments/P1/'), 'thread URL carried');

// --- 3. Dedupe + draft-state guards ---
console.log('\n3. dedupe & draft state');
const dup = await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: acctRef.id }) });
check(dup.status === 400 && /already queued/i.test(dup.body?.error ?? ''), 'double-queue refused -> 400');
await draftRef.update({ status: 'posted' });
check((await api(`/api/projects/${pid}/reddit/jobs`, { method: 'POST', body: JSON.stringify({ draftId, accountId: acctRef.id }) })).status === 400, 'already-posted draft -> 400');

// --- cleanup ---
for (const d of await jobsFor()) await d.ref.delete();
await Promise.all([acctRef.delete(), bannedRef.delete(), noProfileRef.delete()]);
await api(`/api/projects/${pid}`, { method: 'DELETE' });
if ((await proj.get()).exists) await db.recursiveDelete(proj);

console.log(`\n${failures === 0 ? 'Publish OK' : `${failures} FAILURE(S)`}: enqueue, gate re-check, dedupe, denormalised job.`);
process.exit(failures === 0 ? 0 : 1);
