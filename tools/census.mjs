// Read-only breakdown of operationally significant fields.
// Uses count() aggregations grouped by field value. Counts ONLY — never reads
// or prints document contents.
//
// Answers two questions the migration plan requires before cutover:
//   1. promptVersion distribution — analyses below v3 have no growthScore and
//      will not appear in the Growth bucket. Parity testing must expect this.
//   2. reddit_post_jobs state — jobs stranded in 'posting' have no lease and
//      never self-resolve. They must be hand-resolved before cutover.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config', 'motherlink-engage', 'migration-reader.json');
const sa = JSON.parse(readFileSync(KEY, 'utf8'));
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();

async function countWhere(coll, field, value) {
  const snap = await db.collection(coll).where(field, '==', value).count().get();
  return snap.data().count;
}

async function breakdown(label, coll, field, values) {
  console.log(`\n${label}`);
  console.log('-'.repeat(label.length));
  let seen = 0;
  for (const v of values) {
    const n = await countWhere(coll, field, v);
    seen += n;
    console.log(`  ${String(v).padEnd(24)} ${String(n).padStart(5)}`);
  }
  const total = (await db.collection(coll).count().get()).data().count;
  if (seen !== total) {
    console.log(`  ${'(other / unset)'.padEnd(24)} ${String(total - seen).padStart(5)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(24)} ${String(total).padStart(5)}`);
}

await breakdown(
  'reddit_post_jobs by status  [cutover: "posting" = stranded, no lease exists]',
  'reddit_post_jobs',
  'status',
  ['queued', 'posting', 'posted', 'failed'],
);

await breakdown(
  'reddit_opportunity_analyses by promptVersion  [pre-v3 = no growthScore]',
  'reddit_opportunity_analyses',
  'promptVersion',
  ['v1', 'v2', 'v3'],
);

await breakdown(
  'reddit_drafts by status  [posted = the answered-ledger, must survive migration]',
  'reddit_drafts',
  'status',
  ['draft', 'posted', 'rejected'],
);

await breakdown(
  'reddit_accounts by status  [banned/flagged are hard-blocked by the rate gate]',
  'reddit_accounts',
  'status',
  ['active', 'warming', 'flagged', 'banned'],
);

await breakdown(
  'reddit_posts by processingStatus',
  'reddit_posts',
  'processingStatus',
  ['fetched', 'analyzed', 'drafted', 'skipped', 'archived'],
);

await breakdown('users by status', 'users', 'status', ['active', 'invited', 'suspended', 'deleted']);

await breakdown('invitations by status', 'invitations', 'status', [
  'pending',
  'accepted',
  'expired',
  'revoked',
]);
