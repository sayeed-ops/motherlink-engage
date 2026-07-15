// Read-only census of motherlink-studio Firestore.
//
// Uses count() aggregation queries, which bill 1 read per 1000 documents
// scanned rather than 1 read per document. Counting the whole database costs
// a handful of reads against the Spark 50k/day quota.
//
// Reports document counts ONLY. Never reads or prints document contents.
//
// Credential: ~/.config/motherlink-engage/migration-reader.json
//             (engage-migration-reader@, Cloud Datastore Viewer = read-only)

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config', 'motherlink-engage', 'migration-reader.json');

const sa = JSON.parse(readFileSync(KEY, 'utf8'));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();

// Every collection the audit identified, Reddit + platform.
const COLLECTIONS = [
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

console.log(`Project : ${sa.project_id}`);
console.log(`Identity: ${sa.client_email}\n`);

let total = 0;
const rows = [];

for (const name of COLLECTIONS) {
  try {
    const snap = await db.collection(name).count().get();
    const n = snap.data().count;
    total += n;
    rows.push([name, n, '']);
  } catch (err) {
    rows.push([name, null, err.code || err.message]);
  }
}

const w = Math.max(...rows.map((r) => r[0].length));
console.log('COLLECTION'.padEnd(w) + '   DOCS');
console.log('-'.repeat(w + 10));
for (const [name, n, err] of rows) {
  const val = n === null ? `ERROR ${err}` : String(n).padStart(6);
  console.log(name.padEnd(w) + '  ' + val);
}
console.log('-'.repeat(w + 10));
console.log('TOTAL'.padEnd(w) + String(total).padStart(8));

// A full migration read costs ~1 read per document. Spark allows 50k/day.
console.log(`\nSpark free tier: 50,000 reads/day`);
console.log(`Full copy costs ~${total.toLocaleString()} reads (~${((total / 50000) * 100).toFixed(1)}% of one day's quota)`);
console.log(
  total < 40000
    ? 'VERDICT: fits comfortably in a single-day cutover window.'
    : 'VERDICT: does NOT fit in one day on Spark. Cutover must be staged, or the project temporarily upgraded.',
);
