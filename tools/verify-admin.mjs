// Connectivity check for the Engage server tier.
//
// Confirms two things:
//   1. The admin credential is valid and can reach motherlink-engage.
//   2. The Admin SDK bypasses the deployed rules, as the design requires.
//
// (2) matters because Engage's rules say `allow write: if false` on every
// collection. That is only workable if the server tier can still write. If this
// script fails, the whole "clients read, server writes" model is broken.
//
// It writes to _smoke, a collection deliberately NOT named in firestore.rules —
// so a client could not touch it under any circumstances. That makes it a fair
// test of admin bypass rather than of a permissive rule.
//
// Run: cd tools && node verify-admin.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config', 'motherlink-engage', 'admin.json');

let key;
try {
  key = JSON.parse(readFileSync(KEY, 'utf8'));
} catch (err) {
  console.error(`Could not read the admin key at ${KEY}`);
  console.error(err.message);
  process.exit(1);
}

initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();
const ref = db.collection('_smoke').doc('probe');

console.log('project :', key.project_id);
console.log('identity:', key.client_email);
console.log();

try {
  await ref.set({ ok: true, at: new Date().toISOString() });
  console.log('  write  OK   rules say `allow write: if false`; admin bypasses, by design');

  const snap = await ref.get();
  console.log('  read   OK   exists =', snap.exists);

  await ref.delete();
  const gone = await ref.get();
  console.log('  delete OK   exists =', gone.exists);

  console.log('\nServer tier can reach Firestore with write authority.');
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error('\nIf this is a PERMISSION_DENIED, the service account lacks Cloud Datastore User.');
  process.exit(1);
}
