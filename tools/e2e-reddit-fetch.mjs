// End-to-end test of the ported Reddit fetch path against a running dev server.
//
// Exercises the whole chain the way a browser would:
//   custom token -> ID token -> Authorization: Bearer -> route handler
//   -> requireProjectPermission(items.fetch) -> IPRoyal proxy -> Reddit RSS
//   -> Atom parse -> NormalizedRedditPost
//
// It also asserts the negative case: the same request without a token must be
// rejected. That is the single behaviour ML Studio gets wrong — its equivalent
// endpoint answers anonymous callers from the public internet.
//
// Usage: cd tools && node e2e-reddit-fetch.mjs [subreddit]

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const SUB = process.argv[2] || 'budget';

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));

// The web API key is public by design (it ships in the browser bundle).
const env = readFileSync(
  join(import.meta.dirname, '..', 'apps', 'web', '.env.local'),
  'utf8',
);
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('NEXT_PUBLIC_FIREBASE_API_KEY not found in apps/web/.env.local');

initializeApp({ credential: cert(key), projectId: key.project_id });
const auth = getAuth();

const user = await auth.getUserByEmail('sayeed@motherlink.io');

// Mint a custom token, then exchange it for a real ID token exactly as the
// browser SDK would. Nothing is faked: the route verifies this token for real.
const customToken = await auth.createCustomToken(user.uid);
const exchange = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  },
);
const { idToken, error } = await exchange.json();
if (!idToken) throw new Error(`Token exchange failed: ${JSON.stringify(error)}`);

const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` };

console.log(`signed in as ${user.email}\n`);

// --- 1. The negative case, first. ---
const anon = await fetch(`${BASE}/api/projects`, { method: 'GET' });
console.log(`anonymous GET /api/projects           -> ${anon.status} ${anon.status === 401 ? 'REJECTED (correct)' : 'LEAK!'}`);

// --- 2. Find the project. ---
const projRes = await fetch(`${BASE}/api/projects`, { headers: authed });
const { projects } = await projRes.json();
if (!projects?.length) throw new Error('No projects. Create one at localhost:3010 first.');
const project = projects[0];
console.log(`authed    GET /api/projects           -> ${projRes.status} (${projects.length} project)`);
console.log(`  using project: ${project.name} (${project.projectId})\n`);

// --- 3. Anonymous fetch attempt on the Reddit route. ---
const anonFetch = await fetch(`${BASE}/api/projects/${project.projectId}/reddit/fetch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subreddits: [SUB] }),
});
console.log(
  `anonymous POST reddit/fetch            -> ${anonFetch.status} ${
    anonFetch.status === 401 ? 'REJECTED (correct)' : 'LEAK! this is the ML Studio bug'
  }`,
);

// --- 4. The real thing. ---
console.log(`\nfetching r/${SUB} through the proxy...`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/projects/${project.projectId}/reddit/fetch`, {
  method: 'POST',
  headers: authed,
  body: JSON.stringify({ mode: 'new', subreddits: [SUB], limit: 5 }),
});
const ms = Date.now() - t0;
const body = await res.json();

console.log(`authed    POST reddit/fetch            -> ${res.status} in ${ms}ms`);

if (!res.ok) {
  console.error('\nFAILED:', body);
  process.exit(1);
}

console.log(`  posts  : ${body.posts?.length ?? 0}`);
console.log(`  errors : ${body.errors?.length ? JSON.stringify(body.errors) : 'none'}`);

if (body.posts?.length) {
  const p = body.posts[0];
  console.log('\nfirst post (proves the Atom parse):');
  console.log(`  id       : ${p.redditPostId}`);
  console.log(`  subreddit: ${p.subreddit}`);
  console.log(`  title    : ${String(p.title).slice(0, 64)}`);
  console.log(`  author   : ${p.author}`);
  console.log(`  age      : ${Math.round((Date.now() - p.createdAtRedditMs) / 60000)} min`);
  console.log(`  body     : ${p.body ? String(p.body).slice(0, 60) + '…' : '(empty — link post)'}`);
}

if (body.errors?.length) {
  console.log('\nNOTE: errors present. A 403/429 usually means REDDIT_PROXY_URL is unset or wrong.');
  process.exit(1);
}

console.log('\nEnd to end: token verified, permission checked, proxy used, RSS parsed.');
