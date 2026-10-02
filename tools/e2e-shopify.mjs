// End-to-end checks on the Shopify Community module against a running dev
// server and the live community.
//
// Deliberately covers the properties that must hold rather than a happy path:
// that a fetch is safe to press twice, that operator state survives it, and
// that no thread body is ever written.
//
// ⚠️ RE-RUNNABLE. The first version assumed a fresh project and reported three
// false failures on its second run: the defaults assertion saw the empty
// selection its own last test had left, "stored N new" saw topics already held,
// and "picking reported one change" saw a row it had already picked. A suite
// that fails when nothing is wrong is a suite people stop reading, so it now
// puts the project into a known state first and restores it at the end.
//
// Usage: cd tools && node e2e-shopify.mjs
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
// The project to run against, and the identity to run as. Both are LOOKED UP
// or passed in rather than hardcoded: a raw uid in a public repo is nothing
// anybody can use, but it is also nothing anybody can read, and e2e-users.mjs
// already established resolving the owner by email.
const PROJECT = process.argv[2] || process.env.PROJECT_ID;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'sayeed@motherlink.io';

/** The shipped six, duplicated here rather than imported: this file is plain
 *  node with no TypeScript loader, and a test that reaches into the app's
 *  modules to learn what it should assert is testing itself. */
