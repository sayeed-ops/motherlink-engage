// End-to-end checks on user administration against a running dev server.
//
// Focused on the properties that must hold, not the happy path. Each of these
// is something ML Studio gets wrong:
//
//   - anonymous access to the user list      (ML Studio: rules were allow-all)
//   - a plain member listing all users       (ML Studio: any signed-in user)
//   - a non-owner minting an owner           (ML Studio: any admin could invite
//                                             a super_admin despite
//                                             canManageRoles: false)
//   - self role change                       (no equivalent guard)
//
// Usage: cd tools && node e2e-users.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const PROBE = 'engage-e2e-probe@motherlink.io';

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
const env = readFileSync(join(import.meta.dirname, '..', 'apps', 'web', '.env.local'), 'utf8');
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)[1].trim();

initializeApp({ credential: cert(key), projectId: key.project_id });
const auth = getAuth();
const db = getFirestore();

async function tokenFor(uid) {
  const custom = await auth.createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  const { idToken } = await res.json();
  return idToken;
}

const hdr = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

const owner = await auth.getUserByEmail('sayeed@motherlink.io');
const ownerToken = await tokenFor(owner.uid);

console.log('\n--- anonymous ---');
let r = await fetch(`${BASE}/api/users`);
check('anonymous cannot list users', r.status === 401, `got ${r.status}`);

r = await fetch(`${BASE}/api/users`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'evil@example.com', role: 'owner' }),
});
check('anonymous cannot provision an owner', r.status === 401, `got ${r.status}`);

console.log('\n--- owner ---');
r = await fetch(`${BASE}/api/users`, { headers: hdr(ownerToken) });
const listed = await r.json();
check('owner can list users', r.status === 200 && Array.isArray(listed.users), `got ${r.status}`);

r = await fetch(`${BASE}/api/users`, {
  method: 'POST',
  headers: hdr(ownerToken),
  body: JSON.stringify({ email: PROBE, displayName: 'E2E Probe', role: 'member', sendEmail: false }),
});
const created = await r.json();
check('owner can provision a member', r.ok && created.uid, JSON.stringify(created));

r = await fetch(`${BASE}/api/users`, {
  method: 'PATCH',
  headers: hdr(ownerToken),
  body: JSON.stringify({ role: 'member' }),
});
check('PATCH on the collection is not a route', r.status === 405 || r.status === 404, `got ${r.status}`);

r = await fetch(`${BASE}/api/users/${owner.uid}`, {
  method: 'PATCH',
  headers: hdr(ownerToken),
  body: JSON.stringify({ role: 'member' }),
});
check('owner cannot change their own role', r.status === 400, `got ${r.status}`);

r = await fetch(`${BASE}/api/users/${owner.uid}`, {
  method: 'PATCH',
  headers: hdr(ownerToken),
  body: JSON.stringify({ status: 'disabled' }),
});
check('owner cannot disable themselves', r.status === 400, `got ${r.status}`);

console.log('\n--- plain member (the probe we just made) ---');
const probeToken = await tokenFor(created.uid);

r = await fetch(`${BASE}/api/users`, { headers: hdr(probeToken) });
check('a member cannot list users', r.status === 403, `got ${r.status}`);

r = await fetch(`${BASE}/api/users`, {
  method: 'POST',
  headers: hdr(probeToken),
  body: JSON.stringify({ email: 'x@example.com', role: 'admin' }),
});
check('a member cannot provision anyone', r.status === 403, `got ${r.status}`);

r = await fetch(`${BASE}/api/users/${created.uid}`, {
  method: 'PATCH',
  headers: hdr(probeToken),
  body: JSON.stringify({ role: 'owner' }),
});
check('a member cannot promote themselves to owner', r.status === 403, `got ${r.status}`);

r = await fetch(`${BASE}/api/projects`, { headers: hdr(probeToken) });
const seen = await r.json();
check('a member with no memberships sees zero projects', r.ok && seen.projects?.length === 0, JSON.stringify(seen));

console.log('\n--- admin cannot mint an owner ---');
await auth.setCustomUserClaims(created.uid, { role: 'admin' });
await db.collection('users').doc(created.uid).update({ role: 'admin' });
const adminToken = await tokenFor(created.uid);

r = await fetch(`${BASE}/api/users`, {
  method: 'POST',
  headers: hdr(adminToken),
  body: JSON.stringify({ email: 'sneaky-owner@example.com', role: 'owner', sendEmail: false }),
});
check('an admin cannot create an owner', r.status === 400, `got ${r.status}`);

r = await fetch(`${BASE}/api/users/${owner.uid}`, {
  method: 'PATCH',
  headers: hdr(adminToken),
  body: JSON.stringify({ role: 'member' }),
});
check('an admin cannot demote an owner', r.status === 400, `got ${r.status}`);

// cleanup
await auth.deleteUser(created.uid);
await db.collection('users').doc(created.uid).delete();
console.log('\ncleaned up the probe user.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
