// Project lifecycle against a running dev server: scoped purge, clean history,
// delete-cascade. Runs entirely on a THROWAWAY project it creates and deletes —
// it never touches real client data, and spends no proxy/DeepSeek budget (items
// and drafts are seeded via the Admin SDK).
//
// The point is the retention invariant, which is the whole risk in this chunk:
//   - purge keeps fresh + favourited + answered items, scoped to the subreddits
//     that were actually refreshed (another subreddit is never wiped),
//   - clean keeps posted drafts (the ANSWERED ledger) and knowledge/config,
//   - delete removes the entire projects/{id}/ subtree with no orphans.
//
// Usage: cd tools && node e2e-reddit-lifecycle.mjs   (dev server must be up)

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
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- Create a throwaway project ---
const name = `e2e-lifecycle ${Date.now()}`;
const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
if (created.status !== 201) {
  console.error('Could not create project:', created.status, created.body);
  process.exit(1);
}
const pid = created.body.projectId;
const proj = db.collection('projects').doc(pid);
console.log(`throwaway project: ${name} (${pid})\n`);

// --- Seed items + analyses + drafts via Admin SDK ---
const item = (id, subreddit, extra = {}) => ({
  itemId: `${pid}_${id}`, projectId: pid, platform: 'reddit', externalId: id,
  subreddit, title: `t-${id}`, body: '', author: 'x', permalink: '', url: '',
  isSelfPost: true, score: 0, numComments: 0, processingStatus: 'fetched',
  isFavorite: false, createdAtSource: FieldValue.serverTimestamp(),
  fetchedAt: FieldValue.serverTimestamp(), createdBy: user.uid, ...extra,
});
const setItem = (id, subreddit, extra) => proj.collection('items').doc(`${pid}_${id}`).set(item(id, subreddit, extra));

await Promise.all([
  setItem('A1', 'alpha'),                        // plain -> purge deletes
  setItem('A2', 'alpha', { isFavorite: true }),  // favourite -> kept
  setItem('A3', 'alpha'),                         // has non-posted draft -> kept
  setItem('A4', 'alpha'),                         // "fresh" this run -> kept
  setItem('A5', 'alpha'),                         // has posted draft -> kept + answered
  setItem('B1', 'beta'),                          // other subreddit -> never in scope
]);
// analyses: one for A1 (should die with A1), one for A2 (should survive)
await proj.collection('analyses').doc().set({ analysisId: 'an1', projectId: pid, itemId: `${pid}_A1`, decision: 'skip', score: 1, createdAt: FieldValue.serverTimestamp() });
await proj.collection('analyses').doc().set({ analysisId: 'an2', projectId: pid, itemId: `${pid}_A2`, decision: 'reply', score: 80, createdAt: FieldValue.serverTimestamp() });
// drafts: non-posted for A3, posted for A5
const d3 = proj.collection('drafts').doc();
await d3.set({ draftId: d3.id, projectId: pid, itemId: `${pid}_A3`, body: 'd3', status: 'draft', createdAt: FieldValue.serverTimestamp() });
const d5 = proj.collection('drafts').doc();
await d5.set({ draftId: d5.id, projectId: pid, itemId: `${pid}_A5`, body: 'd5', status: 'posted', createdAt: FieldValue.serverTimestamp() });
// a knowledge source, to prove delete-cascade takes it too
await proj.collection('sources').doc().set({ projectId: pid, type: 'pasted_text', title: 's1', summary: '', createdAt: FieldValue.serverTimestamp() });

const has = async (col, id) => (await proj.collection(col).doc(id).get()).exists;
const countOf = async (col) => (await proj.collection(col).count().get()).data().count;

// --- 1. Scoped purge ---
console.log('1. scoped purge (fresh=A4, scope=alpha)');
const purge = await api(`/api/projects/${pid}/reddit/purge`, {
  method: 'POST',
  body: JSON.stringify({ keepItemIds: [`${pid}_A4`], onlySubreddits: ['alpha'] }),
});
check(purge.status === 200, 'request ok', `status ${purge.status}`);
check(purge.body?.deletedItems === 1, 'deletedItems=1 (only A1)', `got ${purge.body?.deletedItems}`);
check(purge.body?.deletedAnalyses === 1, 'deletedAnalyses=1 (A1s analysis)', `got ${purge.body?.deletedAnalyses}`);
check(purge.body?.keptFavorites === 1, 'keptFavorites=1 (A2)', `got ${purge.body?.keptFavorites}`);
check(purge.body?.keptDrafted === 2, 'keptDrafted=2 (A3, A5)', `got ${purge.body?.keptDrafted}`);
check(!(await has('items', `${pid}_A1`)), 'A1 (plain) deleted');
check(await has('items', `${pid}_A2`), 'A2 (favourite) survived');
check(await has('items', `${pid}_A3`), 'A3 (has draft) survived');
check(await has('items', `${pid}_A4`), 'A4 (fresh) survived');
check(await has('items', `${pid}_A5`), 'A5 (answered) survived');
check(await has('items', `${pid}_B1`), 'B1 (other subreddit, not in scope) untouched');

// --- 2. Empty scope is refused (a purge must name its subreddits) ---
console.log('\n2. purge guards');
check(
  (await api(`/api/projects/${pid}/reddit/purge`, { method: 'POST', body: JSON.stringify({ keepItemIds: [], onlySubreddits: [] }) })).status === 400,
  'no onlySubreddits -> 400',
);

// --- 3. Clean history keeps posted drafts + sources ---
console.log('\n3. clean history');
const clean = await api(`/api/projects/${pid}/reddit/clean`, { method: 'POST', body: JSON.stringify({}) });
check(clean.status === 200, 'request ok', `status ${clean.status}`);
check(clean.body?.postedDraftsKept === 1, 'postedDraftsKept=1 (d5)', `got ${clean.body?.postedDraftsKept}`);
check((await countOf('items')) === 0, 'all items cleared');
check((await countOf('analyses')) === 0, 'all analyses cleared');
check(!(await has('drafts', d3.id)), 'non-posted draft d3 deleted');
check(await has('drafts', d5.id), 'posted draft d5 kept (ANSWERED ledger)');
check((await countOf('sources')) === 1, 'knowledge source kept');

// --- 4. Delete cascade removes the whole subtree ---
console.log('\n4. delete cascade');
const del = await api(`/api/projects/${pid}`, { method: 'DELETE' });
check(del.status === 200, 'request ok', `status ${del.status}`);
check((await proj.get()).exists === false, 'project doc gone');
check((await countOf('members')) === 0, 'members subcollection gone');
check((await countOf('sources')) === 0, 'sources subcollection gone');
check((await countOf('drafts')) === 0, 'drafts subcollection gone (no orphans)');

// Safety net: if anything above bailed, make sure we didn't leave a project behind.
if ((await proj.get()).exists) {
  console.log('   cleanup: removing leftover throwaway project');
  await db.recursiveDelete(proj);
}

console.log(`\n${failures === 0 ? 'Lifecycle OK' : `${failures} FAILURE(S)`}: scoped purge, clean, delete-cascade.`);
process.exit(failures === 0 ? 0 : 1);
