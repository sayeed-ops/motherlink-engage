// Migrate ML Studio's Reddit data into Engage.
//
//   node migrate.mjs            # DRY RUN — reads source, validates, reports. Writes NOTHING.
//   node migrate.mjs --apply    # writes into Engage (takes a backup first via backup.mjs separately)
//
// Source: motherlink-studio (read-only key, migration-reader.json), flat
// `reddit_*` collections. Target: motherlink-engage (admin key), nested model.
//
// The key move: we REUSE each ML Studio project's document id as the Engage
// project id. Engage derives an item id as `${projectId}_${redditPostId}`, and
// ML Studio's post id is already exactly that — so with the project id kept,
// every item id equals the old post id, and analyses/drafts (which point at
// postId) relink with NO id remapping. Migration is a re-parent + field-rename,
// as OVERVIEW predicted. That also makes --apply idempotent: re-running upserts
// the same ids (it recursiveDeletes a previously-migrated project first).
//
// NOT migrated: users/roles/features/invitations/system_settings (Engage has its
// own auth), activity_logs (tied to ML Studio uids + a different action enum),
// agent_status (per-runtime). Membership is NOT assigned: migrated projects are
// visible to platform admins by role; granting specific teammates access to a
// client is a deliberate step for later, not a migration default.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const cfg = (f) => JSON.parse(readFileSync(join(homedir(), '.config', 'motherlink-engage', f), 'utf8'));

// --- source (read-only) ---
const srcKey = cfg('migration-reader.json');
const srcApp = initializeApp({ credential: cert(srcKey), projectId: srcKey.project_id }, 'source');
const src = getFirestore(srcApp);

// --- target (only initialised when applying) ---
let tgt = null;
let tgtAuth = null;
if (APPLY) {
  const tgtKey = cfg('admin.json');
  const tgtApp = initializeApp({ credential: cert(tgtKey), projectId: tgtKey.project_id }, 'target');
  tgt = getFirestore(tgtApp);
  tgtAuth = getAuth(tgtApp);
}

console.log(`\nMigration ${APPLY ? 'APPLY' : 'DRY RUN'}: ${srcKey.project_id} -> motherlink-engage\n`);

