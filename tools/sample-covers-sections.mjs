// Widen the Covers sample for the conversation map.
//
// Sections are chosen for BEHAVIOURAL DIVERSITY rather than volume: a map built
// from one board measures that board. Strategy talk, bet-type talk and
// operator/industry talk are different conversations with different needs, and a
// map that has only seen game threads will report that bettors want picks.
//
// Runs through the real API so it exercises the same permissions and code paths
// the app does. Harvest is free; triage spends one model call per surviving post.

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';
const PID = process.argv[2];
const THREADS = Number(process.argv[3] || 4);
if (!PID) { console.error('usage: node sample-covers-sections.mjs <projectId> [threads]'); process.exit(1); }

// Chosen for behavioural diversity — strategy talk, bet-type talk, operator
// talk and game-thread talk are different conversations with different needs.
// Override from the command line with a comma-separated list.
const DEFAULT_SECTIONS = [
  { slug: 'systems-strategies-79', name: 'Systems & Strategies', sport: null },
  { slug: 'props-futures-15', name: 'Props & Futures', sport: null },
  { slug: 'gaming-industry---us-9', name: 'Gaming Industry - US', sport: null },
];

const SECTIONS = process.argv[4]
  ? process.argv[4].split(',').map((slug) => ({ slug: slug.trim(), name: slug.trim(), sport: null }))
  : DEFAULT_SECTIONS;

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
const env = readFileSync(join(import.meta.dirname, '..', 'apps', 'web', '.env.local'), 'utf8');
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)[1].trim();

initializeApp({ credential: cert(key), projectId: key.project_id });
const user = await getAuth().getUserByEmail('sayeed@motherlink.io');
const custom = await getAuth().createCustomToken(user.uid);
const { idToken } = await (await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }) },
)).json();

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` };
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: H });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// --- 1. make sure each section exists AND permits replies --------------------
// A watch-only section is screened out before anything looks at it, so triage
// against one produces nothing and spends nothing — which reads exactly like a
// quiet board.
const cfg = (await api(`/api/projects/${PID}/covers`)).body.config;
const bySlug = new Map(cfg.sections.map((s) => [s.slug, s]));
for (const s of SECTIONS) {
  const existing = bySlug.get(s.slug);
  bySlug.set(s.slug, existing
    ? { ...existing, roles: [...new Set([...existing.roles, 'reply'])] }
    : { ...s, roles: ['watch', 'reply'] });
}
const put = await api(`/api/projects/${PID}/covers`, {
  method: 'PUT',
  body: JSON.stringify({ config: { ...cfg, sections: [...bySlug.values()] } }),
});
console.log(`config: ${put.status === 200 ? 'ok' : `FAILED ${put.status}`} — ${bySlug.size} sections`);

// --- 2. harvest then triage, one section at a time --------------------------
for (const s of SECTIONS) {
  console.log(`\n=== ${s.slug} ===`);

  const t0 = Date.now();
  const h = await api(`/api/projects/${PID}/covers/harvest`, {
    method: 'POST',
    body: JSON.stringify({ section: s.slug, pages: 1, maxThreads: THREADS }),
  });
  if (h.status !== 200) { console.log(`  harvest FAILED ${h.status} ${h.body?.error ?? ''}`); continue; }
  console.log(`  harvest: listed ${h.body.summary.listed}, read ${h.body.summary.read}, ` +
              `${h.body.summary.posts} posts (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  const t1 = Date.now();
  // FOR_MAP widens the timing screens so nearly every post reaches the
  // classifier. The age screens are right for choosing where to reply and wrong
  // for learning what an audience needs — a need raised three months ago is
  // still a need. Costs a model call per surviving post.
  const t = await api(`/api/projects/${PID}/covers/triage`, {
    method: 'POST',
    body: JSON.stringify({ section: s.slug, forMap: process.env.FOR_MAP === '1' }),
  });
  if (t.status !== 200) { console.log(`  triage FAILED ${t.status} ${t.body?.error ?? ''}`); continue; }
  console.log(`  triage: ${t.body.posts} posts, ${t.body.intentCalls} calls, ` +
              `${t.body.counts.opportunity} qualified (${((Date.now() - t1) / 60000).toFixed(1)}m)`);
  console.log(`  outcomes: ${Object.entries(t.body.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')}`);
}

console.log('\ndone');
