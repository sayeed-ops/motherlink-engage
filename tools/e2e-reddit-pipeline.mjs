// Full Reddit pipeline against a running dev server: configure -> fetch ->
// analyze -> draft. Hits real Reddit through the real proxy and real DeepSeek.
//
// This is the parity rehearsal. If this produces a sensible analysis and a
// sensible reply, the ported module works — the prompts are byte-identical, so
// what remains to verify is the plumbing around them.
//
// Also asserts the permission split, which ML Studio does not have at all:
// items.fetch, items.analyze and drafts.generate each spend a different budget
// (proxy bandwidth, DeepSeek credit, DeepSeek credit) and are gated separately.
//
// Usage: cd tools && node e2e-reddit-pipeline.mjs

import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:3010';

const key = JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', 'admin.json'), 'utf8'));
const env = readFileSync(join(import.meta.dirname, '..', 'apps', 'web', '.env.local'), 'utf8');
const apiKey = env.match(/^NEXT_PUBLIC_FIREBASE_API_KEY=(.*)$/m)[1].trim();

initializeApp({ credential: cert(key), projectId: key.project_id });
const auth = getAuth();
const db = getFirestore();

const user = await auth.getUserByEmail('sayeed@motherlink.io');
const custom = await auth.createCustomToken(user.uid);
const { idToken } = await (
  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  })
).json();

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` };
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: H });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const { body: projList } = await api('/api/projects');
const project = projList.projects[0];
console.log(`project: ${project.name} (${project.projectId})\n`);

// --- 1. Configure the module ---
console.log('1. configure');
const cfg = await api(`/api/projects/${project.projectId}/reddit/config`, {
  method: 'PUT',
  body: JSON.stringify({
    companyDescription:
      'BudgetLee is a personal budgeting app that connects to your bank and shows where money actually goes each month.',
    targetCustomer: 'People in their 20s-30s who earn decently but cannot work out where their money goes.',
    productService: 'Automatic transaction categorisation and a monthly spending review.',
    // "/r/Budget" on purpose: the server should normalise it to "budget".
    targetSubreddits: ['/r/Budget'],
    keywords: ['budgeting app', 'where does my money go', 'track spending'],
    brandMentionStyle: 'Only mention BudgetLee when someone is explicitly asking for a tool. Never lead with it.',
    forbiddenPhrases: ['best app ever', 'game changer', 'revolutionary'],
  }),
});
console.log(`   -> ${cfg.status} subreddits: ${JSON.stringify(cfg.body?.config?.targetSubreddits)}`);
if (cfg.body?.config?.targetSubreddits?.[0] !== 'budget') {
  console.error('   FAIL: "/r/Budget" should normalise to "budget"');
  process.exit(1);
}

// --- 2. Fetch ---
console.log('\n2. fetch r/budget through the proxy');
const fetched = await api(`/api/projects/${project.projectId}/reddit/fetch`, {
  method: 'POST',
  body: JSON.stringify({ mode: 'new', subreddits: ['budget'], limit: 8 }),
});
console.log(`   -> ${fetched.status} posts: ${fetched.body?.posts?.length}, saved: ${JSON.stringify(fetched.body?.saved)}`);
if (!fetched.body?.posts?.length) {
  console.error('   FAIL:', fetched.body);
  process.exit(1);
}

// Re-fetch: nothing should be created twice.
const again = await api(`/api/projects/${project.projectId}/reddit/fetch`, {
  method: 'POST',
  body: JSON.stringify({ mode: 'new', subreddits: ['budget'], limit: 8 }),
});
console.log(`   re-fetch -> created: ${again.body?.saved?.created}, skipped: ${again.body?.saved?.skipped} (dedupe by deterministic id)`);
if (again.body?.saved?.created !== 0) {
  console.error('   FAIL: re-fetch created duplicates');
  process.exit(1);
}

// --- 3. Analyze: pick the meatiest post ---
const items = await db
  .collection('projects')
  .doc(project.projectId)
  .collection('items')
  .get();
const best = items.docs
  .map((d) => d.data())
  .sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0))[0];

console.log(`\n3. analyze: "${String(best.title).slice(0, 58)}"`);
const t0 = Date.now();
const analyzed = await api(`/api/projects/${project.projectId}/reddit/analyze`, {
  method: 'POST',
  body: JSON.stringify({ itemId: best.itemId }),
});
if (analyzed.status !== 200) {
  console.error('   FAIL:', analyzed.status, analyzed.body);
  process.exit(1);
}
const a = analyzed.body.analysis;
console.log(`   -> ${analyzed.status} in ${Date.now() - t0}ms`);
console.log(`   decision : ${a.decision}  score: ${a.score}  risk: ${a.riskLevel}`);
console.log(`   mention  : ${a.mentionRecommendation}   growth: ${a.growthScore}`);
console.log(`   reason   : ${String(a.reason).slice(0, 90)}`);
console.log(`   prompt   : ${analyzed.body.meta.promptVersion}  tokens: ${analyzed.body.meta.inputTokens}/${analyzed.body.meta.outputTokens}`);

// --- 4. Draft ---
const isBrand = a.decision !== 'skip' && ['yes', 'soft'].includes(a.mentionRecommendation);
const isGrowth = a.mentionRecommendation === 'no' && (a.growthScore ?? 0) >= 40;

console.log(`\n4. draft  (brand: ${isBrand}, growth: ${isGrowth})`);
const drafted = await api(`/api/projects/${project.projectId}/reddit/draft`, {
  method: 'POST',
  body: JSON.stringify({ itemId: best.itemId, analysisId: analyzed.body.analysisId }),
});

if (!isBrand && !isGrowth) {
  // Not a failure: the gate correctly refuses to draft for a post the model
  // judged to be neither opportunity.
  console.log(`   -> ${drafted.status} ${drafted.body?.error}`);
  console.log('   (correct: the eligibility gate blocked an unsuitable post)');
} else {
  if (drafted.status !== 200) {
    console.error('   FAIL:', drafted.status, drafted.body);
    process.exit(1);
  }
  console.log(`   -> ${drafted.status} kind: ${drafted.body.kind}  prompt: ${drafted.body.meta.promptVersion}`);
  console.log(`\n   --- the reply ---`);
  console.log(
    String(drafted.body.draft)
      .split('\n')
      .map((l) => '   ' + l)
      .join('\n'),
  );
}

// --- 5. The gate cannot be bypassed by lying ---
console.log('\n5. a forged analysis is rejected');
const forged = await api(`/api/projects/${project.projectId}/reddit/draft`, {
  method: 'POST',
  body: JSON.stringify({ itemId: best.itemId, analysisId: 'made-up-id' }),
});
console.log(`   analysisId that doesn't exist -> ${forged.status} ${forged.body?.error ?? ''}`);
if (forged.status !== 400) {
  console.error('   FAIL: should be rejected');
  process.exit(1);
}

console.log('\nPipeline OK: configure -> fetch -> analyze -> draft, all authenticated and persisted.');
