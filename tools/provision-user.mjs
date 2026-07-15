// Provision a user. This is the bootstrap path, and the admin escape hatch.
//
// Why a CLI and not a page: ML Studio ships /seed — a PUBLIC, unauthenticated
// route that calls signupWithEmail() and then writes a super_admin user doc.
// Anyone who could reach it while the database was empty could self-provision
// as super_admin. Engage has no equivalent route, by design. Bootstrapping
// requires the admin key, which lives on your machine outside the repo.
//
// Provisioning is by EMAIL, not by invitation token. The user then signs in
// with Google, and the server matches their *verified* Google email against
// users/{uid}. There is no token to generate, expire, leak, or enumerate —
// which deletes ML Studio's entire invitation attack surface (Math.random()
// tokens, stored in plaintext, world-readable until this morning).
//
// Usage:
//   node provision-user.mjs <email> [--role owner|admin|member] [--name "Full Name"]
//
// Examples:
//   node provision-user.mjs sayeed@motherlink.io --role owner --name "Sayeed"
//   node provision-user.mjs teammate@motherlink.io --role member

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config', 'motherlink-engage', 'admin.json');
const ROLES = ['owner', 'admin', 'member'];

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const role = flag('role', 'member');
const displayName = flag('name', email?.split('@')[0] ?? '');

if (!email || !email.includes('@')) {
  console.error('Usage: node provision-user.mjs <email> [--role owner|admin|member] [--name "Full Name"]');
  process.exit(1);
}
if (!ROLES.includes(role)) {
  console.error(`--role must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

const key = JSON.parse(readFileSync(KEY, 'utf8'));
initializeApp({ credential: cert(key), projectId: key.project_id });
const auth = getAuth();
const db = getFirestore();

console.log(`project: ${key.project_id}`);
console.log(`email  : ${email}`);
console.log(`role   : ${role}\n`);

// Reuse the Auth user if they have already signed in with Google; otherwise
// create the record now so the profile exists before their first sign-in.
let user;
try {
  user = await auth.getUserByEmail(email);
  console.log(`Found existing auth user (${user.uid}).`);
} catch (err) {
  if (err.code !== 'auth/user-not-found') throw err;
  user = await auth.createUser({ email, displayName, emailVerified: false });
  console.log(`Created auth user (${user.uid}).`);
  console.log('They can sign in with Google using this address, or set a password via reset.');
}

// Mirror the global role into a custom claim so security rules can check it
// without a document read. Coarse only — per-project permissions live in
// projects/{id}/members/{uid} and would blow the 1000-byte claim limit.
await auth.setCustomUserClaims(user.uid, { role });
console.log(`Set custom claim: role=${role}`);

const ref = db.collection('users').doc(user.uid);
const existing = await ref.get();
const now = new Date();

await ref.set(
  {
    uid: user.uid,
    email,
    displayName: displayName || user.displayName || email.split('@')[0],
    avatarUrl: user.photoURL ?? null,
    role,
    status: 'active',
    globalPermissions: role === 'owner' || role === 'admin' ? ['accounts.manage'] : [],
    createdAt: existing.exists ? existing.data().createdAt : now,
    updatedAt: now,
    lastLoginAt: existing.exists ? (existing.data().lastLoginAt ?? null) : null,
    invitedBy: 'cli',
  },
  { merge: true },
);

console.log(`${existing.exists ? 'Updated' : 'Created'} users/${user.uid}`);
console.log('\nDone. They can now sign in.');
console.log('Note: an existing session must sign out and back in to pick up a changed claim.');
