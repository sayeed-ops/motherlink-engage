// Posting-account CRUD against a running dev server: create / update / delete,
// the accounts.manage gate, input validation, and the server-set counter
// defaults. Accounts are top-level and hold no secrets; this is the identity +
// rails layer (the posting queue and agent are deliberately not built yet).
//
// Creates and deletes its own throwaway account. Usage:
//   cd tools && node e2e-reddit-accounts.mjs   (dev server up)

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
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

// --- 1. Validation on create ---
console.log('1. create validation');
check((await api('/api/accounts', { method: 'POST', body: JSON.stringify({ adsPowerProfileId: 'p1' }) })).status === 400, 'missing label -> 400');
check((await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label: 'x' }) })).status === 400, 'missing adsPowerProfileId -> 400');

// --- 2. Create + server-set defaults + sanitisation ---
console.log('\n2. create');
const created = await api('/api/accounts', {
  method: 'POST',
  body: JSON.stringify({
    label: 'e2e-acct',
    username: 'u/BudgetLee', // the "u/" prefix should be stripped
    adsPowerProfileId: 'k1abcd23',
    status: 'warming',
    dailyCap: 0, // should floor to 1
    minIntervalMinutes: 45,
    karma: 12,
    notes: 'throwaway',
  }),
});
check(created.status === 201, 'created -> 201', `status ${created.status}`);
const accountId = created.body?.accountId;
const ref = db.collection('accounts').doc(accountId);
const doc = (await ref.get()).data();
check(doc.username === 'BudgetLee', 'username "u/" prefix stripped', `got ${doc.username}`);
check(doc.dailyCap === 1, 'dailyCap floored to 1', `got ${doc.dailyCap}`);
check(doc.postCountToday === 0, 'postCountToday seeded 0');
check(doc.lastPostAt === null, 'lastPostAt seeded null');
check(!!doc.postCountResetAt, 'postCountResetAt stamped');
check(doc.createdBy === user.uid, 'createdBy is the caller');

// --- 3. Update ---
console.log('\n3. update');
await api(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify({ status: 'active', minIntervalMinutes: 90 }) });
const upd = (await ref.get()).data();
check(upd.status === 'active', "status -> 'active'");
check(upd.minIntervalMinutes === 90, 'minIntervalMinutes -> 90');
check(upd.postCountToday === 0, 'counters untouched by an edit');
check(
  (await api(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify({ label: '   ' }) })).status === 400,
  'blank label on update -> 400',
);
check((await api('/api/accounts/nope', { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })).status === 400, 'unknown id -> 400');

// --- 4. Delete ---
console.log('\n4. delete');
check((await api(`/api/accounts/${accountId}`, { method: 'DELETE' })).status === 200, 'delete -> 200');
check((await ref.get()).exists === false, 'account doc gone');
check((await api(`/api/accounts/${accountId}`, { method: 'DELETE' })).status === 400, 'second delete -> 400 (already gone)');

// Safety net.
if ((await ref.get()).exists) await ref.delete();

console.log(`\n${failures === 0 ? 'Accounts OK' : `${failures} FAILURE(S)`}: CRUD, validation, sanitisation, counter defaults.`);
process.exit(failures === 0 ? 0 : 1);
