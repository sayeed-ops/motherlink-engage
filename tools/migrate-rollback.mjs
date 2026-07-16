// Undo a migration: remove everything in Engage tagged { migratedFrom }.
//
//   node migrate-rollback.mjs             # DRY RUN — lists what would be removed
//   node migrate-rollback.mjs --confirm   # actually removes it
//
// Only touches docs carrying a migratedFrom tag, so it can never delete data
// created natively in Engage. Projects are removed with recursiveDelete (whole
// subtree); tagged top-level accounts/jobs are deleted individually.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIRM = process.argv.includes('--confirm');
const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();

const taggedProjects = (await db.collection('projects').where('migratedFrom', '!=', null).get()).docs;
const taggedAccounts = (await db.collection('accounts').where('migratedFrom', '!=', null).get()).docs;
const taggedJobs = (await db.collection('jobs').where('migratedFrom', '!=', null).get()).docs;

console.log(`\nRollback ${CONFIRM ? '' : 'DRY RUN '}— tagged docs in Engage:`);
console.log(`  projects: ${taggedProjects.length}  (${taggedProjects.map((d) => d.data().name).join(', ') || '—'})`);
console.log(`  accounts: ${taggedAccounts.length}`);
console.log(`  jobs    : ${taggedJobs.length}`);

if (!CONFIRM) {
  console.log('\n(dry run — nothing removed. Re-run with --confirm to remove.)\n');
  process.exit(0);
}

for (const d of taggedProjects) {
  await db.recursiveDelete(d.ref);
  console.log(`  removed project ${d.data().name}`);
}
for (const d of [...taggedAccounts, ...taggedJobs]) await d.ref.delete();
console.log(`  removed ${taggedAccounts.length} accounts + ${taggedJobs.length} jobs\n`);
console.log('Rollback complete.\n');
