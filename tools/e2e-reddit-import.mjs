// Bulk source import against a running dev server. The importer is client glue
// that POSTs each parsed row to the (already-tested) sources route; this checks
// the one integration assumption that glue makes — a bad-URL row is rejected
// (counted "failed") while a pasted_text row with no URL is accepted — so the
// created/failed tally the UI shows is honest.
//
// Runs on a THROWAWAY project it creates and deletes. Usage:
//   cd tools && node e2e-reddit-import.mjs   (dev server up)

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

const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `e2e-import ${Date.now()}` }) });
const pid = created.body.projectId;
const proj = db.collection('projects').doc(pid);
console.log(`throwaway project: ${pid}\n`);

// The rows a bulk paste would parse to (after the client drops title-less rows).
const rows = [
  { type: 'url', title: 'Pricing', url: 'https://acme.com/pricing', summary: 's', keyPoints: ['a'], answerAngles: [], relatedProblems: [] },
  { type: 'pasted_text', title: 'Positioning note', url: '', summary: 'pasted', keyPoints: [], answerAngles: [], relatedProblems: [] },
  { type: 'url', title: 'Bad link', url: 'ftp://nope', summary: '', keyPoints: [], answerAngles: [], relatedProblems: [] },
];

console.log('bulk import (mirrors the client loop)');
let ok = 0;
let bad = 0;
for (const r of rows) {
  const res = await api(`/api/projects/${pid}/sources`, {
    method: 'POST',
    body: JSON.stringify({ ...r, url: typeof r.url === 'string' ? r.url : '' }),
  });
  if (res.status === 201) ok++;
  else bad++;
}
check(ok === 2, 'created = 2 (url + pasted_text)', `got ${ok}`);
check(bad === 1, 'failed = 1 (ftp:// url rejected)', `got ${bad}`);
const count = (await proj.collection('sources').count().get()).data().count;
check(count === 2, 'exactly 2 sources persisted', `got ${count}`);

await api(`/api/projects/${pid}`, { method: 'DELETE' });
if ((await proj.get()).exists) await db.recursiveDelete(proj);

console.log(`\n${failures === 0 ? 'Import OK' : `${failures} FAILURE(S)`}: bulk source tally is honest.`);
process.exit(failures === 0 ? 0 : 1);
