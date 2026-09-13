// Queue the two-account concurrency dry-run test: one short, browse-only warm-up
// each for Wasim.2 and Wasim.3, at the same moment.
//
// Refuses unless agents/control.dryRun is true. The plan has no upvote or join
// steps, so even a live agent would only scroll and read. Prints the job ids to
// hand to the watcher.
//
// Usage: cd tools && node queue-concurrency-test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const require = createRequire(new URL('../apps/poster-agent/package.json', import.meta.url));
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db = getFirestore(initializeApp({ credential: cert(JSON.parse(readFileSync(`${homedir()}/.config/motherlink-engage/admin.json`, 'utf8'))) }));

const ACCOUNTS = ['v0CKMFWWBlz9aFH3Vgof' /* Wasim.2 */, '2gdTUaxUR2lo34HJbf8e' /* Wasim.3 */];
const PLAN = [
  { type: 'open_feed', feed: 'home', bursts: 2 },
  { type: 'scroll_feed', bursts: 2 },
  { type: 'open_feed_post', minIndex: 2, maxIndex: 5, maxScrolls: 4, maxSeconds: 45 },
  { type: 'read_post', seconds: 45 },
];

const control = (await db.doc('agents/control').get()).data() || {};
if (control.dryRun !== true) {
  console.error(`Refusing: agents/control.dryRun is ${control.dryRun}. Turn dry run ON first.`);
  process.exit(1);
}
const busy = await db.collection('jobs').where('status', 'in', ['queued', 'posting']).get();
if (!busy.empty) {
  console.error(`Refusing: ${busy.size} job(s) already queued or running — this test wants an empty queue.`);
  process.exit(1);
}

const ids = [];
for (const accountId of ACCOUNTS) {
  const acc = (await db.collection('accounts').doc(accountId).get()).data();
  if (!acc) throw new Error(`account ${accountId} not found`);
  const ref = db.collection('jobs').doc();
  await ref.set({
    jobId: ref.id,
    kind: 'warmup',
    warmupKind: 'browse',
    accountId,
    adsPowerProfileId: acc.adsPowerProfileId,
    expectedUsername: acc.username || '',
    warmupPlan: PLAN,
    status: 'queued',
    attempts: 0,
    createdBy: 'concurrency-test',
    createdByName: 'Concurrency dry-run test',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  ids.push(ref.id);
  console.log(`queued warm-up for ${acc.label} (u/${acc.username}) → job ${ref.id}`);
}
console.log(`\nWATCH: node watch-concurrency-test.mjs ${ids.join(' ')}`);
process.exit(0);
