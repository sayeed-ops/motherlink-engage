// Full read-only backup of motherlink-studio Firestore to local JSON.
//
// Why this exists: managed Firestore export requires the Blaze plan.
// motherlink-studio is on Spark, so `gcloud firestore export` is unavailable
// and there is NO restore point for production — not just for the migration,
// but at all. cleanupProjectHistory() and deleteProjectCascade() are one
// click away in the live UI and delete hundreds of documents with no undo.
//
// This is also the read half of the migration: same traversal, different sink.
//
// Read-only by construction: the credential is engage-migration-reader, which
// holds Cloud Datastore Viewer and literally cannot write.
//
// Usage:
//   node backup.mjs                 -> ./backups/<ISO>/
//   node backup.mjs --out /some/dir

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config', 'motherlink-engage', 'migration-reader.json');

// Every collection the audit found. Listed explicitly rather than discovered,
// so a collection appearing in production that we don't know about shows up as
// a discrepancy at the end instead of being silently backed up or silently
// missed.
const KNOWN = [
  'reddit_projects',
  'reddit_sources',
  'reddit_posts',
  'reddit_opportunity_analyses',
  'reddit_drafts',
  'reddit_accounts',
  'reddit_post_jobs',
  'reddit_agent_status',
  'users',
  'roles',
  'features',
  'invitations',
  'activity_logs',
  'system_settings',
];

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = outFlag >= 0 && args[outFlag + 1] ? args[outFlag + 1] : join(process.cwd(), 'backups', stamp);

const key = JSON.parse(readFileSync(KEY, 'utf8'));
initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();

/**
 * Firestore Timestamps don't survive JSON.stringify as anything useful, and
 * losing them would corrupt every createdAt in the archive. Convert to a
 * tagged object so the restore/migration side can reconstruct them exactly
 * rather than guessing whether a string was a date.
 */
function encode(value) {
  if (value instanceof Timestamp) {
    return { __type: 'timestamp', iso: value.toDate().toISOString() };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  }
  return value;
}

mkdirSync(outDir, { recursive: true });

console.log(`source : ${key.project_id}`);
console.log(`identity: ${key.client_email} (read-only)`);
console.log(`out    : ${outDir}\n`);

const manifest = { project: key.project_id, takenAt: new Date().toISOString(), collections: {} };
let total = 0;

for (const name of KNOWN) {
  const snap = await db.collection(name).get();
  const docs = snap.docs.map((d) => ({ id: d.id, data: encode(d.data()) }));

  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(docs, null, 2));
  manifest.collections[name] = docs.length;
  total += docs.length;

  console.log(`  ${name.padEnd(30)} ${String(docs.length).padStart(5)}`);
}

// Surface anything in production we didn't know about. Silence here is the
// dangerous outcome — an unknown collection means the audit missed something.
const live = await db.listCollections();
const unknown = live.map((c) => c.id).filter((id) => !KNOWN.includes(id) && !id.startsWith('_'));

manifest.total = total;
manifest.unknownCollections = unknown;
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`  ${'-'.repeat(36)}`);
console.log(`  ${'TOTAL'.padEnd(30)} ${String(total).padStart(5)}`);

if (unknown.length) {
  console.log(`\nWARNING: collections in production that this script does not know about:`);
  for (const u of unknown) console.log(`  - ${u}`);
  console.log('They were NOT backed up. Add them to KNOWN and re-run.');
} else {
  console.log('\nNo unknown collections. The audit inventory matches production.');
}

console.log(`\nBackup complete: ${outDir}`);
