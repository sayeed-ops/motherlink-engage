// Review-workflow curation routes against a running dev server:
//   PATCH items  (favourite, skip/archive)
//   PATCH draft  (mark posted, reject + reviewer notes)
//
// These are the mutations ML Studio did straight from the browser with the
// client SDK, under rules that let any signed-in user write any client's data.
// Here each one is a permission-gated server route; this asserts that the write
// lands, the input guards hold, and mark-posted keeps the post and the ANSWERED
// ledger in agreement.
//
// Spends NO DeepSeek credit: the draft under test is seeded via the Admin SDK.
//
// Usage: cd tools && node e2e-reddit-curation.mjs  (dev server must be up)

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

const { body: projList } = await api('/api/projects');
const project = projList.projects[0];
const pid = project.projectId;
console.log(`project: ${project.name} (${pid})\n`);

const projectRef = db.collection('projects').doc(pid);

// A fetched item to curate. Need at least one; the pipeline e2e leaves some.
const itemsSnap = await projectRef.collection('items').limit(1).get();
if (itemsSnap.empty) {
  console.error('No items in the project. Run e2e-reddit-pipeline.mjs first.');
  process.exit(1);
}
const item = itemsSnap.docs[0].data();
const itemRef = projectRef.collection('items').doc(item.itemId);
const startStatus = item.processingStatus;

// --- 1. Favourite toggle ---
console.log('1. favourite');
await api(`/api/projects/${pid}/reddit/items`, {
  method: 'PATCH',
  body: JSON.stringify({ itemId: item.itemId, isFavorite: true }),
});
check((await itemRef.get()).data().isFavorite === true, 'set isFavorite=true persists');
await api(`/api/projects/${pid}/reddit/items`, {
  method: 'PATCH',
  body: JSON.stringify({ itemId: item.itemId, isFavorite: false }),
});
check((await itemRef.get()).data().isFavorite === false, 'set isFavorite=false persists');

// --- 2. Skip / archive + restore ---
console.log('\n2. skip / archive');
await api(`/api/projects/${pid}/reddit/items`, {
  method: 'PATCH',
  body: JSON.stringify({ itemId: item.itemId, processingStatus: 'archived' }),
});
check((await itemRef.get()).data().processingStatus === 'archived', "skip sets processingStatus='archived'");
await api(`/api/projects/${pid}/reddit/items`, {
  method: 'PATCH',
  body: JSON.stringify({ itemId: item.itemId, processingStatus: startStatus }),
});
check((await itemRef.get()).data().processingStatus === startStatus, 'restore returns to prior status');

// --- 3. Input guards on items PATCH ---
console.log('\n3. items input guards');
check(
  (await api(`/api/projects/${pid}/reddit/items`, { method: 'PATCH', body: JSON.stringify({ itemId: item.itemId }) })).status === 400,
  'no fields -> 400',
);
check(
  (await api(`/api/projects/${pid}/reddit/items`, { method: 'PATCH', body: JSON.stringify({ itemId: item.itemId, processingStatus: 'bogus' }) })).status === 400,
  'unknown status -> 400',
);
check(
  (await api(`/api/projects/${pid}/reddit/items`, { method: 'PATCH', body: JSON.stringify({ itemId: 'not-in-project', isFavorite: true }) })).status === 400,
  'unknown itemId -> 400',
);

// --- 4. Draft: reject + reviewer notes ---
console.log('\n4. draft reject + reviewer notes');
const rejRef = projectRef.collection('drafts').doc();
await rejRef.set({
  draftId: rejRef.id, projectId: pid, platform: 'reddit', itemId: item.itemId,
  body: 'seeded draft for reject test', status: 'draft', reviewerNotes: '',
  createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
});
await api(`/api/projects/${pid}/reddit/draft`, {
  method: 'PATCH',
  body: JSON.stringify({ draftId: rejRef.id, status: 'rejected', reviewerNotes: 'off-topic; wrong subreddit' }),
});
const rej = (await rejRef.get()).data();
check(rej.status === 'rejected', "status -> 'rejected'");
check(rej.reviewerNotes === 'off-topic; wrong subreddit', 'reviewerNotes persisted');
await rejRef.delete();

// --- 5. Draft: mark posted keeps post + ledger in agreement ---
console.log('\n5. mark posted');
const postRef = projectRef.collection('drafts').doc();
await postRef.set({
  draftId: postRef.id, projectId: pid, platform: 'reddit', itemId: item.itemId,
  body: 'seeded draft for posted test', status: 'draft', reviewerNotes: '',
  createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
});
await api(`/api/projects/${pid}/reddit/draft`, {
  method: 'PATCH',
  body: JSON.stringify({ draftId: postRef.id, status: 'posted' }),
});
const posted = (await postRef.get()).data();
check(posted.status === 'posted', "status -> 'posted'");
check(!!posted.postedAt, 'postedAt stamped');
check((await itemRef.get()).data().processingStatus === 'drafted', "post status -> 'drafted' (ANSWERED ledger agrees)");
await postRef.delete();
await itemRef.update({ processingStatus: startStatus }); // leave it as we found it

// --- 6. Draft input guards ---
console.log('\n6. draft input guards');
check(
  (await api(`/api/projects/${pid}/reddit/draft`, { method: 'PATCH', body: JSON.stringify({ draftId: 'x', status: 'publish' }) })).status === 400,
  "status 'publish' refused -> 400",
);
check(
  (await api(`/api/projects/${pid}/reddit/draft`, { method: 'PATCH', body: JSON.stringify({ draftId: 'nope', status: 'rejected' }) })).status === 400,
  'unknown draftId -> 400',
);

console.log(`\n${failures === 0 ? 'Curation OK' : `${failures} FAILURE(S)`}: favourite, skip/restore, reject+notes, mark-posted, guards.`);
process.exit(failures === 0 ? 0 : 1);