// --- read everything (flat) ---
const readAll = async (coll) => (await src.collection(coll).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const [projects, sources, posts, analyses, drafts, accounts, jobs] = await Promise.all([
  readAll('reddit_projects'),
  readAll('reddit_sources'),
  readAll('reddit_posts'),
  readAll('reddit_opportunity_analyses'),
  readAll('reddit_drafts'),
  readAll('reddit_accounts'),
  readAll('reddit_post_jobs'),
]);

const byProject = (rows) => {
  const m = new Map();
  for (const r of rows) (m.get(r.projectId) ?? m.set(r.projectId, []).get(r.projectId)).push(r);
  return m;
};
// Orphan policy: analyses/drafts whose post no longer exists are historical
// debris (ML Studio's purge / clean-history deleted the post over time). With no
// post they never render in the queue, so we SKIP them. A POSTED draft must
// never be skipped — that is the answered ledger — so an orphaned posted draft
// is treated as a blocking error, not silently dropped.
const postIds = new Set(posts.map((p) => p.id));
const analysisIds = new Set(analyses.map((a) => a.id));
const sourceIds = new Set(sources.map((s) => s.id));
const projectIds = new Set(projects.map((p) => p.id));

const keptAnalyses = analyses.filter((a) => postIds.has(a.postId));
const keptDrafts = drafts.filter((d) => postIds.has(d.postId));
const skippedAnalyses = analyses.length - keptAnalyses.length;
const skippedDraftRows = drafts.filter((d) => !postIds.has(d.postId));
const skippedPostedDrafts = skippedDraftRows.filter((d) => d.status === 'posted').length;
const keptAnalysisIds = new Set(keptAnalyses.map((a) => a.id));

const srcByP = byProject(sources);
const postByP = byProject(posts);
const anaByP = byProject(keptAnalyses);
const draftByP = byProject(keptDrafts);

// --- transforms (pure) ---
const has = (v) => v !== undefined && v !== null;
const projectDoc = (p) => ({
  projectId: p.id,
  name: p.name ?? '(unnamed)',
  clientWebsiteUrl: p.websiteUrl ?? '',
  status: p.status === 'archived' ? 'archived' : 'active',
  enabledModules: ['reddit'],
  createdBy: p.createdBy ?? null,
  createdByName: p.createdByName ?? '',
  createdAt: p.createdAt ?? null,
  updatedAt: p.updatedAt ?? null,
});
const moduleConfig = (p) => ({
  companyDescription: p.companyDescription ?? '',
  targetCustomer: p.targetCustomer ?? '',
  productService: p.productService ?? '',
  targetSubreddits: p.targetSubreddits ?? [],
  keywords: p.keywords ?? [],
  brandMentionStyle: p.brandMentionStyle ?? '',
  forbiddenPhrases: p.forbiddenPhrases ?? [],
});
const itemDoc = (post) => ({
  itemId: post.id, // == `${projectId}_${redditPostId}`
  projectId: post.projectId,
  platform: 'reddit',
  externalId: post.redditPostId,
  subreddit: post.subreddit,
  title: post.title ?? '',
  body: post.body ?? '',
  author: post.author ?? '',
  url: post.url ?? '',
  permalink: post.permalink ?? '',
  isSelfPost: post.isSelfPost ?? false,
  score: post.score ?? 0,
  numComments: post.numComments ?? 0,
  createdAtSource: post.createdAtReddit ?? null, // field rename
  fetchedAt: post.fetchedAt ?? null,
  processingStatus: post.processingStatus ?? 'fetched',
  isFavorite: post.isFavorite === true,
  createdBy: post.createdBy ?? null,
});
const analysisDoc = (a) => {
  const d = {
    analysisId: a.id,
    projectId: a.projectId,
    platform: 'reddit',
    itemId: a.postId, // == item id, no remap
    decision: a.decision,
    score: a.score,
    reason: a.reason ?? '',
    // Keep only refs to sources that still exist (display-only metadata).
    relevantSourceIds: (a.relevantSourceIds ?? []).filter((id) => sourceIds.has(id)),
    riskLevel: a.riskLevel ?? 'low',
    mentionRecommendation: a.mentionRecommendation ?? 'no',
    suggestedAngle: a.suggestedAngle ?? '',
    model: a.model ?? '',
    promptVersion: a.promptVersion ?? '',
    inputTokens: a.inputTokens ?? 0,
    outputTokens: a.outputTokens ?? 0,
    createdBy: a.createdBy ?? null,
    createdAt: a.createdAt ?? null,
  };
  // Growth fields stay ABSENT when the source lacks them (pre-v3) — that absence
  // is meaningful (those analyses never surface in the Growth bucket).
  if (has(a.growthScore)) d.growthScore = a.growthScore;
  if (has(a.growthAngle)) d.growthAngle = a.growthAngle;
  return d;
};
const draftDoc = (d) => {
  const out = {
    draftId: d.id,
    projectId: d.projectId,
    platform: 'reddit',
    itemId: d.postId, // == item id, no remap
    // Null a ref to an analysis we didn't migrate (its post was purged).
    analysisId: d.analysisId && keptAnalysisIds.has(d.analysisId) ? d.analysisId : null,
    body: d.body ?? '',
    status: d.status ?? 'draft',
    reviewerNotes: d.reviewerNotes ?? '',
    revisionOf: d.revisionOf ?? null,
    model: d.model ?? '',
    promptVersion: d.promptVersion ?? '',
    inputTokens: d.inputTokens ?? 0,
    outputTokens: d.outputTokens ?? 0,
    createdBy: d.createdBy ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
  if (has(d.postedByAccountId)) out.postedByAccountId = d.postedByAccountId;
  if (has(d.postedPermalink)) out.postedPermalink = d.postedPermalink;
  if (has(d.postedAt)) out.postedAt = d.postedAt;
  return out;
};
const sourceDoc = (s) => ({
  sourceId: s.id,
  projectId: s.projectId,
  type: s.type === 'pasted_text' ? 'pasted_text' : 'url',
  title: s.title ?? '',
  url: s.url ?? null,
  rawContent: s.rawContent ?? '',
  summary: s.summary ?? '',
  keyPoints: s.keyPoints ?? [],
  answerAngles: s.answerAngles ?? [],
  relatedProblems: s.relatedProblems ?? [],
  createdBy: s.createdBy ?? null,
  createdAt: s.createdAt ?? null,
  updatedAt: s.updatedAt ?? null,
});

// --- checks ---
const postsNoProject = posts.filter((p) => !projectIds.has(p.projectId));
const withGrowth = keptAnalyses.filter((a) => has(a.growthScore)).length;
const v3NoGrowth = keptAnalyses.filter((a) => a.promptVersion === 'v3' && !has(a.growthScore)).length;
const preV3WithGrowth = keptAnalyses.filter((a) => a.promptVersion !== 'v3' && has(a.growthScore)).length;

// --- report ---
console.log('Per project (kept — orphans excluded)');
console.log('-'.repeat(72));
for (const p of projects) {
  const ps = postByP.get(p.id) ?? [];
  const ds = draftByP.get(p.id) ?? [];
  const posted = ds.filter((d) => d.status === 'posted').length;
  console.log(
    `  ${(p.name ?? p.id).slice(0, 26).padEnd(27)} ` +
      `sources ${String((srcByP.get(p.id) ?? []).length).padStart(2)} · ` +
      `posts ${String(ps.length).padStart(3)} · ` +
      `analyses ${String((anaByP.get(p.id) ?? []).length).padStart(3)} · ` +
      `drafts ${String(ds.length).padStart(2)} (${posted} posted)`,
  );
}

console.log('\nTotals (source → kept)');
console.log('-'.repeat(72));
console.log(`  projects ${projects.length}  ·  sources ${sources.length}  ·  posts→items ${posts.length}`);
console.log(`  analyses ${analyses.length} → ${keptAnalyses.length}   (skipped ${skippedAnalyses} orphan)`);
console.log(`  drafts   ${drafts.length} → ${keptDrafts.length}   (skipped ${skippedDraftRows.length} orphan, all non-posted)`);
console.log(`  accounts ${accounts.length}  ·  jobs ${jobs.length}`);

console.log('\nGrowth-score presence (pre-v3 legitimately has none)');
console.log('-'.repeat(72));
console.log(`  kept analyses with growthScore: ${withGrowth} / ${keptAnalyses.length}`);
console.log(`  v3 MISSING growth             : ${v3NoGrowth}   (expected 0)`);
console.log(`  pre-v3 WITH growth            : ${preV3WithGrowth}   (expected 0)`);

console.log('\nSafety gates (must be 0)');
console.log('-'.repeat(72));
console.log(`  posts with no parent project  : ${postsNoProject.length}`);
console.log(`  POSTED drafts being skipped   : ${skippedPostedDrafts}   (answered ledger must survive)`);

const blocking = postsNoProject.length + skippedPostedDrafts + v3NoGrowth + preV3WithGrowth;
console.log(`\n${blocking === 0 ? 'READY' : `${blocking} BLOCKING`} — ${blocking === 0 ? 'safe to apply' : 'resolve before apply'}.`);

if (!APPLY) {
  console.log('\n(dry run — nothing written. Re-run with --apply to write into Engage.)\n');
  process.exit(blocking === 0 ? 0 : 1);
}

// ----------------------------------------------------------------------------
// APPLY
// ----------------------------------------------------------------------------
if (blocking > 0) {
  console.error('\nRefusing to apply: blocking integrity issues above.');
  process.exit(1);
}

const owner = await tgtAuth.getUserByEmail('sayeed@motherlink.io').catch(() => null);
const stamp = { migratedFrom: srcKey.project_id, migratedAt: FieldValue.serverTimestamp(), migratedBy: owner?.uid ?? null };

// Batched writer (Firestore caps a batch at 500).
let batch = tgt.batch();
let pending = 0;
const put = async (ref, data) => {
  batch.set(ref, data);
  if (++pending === 450) {
    await batch.commit();
    batch = tgt.batch();
    pending = 0;
  }
};
const flush = async () => {
  if (pending > 0) await batch.commit();
  batch = tgt.batch();
  pending = 0;
};

console.log('\nApplying…');
for (const p of projects) {
  const pref = tgt.collection('projects').doc(p.id);
  // Idempotency: clear a prior migration of THIS project (only if tagged).
  const existing = await pref.get();
  if (existing.exists && existing.data().migratedFrom) {
    await tgt.recursiveDelete(pref);
  }
  await put(pref, { ...projectDoc(p), ...stamp });
  await put(pref.collection('modules').doc('reddit'), moduleConfig(p));
  for (const s of srcByP.get(p.id) ?? []) await put(pref.collection('sources').doc(s.id), sourceDoc(s));
  for (const po of postByP.get(p.id) ?? []) await put(pref.collection('items').doc(po.id), itemDoc(po));
  for (const a of anaByP.get(p.id) ?? []) await put(pref.collection('analyses').doc(a.id), analysisDoc(a));
  for (const d of draftByP.get(p.id) ?? []) await put(pref.collection('drafts').doc(d.id), draftDoc(d));
  console.log(`  ${p.name}`);
}
// Top-level accounts + jobs (ids + projectId unchanged, so jobs still relink).
for (const acc of accounts) await put(tgt.collection('accounts').doc(acc.id), { ...acc, accountId: acc.id, ...stamp });
for (const j of jobs) await put(tgt.collection('jobs').doc(j.id), { ...j, jobId: j.id, ...stamp });
await flush();

console.log('\nVerifying counts in Engage…');
const tcount = async (path) => {
  const parts = path.split('/');
  let ref = tgt;
  for (let i = 0; i < parts.length; i += 2) ref = i === 0 ? tgt.collection(parts[0]) : ref.doc(parts[i - 1]).collection(parts[i]);
  return (await ref.count().get()).data().count;
};
let items = 0, ana = 0, drf = 0, srcC = 0;
for (const p of projects) {
  const pr = tgt.collection('projects').doc(p.id);
  items += (await pr.collection('items').count().get()).data().count;
  ana += (await pr.collection('analyses').count().get()).data().count;
  drf += (await pr.collection('drafts').count().get()).data().count;
  srcC += (await pr.collection('sources').count().get()).data().count;
}
const acctC = (await tgt.collection('accounts').where('migratedFrom', '==', srcKey.project_id).count().get()).data().count;
const jobC = (await tgt.collection('jobs').where('migratedFrom', '==', srcKey.project_id).count().get()).data().count;
const line = (label, got, want) => console.log(`  ${label.padEnd(10)} ${String(got).padStart(4)} / ${String(want).padStart(4)}  ${got === want ? 'ok' : 'MISMATCH'}`);
line('items', items, posts.length);
line('analyses', ana, keptAnalyses.length);
line('drafts', drf, keptDrafts.length);
line('sources', srcC, sources.length);
line('accounts', acctC, accounts.length);
line('jobs', jobC, jobs.length);

const ok = items === posts.length && ana === keptAnalyses.length && drf === keptDrafts.length && srcC === sources.length;
console.log(`\n${ok ? 'APPLY OK' : 'APPLY MISMATCH'} — migrated ${projects.length} projects into Engage.`);
console.log('Migrated projects are tagged { migratedFrom } and visible to platform admins. To undo:');
console.log('  node migrate-rollback.mjs   (removes everything tagged migratedFrom)\n');
process.exit(ok ? 0 : 1);