const DEFAULT_CATEGORIES = [
  { id: 288, slug: 'seo', name: 'SEO', parentId: null, topicCount: 201 },
  { id: 293, slug: 'data-analytics', name: 'Data and Analytics', parentId: null, topicCount: 91 },
  { id: 292, slug: 'email-marketing', name: 'Email Marketing', parentId: null, topicCount: 62 },
  { id: 289, slug: 'social-media', name: 'Social Media', parentId: null, topicCount: 46 },
  { id: 291, slug: 'video-marketing', name: 'Video Marketing', parentId: null, topicCount: 25 },
  { id: 284, slug: 'branding', name: 'Branding', parentId: null, topicCount: 23 },
];

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
const env = readFileSync(join(import.meta.dirname, '..', 'apps', 'web', '.env.local'), 'utf8');
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)[1].trim();
initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? ' ok ' : 'FAIL'}  ${m}`); c ? pass++ : fail++; };

if (!PROJECT) {
  console.error('Usage: node e2e-shopify.mjs <projectId>   (or set PROJECT_ID)');
  process.exit(2);
}
const owner = await getAuth().getUserByEmail(OWNER_EMAIL);
const custom = await getAuth().createCustomToken(owner.uid);
const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
const { idToken } = await r.json();
const H = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/shopify${path}`, { ...init, headers: H });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log('\n--- anonymous ---');
{
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/shopify/topics`);
  ok(res.status === 401, `anonymous cannot read topics (got ${res.status})`);
}

// A project that has never opened the screen must report the shipped defaults.
// Deleting the config document is the only way to test that on a live project
// — so it is SAVED first and put back at the end. The first version restored
// only the boards, which wiped the client profile and (now) the model picks of
// whatever project it ran against.
const configRef = db.collection('projects').doc(PROJECT).collection('modules').doc('shopify');
const savedConfig = (await configRef.get()).data() ?? null;
const knowledgeCol = db.collection('projects').doc(PROJECT).collection('shopifySources');
const knowledgeBefore = new Set((await knowledgeCol.get()).docs.map((d) => d.id));
await configRef.delete();

console.log('\n--- settings ---');
const settings = await api('');
ok(settings.status === 200, `settings load (got ${settings.status})`);
ok(settings.body.catalogue?.length > 30, `catalogue fetched live — ${settings.body.catalogue?.length} boards`);
ok(settings.body.catalogueError === null, 'catalogue came from the community, not the fallback');
ok(settings.body.sorts?.length === 4, 'four sort orders offered');
const six = settings.body.config?.categories ?? [];
ok(six.length === 6, `defaults to the six marketing boards (got ${six.length})`);

console.log('\n--- settings are normalised server-side ---');
{
  const res = await api('', { method: 'PUT', body: JSON.stringify({ config: {
    categories: [{ id: 288, slug: 'seo', name: 'SEO' }, { id: 288, slug: 'dupe', name: 'Same id' }, { id: null, slug: 'x' }],
    sort: '../../admin', pagesPerCategory: 500, limits: { quietAfterDays: 99999 },
  }}) });
  const c = res.body.config;
  ok(c.categories.length === 1, `duplicate and unaddressable boards dropped (kept ${c.categories.length})`);
  ok(c.sort === 'latest', `a sort that is not a sort falls back (got ${c.sort})`);
  ok(c.pagesPerCategory <= 20, `page budget clamped (got ${c.pagesPerCategory})`);
  ok(c.limits.quietAfterDays <= 365, `quiet window clamped (got ${c.limits.quietAfterDays})`);
}

console.log('\n--- model picks: chosen, validated, never hardcoded ---');
{
  ok((await api('', { method: 'PUT', body: JSON.stringify({ config: { analysisModel: 'made:up' } }) })).status === 400, 'an unknown model is refused');
  ok(
    (await api('', { method: 'PUT', body: JSON.stringify({ config: { draftModel: 'deepseek:deepseek-reasoner' } }) })).status === 400,
    'a model that cannot return JSON is refused for drafting too',
  );
  const res = await api('', { method: 'PUT', body: JSON.stringify({ config: { analysisModel: 'deepseek:deepseek-chat' } }) });
  ok(res.body.config?.analysisModel === 'deepseek:deepseek-chat', 'a catalogue model is stored');
  ok(res.body.config?.draftModel === null, 'the field not sent keeps its value (default) rather than being reset');
}

console.log('\n--- saving boards does not wipe the client ---');
{
  await api('/client', { method: 'PUT', body: JSON.stringify({ client: { companyDescription: 'E2E client', productService: 'E2E product' } }) });
  await api('', { method: 'PUT', body: JSON.stringify({ config: { sort: 'hot' } }) });
  const c = (await api('')).body.config;
  ok(c.client.companyDescription === 'E2E client', `the client survived a settings save (got "${c.client.companyDescription}")`);
  ok(c.analysisModel === 'deepseek:deepseek-chat', 'and so did the model pick');
  const sneaky = await api('', { method: 'PUT', body: JSON.stringify({ config: { client: { companyDescription: 'OVERWRITTEN' } } }) });
  ok(sneaky.body.config.client.companyDescription === 'E2E client', 'the settings route cannot set the client — its own route owns it');
}

console.log('\n--- knowledge: its own list ---');
{
  const k = (path, init) => api(`/knowledge${path}`, init);
  const bad = await k('', { method: 'POST', body: JSON.stringify({ json: 'not json' }) });
  ok(bad.status === 400, 'an import that is not JSON is refused');
  const imp = await k('', { method: 'POST', body: JSON.stringify({ json: JSON.stringify([
    { title: 'E2E source one', url: 'https://northwind.example/e2e-one', keyPoints: ['a point'] },
    { title: 'E2E source one', url: null },
    { summary: 'no title' },
  ]) }) });
  ok(imp.status === 201 && imp.body.created === 1, `import created one (got ${imp.body.created})`);
  ok(imp.body.duplicates?.length === 1 && imp.body.rejected?.length === 1, 'the duplicate and the untitled row were reported');
  const again = await k('', { method: 'POST', body: JSON.stringify({ source: { title: 'e2e SOURCE one' } }) });
  ok(again.status === 400, 'adding a source already held by title is refused');
  const list = (await k('')).body.sources ?? [];
  const mine = list.find((s) => s.title === 'E2E source one');
  ok(mine?.origin === 'json', 'the imported source says where it came from');
  const edited = await k(`/${mine.sourceId}`, { method: 'PUT', body: JSON.stringify({ source: { ...mine, summary: 'edited' } }) });
  ok(edited.body.source?.editedAtMs > 0 && edited.body.source?.origin === 'json', 'an edit is stamped and keeps its origin');
  const sync = await k('/sync', { method: 'POST', body: '{}' });
  ok(sync.status === 200, `copy from Reddit ran (added ${sync.body.added}, already held ${sync.body.alreadyHeld}, Reddit has ${sync.body.redditTotal})`);
  const after = (await k('')).body.sources ?? [];
  ok(after.some((s) => s.sourceId === mine.sourceId), 'the copy did not remove a source added here');
  const again2 = await k('/sync', { method: 'POST', body: '{}' });
  ok(again2.body.added === 0, 'a second copy adds nothing');
}

console.log('\n--- a real fetch, one small board ---');
await api('', { method: 'PUT', body: JSON.stringify({ config: {
  categories: [{ id: 284, slug: 'branding', name: 'Branding', parentId: null, topicCount: 23 }],
  sort: 'latest', pagesPerCategory: 1,
  limits: { quietAfterDays: 60, ignoredBelowViews: 30, skipAnswered: true },
}}) });
const first = await api('/fetch', { method: 'POST', body: '{}' });
ok(first.status === 200, `fetch ran (got ${first.status})`);
const read1 = first.body.categories?.[0];
ok(read1?.read > 0, `read ${read1?.read} topics in ${first.body.requests} request(s)`);
// created + updated, not created: on a second run every topic is already held,
// and "created 0" is the correct answer rather than a failure.
ok(
  first.body.saved.created + first.body.saved.updated > 0,
  `stored ${first.body.saved.created} new, ${first.body.saved.updated} refreshed`,
);
ok(Object.keys(first.body.skipped).length > 0, `screen recorded reasons: ${JSON.stringify(first.body.skipped)}`);

console.log('\n--- no thread bodies were written ---');
{
  const snap = await db.collection('projects').doc(PROJECT).collection('shopifyTopics').limit(5).get();
  const fields = new Set();
  snap.docs.forEach((d) => Object.keys(d.data()).forEach((k) => fields.add(k)));
  const bodyish = [...fields].filter((f) => /body|cooked|posts$|content|raw/i.test(f));
  ok(bodyish.length === 0, `no body-shaped field stored (fields: ${[...fields].sort().join(', ')})`);
  const subs = snap.docs.length ? await snap.docs[0].ref.listCollections() : [];
  ok(subs.length === 0, `no subcollection under a topic (found ${subs.map((s) => s.id).join(',') || 'none'})`);
}

console.log('\n--- picking survives a re-fetch ---');
const before = await api('/topics?limit=400');
const pickId = before.body.topics.find((t) => t.skipReasons.length === 0)?.id;
ok(!!pickId, `something worth reading to pick (id ${pickId})`);
{
  // Start from unpicked, so the assertion is about the write and not about
  // whatever a previous run left behind.
  await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [pickId], selected: false }) });
  const res = await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [pickId], selected: true }) });
  ok(res.body.changed === 1, `picking reported one change (got ${res.body.changed})`);
  const again = await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [pickId], selected: true }) });
  ok(again.body.changed === 0, 'picking the same row twice is not a second change');
}
const second = await api('/fetch', { method: 'POST', body: '{}' });
ok(second.body.saved.created === 0, `a second fetch creates nothing new (created ${second.body.saved.created})`);
ok(second.body.saved.updated > 0, `and refreshes the counts (updated ${second.body.saved.updated})`);
{
  const after = await api('/topics?selected=1&limit=400');
  ok(after.body.topics.some((t) => t.id === pickId), 'the picked row is STILL picked after a re-fetch');
  const firstSeen = before.body.topics.find((t) => t.id === pickId)?.firstSeenAtMs;
  const stillFirst = (await api('/topics?limit=400')).body.topics.find((t) => t.id === pickId)?.firstSeenAtMs;
  ok(firstSeen === stillFirst, 'firstSeenAt was not overwritten by the re-read');
}

console.log('\n--- bad input ---');
{
  ok((await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [1], selected: 'yes' }) })).status === 400, 'selected must be a boolean');
  ok((await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [], selected: true }) })).status === 400, 'an empty pick is refused');
  const ghost = await api('/topics', { method: 'PATCH', body: JSON.stringify({ topicIds: [999999999], selected: true }) });
  ok(ghost.body.changed === 0, 'a topic we have never seen cannot be picked into existence');
}

console.log('\n--- no boards selected ---');
await api('', { method: 'PUT', body: JSON.stringify({ config: { categories: [], sort: 'latest', pagesPerCategory: 1 } }) });
ok((await api('/fetch', { method: 'POST', body: '{}' })).status === 400, 'a fetch with nothing selected says so');
{
  const c = (await api('')).body.config;
  ok(c.categories.length === 0, 'an empty selection is honoured, not silently refilled');
}

// Leave the project usable: the empty-selection test above is deliberate, but
// walking away from it would mean the next person opens a screen with no boards
// and no idea why.
console.log('\n--- restoring ---');
{
  // Whatever the project held before, exactly — or the shipped six on a
  // project that had never opened the screen.
  if (savedConfig) await configRef.set(savedConfig);
  else {
    await configRef.delete();
    await api('', { method: 'PUT', body: JSON.stringify({ config: {
      categories: DEFAULT_CATEGORIES, sort: 'latest', pagesPerCategory: 2,
      limits: { quietAfterDays: 60, ignoredBelowViews: 30, skipAnswered: true },
    }}) });
  }
  const c = (await api('')).body.config;
  ok(c?.categories?.length === (savedConfig?.categories?.length ?? 6), `boards restored (${c?.categories?.length})`);
  ok(c?.client?.companyDescription === (savedConfig?.client?.companyDescription ?? ''), 'client profile restored');
  // Sources this run created (the import, and anything the copy added) go;
  // everything that was there before stays.
  const created = (await knowledgeCol.get()).docs.filter((d) => !knowledgeBefore.has(d.id));
  await Promise.all(created.map((d) => d.ref.delete()));
  ok((await knowledgeCol.get()).size === knowledgeBefore.size, `knowledge restored (${knowledgeBefore.size} sources)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
