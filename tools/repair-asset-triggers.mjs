// Repair assets whose triggers are whole sentences.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Retrieval requires EVERY token of a trigger phrase to appear in the thread, so
// a trigger of fifteen words fires on nothing. The first version of the
// answered-knowledge importer stored each interview question whole as its
// asset's only trigger — which made every imported asset silently inert:
// present in the library, counted in the totals, and unreachable by any post.
//
// A live triage run found it. A forum post asking about deposit bonuses matched
// nothing in a library holding seven assets about bonuses.
//
// DRY RUN BY DEFAULT. Rewriting triggers changes what the library matches, so
// the before and after are printed and nothing is written without --apply.
// ════════════════════════════════════════════════════════════════════════════
//
// Usage:
//   node repair-asset-triggers.mjs <projectId>            dry run
//   node repair-asset-triggers.mjs <projectId> --apply    write it
//
// The dev server must be up; the repair runs through the API so it goes through
// the same permission check a person would.

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const argv = process.argv.slice(2);
const PROJECT = argv.find((a) => !a.startsWith('--'));
const APPLY = argv.includes('--apply');

if (!PROJECT) {
  console.error('Usage: node repair-asset-triggers.mjs <projectId> [--apply]');
  process.exit(1);
}

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
const proj = db.collection('projects').doc(PROJECT);

/** Every asset field, and the claims, as they stand right now. */
async function snapshot() {
  const [assets, claims] = await Promise.all([proj.collection('assets').get(), proj.collection('claims').get()]);
  return {
    assets: new Map(assets.docs.map((d) => [d.id, d.data()])),
    claims: new Map(claims.docs.map((d) => [d.id, d.data()])),
  };
}

const name = (await proj.get()).data()?.name ?? PROJECT;
console.log(`project: ${name} (${PROJECT})`);
console.log(`mode   : ${APPLY ? 'APPLY — this writes' : 'DRY RUN — nothing is written'}\n`);

const before = await snapshot();

const res = await fetch(`${BASE}/api/projects/${PROJECT}/knowledge/assets/repair-triggers`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ apply: APPLY }),
});
const body = await res.json();

if (res.status !== 200) {
  console.error(`failed: ${res.status}`, body);
  process.exit(1);
}

console.log(`assets in library      ${body.assets}`);
console.log(`assets to repair       ${body.repaired}`);
console.log(`assets left untouched  ${body.assets - body.repaired}\n`);

console.log('═'.repeat(78));
console.log('BEFORE / AFTER');
console.log('═'.repeat(78));
for (const r of body.repairs) {
  console.log(`\n── ${r.title}`);
  for (const b of r.before) console.log(`   before : ${JSON.stringify(b)}`);
  console.log(`   after  : ${JSON.stringify(r.after)}`);
}

// ── Prove nothing else moved ───────────────────────────────────────────────
if (APPLY) {
  const after = await snapshot();
  const IGNORED = new Set(['triggers', 'updatedAt']);
  const changed = [];

  for (const [id, was] of before.assets) {
    const now = after.assets.get(id);
    if (!now) {
      changed.push(`asset ${id} DISAPPEARED`);
      continue;
    }
    for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (IGNORED.has(field)) continue;
      if (JSON.stringify(was[field]) !== JSON.stringify(now[field])) {
        changed.push(`asset ${id}.${field} changed`);
      }
    }
  }

  for (const [id, was] of before.claims) {
    const now = after.claims.get(id);
    if (!now) {
      changed.push(`claim ${id} DISAPPEARED`);
      continue;
    }
    if (JSON.stringify(was) !== JSON.stringify(now)) changed.push(`claim ${id} changed`);
  }

  const questions = await proj.collection('interview').doc('current').collection('questions').count().get();

  console.log('\n' + '═'.repeat(78));
  console.log('WHAT ELSE MOVED');
  console.log('═'.repeat(78));
  console.log(`  assets before/after    ${before.assets.size} / ${after.assets.size}`);
  console.log(`  claims before/after    ${before.claims.size} / ${after.claims.size}`);
  console.log(`  interview questions    ${questions.data().count} (never touched by this route)`);
  console.log(`  fields changed besides triggers: ${changed.length}`);
  for (const c of changed.slice(0, 20)) console.log(`    ${c}`);

  if (changed.length > 0) process.exit(1);
  console.log('\n  Nothing but `triggers` (and its updatedAt stamp) was written.');
}

console.log(APPLY ? '\nAPPLIED' : '\nDry run only. Re-run with --apply to write it.');
