// The Covers harvest against a running dev server, end to end.
//
// Runs entirely on a THROWAWAY project it creates and deletes, so it never
// touches real client data. It DOES read covers.com for real — one section page
// and a couple of threads, paced 1.2s apart by the reader — because the whole
// point is the part the unit tests cannot reach:
//
//   browser-shaped request -> bearer token -> requireProjectPermission(items.fetch)
//   -> covers.com -> parse -> entities -> Firestore items/{id}/posts/{postId}
//   -> read back through the API
//
// The pure half (parse, entities, items) is covered by tests/unit/covers*.
// What this asserts is the plumbing, plus the four properties that only appear
// once documents are actually written:
//
//   1. every thread gets its OWN item id  (the section slug once stole it, and
//      three threads arrived as one)
//   2. a post lands in the SUBCOLLECTION, not on the item
//   3. re-harvesting the same section adds nothing and clobbers nothing
//   4. what a person edited on an item survives a re-harvest
//
// Usage: cd tools && node e2e-covers-harvest.mjs [section]   (dev server up)

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const SECTION = process.argv[2] || 'nfl-betting-21';
const THREADS = 2;

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

console.log(`signed in as ${user.email}\n`);

// --- 0. The negative case, before anything exists -------------------------
console.log('0. anonymous access');
const anon = await fetch(`${BASE}/api/projects/x/covers/harvest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ section: SECTION }),
});
check(anon.status === 401, 'anonymous POST covers/harvest is rejected', `-> ${anon.status}`);

// --- 1. A throwaway project, with the module on --------------------------
console.log('\n1. setup');
const name = `e2e-covers ${Date.now()}`;
const created = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ name, enabledModules: ['reddit', 'covers'] }),
});
if (created.status !== 201) {
  console.error('Could not create project:', created.status, created.body);
  process.exit(1);
}
const pid = created.body.projectId;
const proj = db.collection('projects').doc(pid);
console.log(`   throwaway project: ${name} (${pid})`);

const config = await api(`/api/projects/${pid}/covers`);
check(config.status === 200, 'GET covers settings');
const sections = config.body?.config?.sections ?? [];
check(sections.length > 0, 'ships with a default section list', `${sections.length} sections`);
check(
  sections.every((s) => !s.roles.includes('promote')),
  'no default section permits promotion',
);
check(
  !!sections.find((s) => s.slug === SECTION),
  `${SECTION} is configured`,
);

// --- 2. A section nobody configured is refused ---------------------------
console.log('\n2. an unconfigured section');
const bogus = await api(`/api/projects/${pid}/covers/harvest`, {
  method: 'POST',
  body: JSON.stringify({ section: 'not-a-section-99' }),
});
check(bogus.status === 400, 'refused rather than read with an unknown sport', `-> ${bogus.status}`);

// --- 3. The harvest ------------------------------------------------------
console.log(`\n3. harvest ${SECTION} (1 page, ${THREADS} threads)`);
const t0 = Date.now();
const run = await api(`/api/projects/${pid}/covers/harvest`, {
  method: 'POST',
  body: JSON.stringify({ section: SECTION, pages: 1, maxThreads: THREADS }),
});

if (run.status !== 200) {
  console.error('   harvest failed:', run.status, run.body);
  await api(`/api/projects/${pid}`, { method: 'DELETE' });
  process.exit(1);
}

const { summary, saved, requests } = run.body;
console.log(
  `   listed ${summary.listed}, read ${summary.read}, ${summary.posts} posts, ` +
    `${requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
check(summary.listed > 0, 'the section listing was read', `${summary.listed} threads`);
check(summary.read > 0 && summary.read <= THREADS, 'threads were opened, within budget');
check(saved.itemsCreated === summary.read, 'one item per thread read');
check(saved.postsCreated > 0, 'posts were stored', `${saved.postsCreated}`);
check(summary.errors.length === 0, 'no read errors', summary.errors.join('; '));

// --- 4. What actually landed in Firestore --------------------------------
console.log('\n4. what is in the database');
const items = await api(`/api/projects/${pid}/covers/items`);
check(items.status === 200, 'GET covers/items');
const stored = items.body?.items ?? [];
check(stored.length === summary.read, 'every thread read is retrievable', `${stored.length}`);

// ⚠️ The one that would have caught the bug the live smoke test found: the
// thread id used to come from the SECTION slug, so every thread in a forum
// collapsed onto one item and their posts piled into one subcollection.
const ids = new Set(stored.map((i) => i.itemId));
check(ids.size === stored.length, 'every thread has its OWN item id');
check(
  stored.every((i) => i.externalId && i.externalId !== SECTION.split('-').pop()),
  'the item id is the thread id, not the section number',
  stored.map((i) => i.externalId).join(', '),
);
check(stored.every((i) => i.section === SECTION), 'section recorded');
check(stored.every((i) => i.url.includes('/forum/')), 'thread URL kept');

// Honest-unknown: these come from the listing row, which we DID read here, so
// they must be numbers rather than the nulls a URL-only read would leave.
check(
  stored.every((i) => typeof i.postsOnSite === 'number' && typeof i.views === 'number'),
  'listing counts were measured, not left null',
  stored.map((i) => `${i.postsHeld}/${i.postsOnSite} posts`).join(', '),
);

const withPosts = stored[0];
const detail = await api(`/api/projects/${pid}/covers/items?itemId=${encodeURIComponent(withPosts.itemId)}`);
check(detail.status === 200, 'GET one thread with its posts');
const posts = detail.body?.posts ?? [];
check(posts.length > 0, 'posts came back', `${posts.length}`);
check(posts.every((p) => p.author), 'every post has an author');
check(
  posts.every((p) => typeof p.createdAtMs === 'number'),
  'every post has a timestamp',
);
check(
  posts.every((p) => p.body && p.body.length > 0),
  'every post has a body',
);

// The subcollection is the point: an opportunity anchors on a post id.
const sub = await proj.collection('items').doc(withPosts.itemId).collection('posts').get();
check(sub.size === posts.length, 'posts live in the subcollection', `${sub.size} docs`);
check(
  sub.docs.every((d) => /^\d+$/.test(d.id)),
  "each post doc is keyed by Covers' own post id",
);

// Timestamps are UTC. A post from the future means the attribute was read as
// local time somewhere, which is the four-hour error the parser warns about.
const newest = Math.max(...posts.map((p) => p.createdAtMs));
check(newest <= Date.now() + 60_000, 'no post is dated in the future (UTC read correctly)');

const entityRows = posts.filter((p) => p.entities?.teams?.length > 0 || p.entities?.lines?.length > 0);
console.log(`   entities: ${entityRows.length}/${posts.length} posts named a team or quoted a line`);

// --- 5. Re-harvest: adds nothing, breaks nothing -------------------------
console.log('\n5. re-harvest the same section');

// Something a person did, which a second read must not undo.
await proj.collection('items').doc(withPosts.itemId).update({ isFavorite: true, processingStatus: 'reviewed' });

const again = await api(`/api/projects/${pid}/covers/harvest`, {
  method: 'POST',
  body: JSON.stringify({ section: SECTION, pages: 1, maxThreads: THREADS }),
});
check(again.status === 200, 'second harvest ran');
const second = again.body;
console.log(
  `   read ${second.summary.read}, skipped ${second.summary.skipped} unchanged, ` +
    `${second.saved.itemsCreated} new items, ${second.saved.postsCreated} new posts`,
);
check(
  second.summary.skipped > 0 || second.saved.postsCreated === 0,
  'unchanged threads were skipped or re-read to no effect',
);

// A second harvest does NOT re-read what it already holds — it spends the same
// budget on the threads below them, so the section is read deeper rather than
// twice. What must never happen is the same thread arriving as a second item.
const afterItems = (await api(`/api/projects/${pid}/covers/items`)).body.items;
const afterIds = afterItems.map((i) => i.itemId);
check(new Set(afterIds).size === afterIds.length, 'no thread became a second item');
check(
  afterItems.length === stored.length + second.saved.itemsCreated,
  'the second run went deeper rather than re-reading',
  `${stored.length} + ${second.saved.itemsCreated} new = ${afterItems.length}`,
);
check(
  stored.every((i) => afterIds.includes(i.itemId)),
  'the threads from the first run are all still there',
);

const subAgain = await proj.collection('items').doc(withPosts.itemId).collection('posts').get();
check(subAgain.size === sub.size, 'no duplicate posts', `${subAgain.size}`);

const survived = await proj.collection('items').doc(withPosts.itemId).get();
check(survived.data().isFavorite === true, 'isFavorite survived the re-harvest');
check(survived.data().processingStatus === 'reviewed', 'processingStatus survived the re-harvest');

// --- 6. Clean up, and prove the subcollection went with it ---------------
console.log('\n6. delete the throwaway project');
const del = await api(`/api/projects/${pid}`, { method: 'DELETE' });
check(del.status === 200, 'project deleted');

const orphans = await proj.collection('items').doc(withPosts.itemId).collection('posts').get();
check(orphans.empty, 'the posts subcollection went with it — no orphans', `${orphans.size} left`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
