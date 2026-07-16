// Parity check: does the migrated data land in the SAME buckets in Engage as it
// does in ML Studio? Computes the review-queue buckets (brand / growth /
// answered / analysed) from BOTH databases with identical logic and compares
// per project. This is the phase-04 "behaves identically" gate.
//
//   node migrate-verify.mjs      (read-only on both)

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cfg = (f) => JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', f), 'utf8'));
const srcKey = cfg('migration-reader.json');
const tgtKey = cfg('admin.json');
const src = getFirestore(initializeApp({ credential: cert(srcKey), projectId: srcKey.project_id }, 's'));
const tgt = getFirestore(initializeApp({ credential: cert(tgtKey), projectId: tgtKey.project_id }, 't'));

const GROWTH_MIN = 40;
const ms = (v) => v?.toMillis?.() ?? 0;
const isBrand = (a) => a.decision !== 'skip' && (a.mentionRecommendation === 'yes' || a.mentionRecommendation === 'soft');
const isGrowth = (a) => a.mentionRecommendation === 'no' && (a.growthScore ?? 0) >= GROWTH_MIN;

// Given items, analyses, drafts (each an array of plain data with an item key),
// compute the buckets exactly like the Opportunities screen does.
function buckets(items, analyses, drafts, itemKey) {
  const itemIds = new Set(items.map((i) => i.__id));
  const latest = new Map();
  for (const a of analyses) {
    const k = a[itemKey];
    if (!itemIds.has(k)) continue; // analysis for a purged post — invisible
    const prev = latest.get(k);
    if (!prev || ms(a.createdAt) > ms(prev.createdAt)) latest.set(k, a);
  }
  const answered = new Set(drafts.filter((d) => d.status === 'posted').map((d) => d[itemKey]));
  let brand = 0, growth = 0, analysed = 0, growthInvariantOk = true;
  for (const a of latest.values()) {
    analysed++;
    if (isBrand(a)) brand++;
    if (isGrowth(a)) {
      growth++;
      if (a.mentionRecommendation !== 'no') growthInvariantOk = false; // growth ⇒ no brand pitch
    }
  }
  return { items: items.length, analysed, brand, growth, answered: answered.size, growthInvariantOk };
}

const projects = (await src.collection('reddit_projects').get()).docs.map((d) => ({ id: d.id, name: d.data().name }));

let mismatches = 0;
for (const p of projects) {
  // source
  const sPosts = (await src.collection('reddit_posts').where('projectId', '==', p.id).get()).docs.map((d) => ({ __id: d.id }));
  const sAna = (await src.collection('reddit_opportunity_analyses').where('projectId', '==', p.id).get()).docs.map((d) => d.data());
  const sDraft = (await src.collection('reddit_drafts').where('projectId', '==', p.id).get()).docs.map((d) => d.data());
  const S = buckets(sPosts, sAna, sDraft, 'postId');

  // target
  const pr = tgt.collection('projects').doc(p.id);
  const tItems = (await pr.collection('items').get()).docs.map((d) => ({ __id: d.id }));
  const tAna = (await pr.collection('analyses').get()).docs.map((d) => d.data());
  const tDraft = (await pr.collection('drafts').get()).docs.map((d) => d.data());
  const T = buckets(tItems, tAna, tDraft, 'itemId');

  const keys = ['items', 'analysed', 'brand', 'growth', 'answered'];
  const diff = keys.filter((k) => S[k] !== T[k]);
  const ok = diff.length === 0 && T.growthInvariantOk;
  if (!ok) mismatches++;
  console.log(`\n${p.name}  ${ok ? 'MATCH' : 'MISMATCH'}`);
  console.log(`  ${'bucket'.padEnd(10)} ${'ML Studio'.padStart(10)} ${'Engage'.padStart(10)}`);
  for (const k of keys) console.log(`  ${k.padEnd(10)} ${String(S[k]).padStart(10)} ${String(T[k]).padStart(10)}${S[k] !== T[k] ? '  <-- diff' : ''}`);
  console.log(`  growth invariant (growth ⇒ mention 'no'): ${T.growthInvariantOk ? 'holds' : 'VIOLATED'}`);
}

console.log(`\n${mismatches === 0 ? 'PARITY OK — every project buckets identically in both systems.' : `${mismatches} project(s) MISMATCH.`}`);
process.exit(mismatches === 0 ? 0 : 1);
