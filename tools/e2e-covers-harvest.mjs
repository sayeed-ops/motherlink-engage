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
// ════════════════════════════════════════════════════════════════════════════
// --triage IS OPT-IN AND SPENDS MODEL CREDIT
//
// Without it this reads Covers and writes documents, and costs nothing but
// somebody else's bandwidth. WITH it, every post that survives the free tier
// gets one model call, so it is behind an explicit flag rather than a default —
// nobody should be able to run up a bill by re-running the harvest test.
//
// Triage against an EMPTY library would report every post as a gap and prove
// nothing, so --triage copies a real project's active assets and claims into the
// throwaway project first. The source project is READ ONLY and never written to.
// ════════════════════════════════════════════════════════════════════════════
//
// Usage:
//   node e2e-covers-harvest.mjs                       harvest only (free)
//   node e2e-covers-harvest.mjs --triage              harvest + triage (SPENDS)
//   node e2e-covers-harvest.mjs --triage --threads=4  a bigger sample
//   node e2e-covers-harvest.mjs --section=nba-betting-22
//   node e2e-covers-harvest.mjs --triage --assets-from=<projectId>
//   node e2e-covers-harvest.mjs --triage --prohibit=US,Ontario
//
// The dev server must be up.

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// A bare first argument is still the section, as it was before.
const positional = argv.find((a) => !a.startsWith('--'));
const SECTION = opt('section', positional || 'nfl-betting-21');
const TRIAGE = flag('triage');
// Two threads is enough to prove the harvest; triage wants a real sample.
const THREADS = Number(opt('threads', TRIAGE ? 4 : 2));
const ASSETS_FROM = opt('assets-from', null);
const PROHIBIT = opt('prohibit', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

// A watch-only section cannot be triaged — every post is screened out before
// anything looks at it. Enabling `reply` HERE, in the throwaway project, is what
// lets the test examine a board like General Discussion; the real project's
// roles are never touched.
const configured = sections.find((s) => s.slug === SECTION);
if (TRIAGE && configured && !configured.roles.includes('reply')) {
  const next = sections.map((s) =>
    s.slug === SECTION ? { ...s, roles: [...new Set([...s.roles, 'reply'])] } : s,
  );
  const put = await api(`/api/projects/${pid}/covers`, {
    method: 'PUT',
    body: JSON.stringify({ config: { ...config.body.config, sections: next } }),
  });
  check(put.status === 200, `enabled the reply role on ${SECTION} (throwaway project only)`);
}

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
check(
  run.body.paceMs !== null,
  'the section pace was measured from the whole listing',
  run.body.paceMs ? `median ${(run.body.paceMs / 3_600_000).toFixed(1)}h between threads` : 'too few rows',
);

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

// ═══════════════════════════════════════════════════════════════════════════
// 5b. TRIAGE — opt-in, spends model credit
// ═══════════════════════════════════════════════════════════════════════════
if (TRIAGE) {
  console.log('\n5b. triage (--triage: this spends model credit)');

  // --- a real library, copied in ------------------------------------------
  // Triage against an empty library reports every post as a gap and proves
  // nothing. The source project is read and never written.
  let sourceId = ASSETS_FROM;
  if (!sourceId) {
    const projects = await db.collection('projects').get();
    let best = { id: null, count: 0 };
    for (const doc of projects.docs) {
      if (doc.id === pid) continue;
      const n = (await doc.ref.collection('assets').where('status', '==', 'active').count().get()).data().count;
      if (n > best.count) best = { id: doc.id, count: n };
    }
    sourceId = best.id;
    if (sourceId) console.log(`   borrowing the library from ${sourceId} (${best.count} active assets)`);
  }

  if (!sourceId) {
    console.log('   FAIL no project has an active asset library to triage against.');
    console.log('        Approve some knowledge first, or pass --assets-from=<projectId>.');
    failures++;
  } else {
    const src = db.collection('projects').doc(sourceId);
    const [assets, claims] = await Promise.all([
      src.collection('assets').where('status', '==', 'active').get(),
      src.collection('claims').get(),
    ]);

    let copy = db.batch();
    let n = 0;
    for (const doc of [...assets.docs, ...claims.docs]) {
      const target = doc.ref.parent.id === 'assets' ? 'assets' : 'claims';
      copy.set(proj.collection(target).doc(doc.id), { ...doc.data(), projectId: pid });
      if (++n % 400 === 0) {
        await copy.commit();
        copy = db.batch();
      }
    }
    if (n % 400 !== 0) await copy.commit();
    check(assets.size > 0, 'a real asset library is in place', `${assets.size} assets, ${claims.size} claims`);

    // ⚠️ REPAIR THE COPIES, NOT THE SOURCE. The first importer stored each
    // question whole as its asset's only trigger, and retrieval needs every
    // token of a trigger to be present — so those assets are in the library and
    // unreachable by any post. This fixes the throwaway copies so the test
    // measures the matcher rather than that bug; the real project needs the same
    // repair run against it, deliberately.
    const repair = await api(`/api/projects/${pid}/knowledge/assets/repair-triggers`, {
      method: 'POST',
      body: JSON.stringify({ apply: true }),
    });
    if (repair.status === 200 && repair.body.repaired > 0) {
      console.log(`   repaired ${repair.body.repaired}/${repair.body.assets} assets whose triggers were whole sentences`);
      const sample = repair.body.repairs[0];
      if (sample) {
        console.log(`     e.g. ${JSON.stringify(sample.before[0]?.slice(0, 70))}`);
        console.log(`       -> ${JSON.stringify(sample.after.slice(0, 4))}`);
      }
    }

    if (PROHIBIT.length > 0) {
      const set = await api(`/api/projects/${pid}/covers/policy`, {
        method: 'PUT',
        body: JSON.stringify({ policy: { jurisdiction: { prohibited: PROHIBIT, licensed: [] } } }),
      });
      check(set.status === 200, `jurisdiction policy set`, PROHIBIT.join(', '));
    }

    // --- the run ----------------------------------------------------------
    const t1 = Date.now();
    const run = await api(`/api/projects/${pid}/covers/triage`, {
      method: 'POST',
      body: JSON.stringify({ section: SECTION }),
    });

    if (run.status !== 200) {
      console.log(`   FAIL triage returned ${run.status}: ${run.body?.error ?? ''}`);
      failures++;
    } else {
      const r = run.body;
      check(true, 'triage ran', `${((Date.now() - t1) / 1000).toFixed(1)}s, ${r.intentCalls} model calls`);
      check(r.written === r.posts, 'a record was written for EVERY post', `${r.written}/${r.posts}`);

      // --- the review table ------------------------------------------------
      const rows = (await api(`/api/projects/${pid}/covers/triage?all=1&limit=500`)).body.triage;

      // Post bodies and thread titles, for reading alongside the verdict.
      const bodies = new Map();
      const titles = new Map();
      for (const item of afterItems) {
        titles.set(item.itemId, item.title);
        const posts = (await api(`/api/projects/${pid}/covers/items?itemId=${encodeURIComponent(item.itemId)}`)).body.posts;
        for (const p of posts) bodies.set(p.postId, p);
      }

      const STATUS = {
        opportunity: 'QUALIFIED',
        screened: 'rejected (free)',
        jurisdiction: 'BLOCKED (jurisdiction)',
        complaint: 'COMPLAINT — routed out',
        'not-draftable': 'rejected (banter/nothing asked)',
        unreadable: 'unreadable',
        'no-variant': 'rejected (nothing may be said)',
        'no-asset-match': 'GAP',
        budget: 'skipped (budget)',
      };

      console.log('\n' + '═'.repeat(78));
      console.log('PER-POST REVIEW');
      console.log('═'.repeat(78));

      const ordered = [...rows].sort((a, b) => b.score - a.score);
      for (const row of ordered) {
        const post = bodies.get(row.postId);
        console.log(`\n── ${STATUS[row.outcome] ?? row.outcome}${row.outcome === 'opportunity' ? `  score ${row.score}` : ''}`);
        console.log(`   thread : ${titles.get(row.itemId) ?? row.itemId}`);
        console.log(`   post   : #${post?.number ?? '?'} by ${post?.author ?? '?'} (${row.postId})`);
        if (post) console.log(`   text   : ${JSON.stringify(post.body.replace(/\s+/g, ' ').slice(0, 160))}`);

        if (row.screenReasons.length > 0) console.log(`   screen : ${row.screenReasons.join(', ')}`);
        if (row.jurisdiction?.blocked) console.log(`   POLICY : names ${row.jurisdiction.matched.join(', ')} — cannot serve`);

        if (row.intent) {
          console.log(`   intent : ${row.intent.intent}  (confidence ${row.intent.confidence}, asks=${row.intent.asksSomething})`);
          console.log(`   problem: ${row.intent.problem}`);
          console.log(`   concepts: ${row.intent.concepts.join(' · ') || '(none)'}`);
        } else if (row.outcome !== 'screened' && row.outcome !== 'jurisdiction') {
          console.log('   intent : (not classified)');
        }

        if (row.retrieval) {
          if (row.retrieval.matched.length > 0) {
            for (const m of row.retrieval.matched) {
              const why = [...m.why.triggers, ...m.why.problems].join(', ') || 'weak text overlap';
              console.log(`   asset  : ${m.title}  (score ${m.score})`);
              console.log(`   why    : ${why}`);
            }
          } else {
            console.log('   asset  : none matched  → GAP');
          }
          for (const v of row.retrieval.vetoed) {
            console.log(`   vetoed : ${v.title} — excluded by "${v.exclusion}"`);
          }
        }

        const eligible = Object.entries(row.variants).filter(([, v]) => v).map(([k]) => k);
        console.log(`   may say: ${eligible.join(', ') || 'nothing'}`);
        for (const [k, why] of Object.entries(row.eligibilityReasons ?? {})) {
          console.log(`            ${k}: ${why}`);
        }
      }

      // --- the summary ------------------------------------------------------
      const c = r.counts;
      const freeRejects = c.screened + c.jurisdiction;
      console.log('\n' + '═'.repeat(78));
      console.log('SUMMARY');
      console.log('═'.repeat(78));
      console.log(`  posts scanned                     ${r.posts}`);
      console.log(`  rejected BEFORE any model call    ${freeRejects}   (${c.screened} screened, ${c.jurisdiction} jurisdiction)`);
      console.log(`  model calls made                  ${r.intentCalls}`);
      console.log(`  qualified opportunities           ${c.opportunity}`);
      console.log(`  complaints (routed out)           ${c.complaint}`);
      console.log(`  banter / nothing asked            ${c['not-draftable']}`);
      console.log(`  gaps (real demand, no asset)      ${c['no-asset-match']}`);
      console.log(`  blocked by jurisdiction           ${c.jurisdiction}`);
      console.log(`  nothing may be said (section)     ${c['no-variant']}`);
      console.log(`  unreadable                        ${c.unreadable}`);
      console.log(`  skipped for budget                ${c.budget}`);

      if (r.gaps.length > 0) {
        console.log('\n  GAP BOARD — what people ask that the library cannot answer');
        for (const g of r.gaps.slice(0, 10)) {
          console.log(`    ${String(g.threads).padStart(2)} threads / ${String(g.posts).padStart(2)} posts  ${g.concept}`);
          if (g.examples[0]) console.log(`        e.g. ${g.examples[0]}`);
        }
      }

      console.log('');
      check(freeRejects + r.intentCalls + c.budget === r.posts, 'every post is accounted for');
      check(c.opportunity + c.complaint + c['not-draftable'] + c['no-asset-match'] + c['no-variant'] + c.unreadable === r.intentCalls,
        'every model call produced exactly one outcome');
    }
  }
}

// --- 6. Clean up, and prove the subcollection went with it ---------------
console.log('\n6. delete the throwaway project');
const del = await api(`/api/projects/${pid}`, { method: 'DELETE' });
check(del.status === 200, 'project deleted');

const orphans = await proj.collection('items').doc(withPosts.itemId).collection('posts').get();
check(orphans.empty, 'the posts subcollection went with it — no orphans', `${orphans.size} left`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
