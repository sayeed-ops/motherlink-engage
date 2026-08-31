import 'server-only';

// Turning a qualified opportunity into replies, scores, a selection — or a
// recorded NONE.
//
// Everything that DECIDES anything is pure and lives in modules/covers:
// variants, score, compliance, selectVariant. This file loads what those need,
// makes the model calls, and writes the results. Same split as
// server/coversTriage.ts and server/knowledge.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// THE COST ORDER, AGAIN — AND THE CRITIC IS THE THIRD CALL, NOT THE FIRST
//
//   1. PAID   generate the eligible library-backed variants   (0 or 1 call)
//   2. PAID   generate community-only, with no library in context (0 or 1 call)
//   3. PAID   score everything written, in one call            (0 or 1 call)
//   4. FREE   compliance, floors, drops
//   5. PAID   the critic — ONLY when two or three variants survived (0 or 1)
//
// Steps 1 and 2 write nothing that could not be posted, because the eligibility
// mask already ran for free in phase 3. Step 5 is skipped entirely when
// arithmetic has already settled the answer, which is most of the time: all
// dropped is NONE with no call, and one survivor is the answer with no call.
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ NOTHING HERE CAN POST. There is no job kind, no enqueue, no agent
// vocabulary and no Covers DOM adapter in the tree. An approved draft is a text
// a person copies. See modules/covers/draft.ts for why the status enum stops at
// `approved`.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { loadLibrary } from './knowledge';
import { getCoversConfig, listCoversItems, listCoversPosts, type StoredCoversPost } from './covers';
import { getCoversPolicy, listTriage, type CoversPolicyDoc, type StoredTriage } from './coversTriage';
import { claimStatus } from '@/modules/knowledge/freshness';
import { ASSERTABLE, type Asset, type Claim } from '@/modules/knowledge/types';

import { profileSection, renderRegister, targetLength, type SectionRegister } from '@/modules/covers/register';
import {
  buildBrandPrompt,
  buildCommunityPrompt,
  eligibleKinds,
  isLibraryBacked,
  parseVariants,
  VARIANT_FLAG,
  VARIANT_KINDS,
  VARIANT_PROMPT_VERSION,
  type PromptClaim,
  type VariantDraft,
  type VariantKind,
} from '@/modules/covers/variants';
import {
  buildScorePrompt,
  parseAssessments,
  SCORE_PROMPT_VERSION,
  type VariantAssessment,
} from '@/modules/covers/score';
import {
  checkCompliance,
  type CheckableClaim,
  type ComplianceContext,
  type ComplianceResult,
} from '@/modules/covers/compliance';
import {
  buildCriticPrompt,
  CRITIC_PROMPT_VERSION,
  dropBeforeCritic,
  fromCritic,
  noneFromDrops,
  parseCriticVerdict,
  soleSurvivor,
  type Selection,
} from '@/modules/covers/selectVariant';
import { promotionPermitted } from '@/modules/covers/sections';
import type { CoversDraft, DraftContext, WrittenVariant } from '@/modules/covers/draft';
import type { AskModel } from './coversTriage';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface GenerateRunOptions {
  /** Which triage run's opportunities to write for. Omitted means the most
   *  recent analyses for the section. */
  runId?: string;
  section?: string;
  /** Ceiling on OPPORTUNITIES processed, not on model calls — each opportunity
   *  costs between two and four calls and the count is reported. */
  maxOpportunities: number;
  nowMs: number;
}

export interface GenerateRun {
  runId: string;
  drafts: CoversDraft[];
  opportunities: number;
  /** The bill, split so a run that spent most of its money on critics is
   *  visible as such. */
  calls: { generate: number; score: number; critic: number };
  /** Opportunities the cap stopped us reaching. Reported for the same reason
   *  budgetSkipped is in triage: a short queue and a quiet forum look identical
   *  unless the number is on the screen. */
  skipped: number;
  model: string;
}

/**
 * Write replies for the qualified opportunities of one triage run.
 *
 * ⚠️ ONLY `opportunity` OUTCOMES ARE GENERATED FOR. A `no-asset-match` post is a
 * gap, not a thing to write about, and a `complaint` left the pipeline
 * altogether upstream. Passing anything else here would be generating a reply
 * the funnel already decided against.
 */
export async function runGeneration(
  projectId: string,
  opts: GenerateRunOptions,
  ask: AskModel,
): Promise<GenerateRun> {
  const [config, policy, library, triaged] = await Promise.all([
    getCoversConfig(projectId),
    getCoversPolicy(projectId),
    loadLibrary(projectId),
    listTriage(projectId, { runId: opts.runId, section: opts.section, limit: 500 }),
  ]);

  const activeAssets = library.assets.filter((a) => a.status === 'active');
  const assetById = new Map(activeAssets.map((a) => [a.assetId, a]));
  const claimsByAsset = groupClaims(activeAssets, library.claims, opts.nowMs);

  const opportunities = triaged
    .filter((t) => t.outcome === 'opportunity')
    .sort((a, b) => b.score - a.score);

  const runId = project(projectId).collection('drafts').doc().id;
  const calls = { generate: 0, score: 0, critic: 0 };
  const drafts: CoversDraft[] = [];
  let modelId = '';
  let skipped = 0;

  // Thread bodies are needed for the register and for the post text, and one
  // thread usually carries several opportunities — read once, reused.
  const postsByItem = new Map<string, StoredCoversPost[]>();
  const items = await listCoversItems(projectId, { section: opts.section, limit: 500 });
  const itemById = new Map(items.map((i) => [i.itemId, i]));

  for (const t of opportunities) {
    if (drafts.length >= opts.maxOpportunities) {
      skipped++;
      continue;
    }

    const item = itemById.get(t.itemId);
    if (!item) continue;

    if (!postsByItem.has(t.itemId)) {
      postsByItem.set(t.itemId, await listCoversPosts(projectId, t.itemId));
    }
    const posts = postsByItem.get(t.itemId)!;
    const post = posts.find((p) => p.postId === t.postId);
    if (!post) continue;

    const section = config.sections.find((s) => s.slug === t.section);

    const result = await generateForOpportunity(
      {
        projectId,
        triage: t,
        item: { itemId: item.itemId, title: item.title, url: item.url },
        post,
        posts,
        sectionName: section?.name ?? t.section,
        sections: config.sections,
        policy,
        assetById,
        claimsByAsset,
        runId,
      },
      ask,
      calls,
    );

    modelId = result.model || modelId;
    drafts.push(result.draft);
  }

  return {
    runId,
    drafts,
    opportunities: opportunities.length,
    calls,
    skipped,
    model: modelId,
  };
}

// ---------------------------------------------------------------------------
// One opportunity
// ---------------------------------------------------------------------------

interface OpportunityInput {
  projectId: string;
  triage: StoredTriage;
  item: { itemId: string; title: string; url: string };
  post: StoredCoversPost;
  posts: readonly StoredCoversPost[];
  sectionName: string;
  sections: ReturnType<typeof getCoversConfig> extends Promise<infer C>
    ? C extends { sections: infer S }
      ? S
      : never
    : never;
  policy: CoversPolicyDoc;
  assetById: Map<string, Asset>;
  claimsByAsset: Map<string, PromptClaim[]>;
  runId: string;
}

async function generateForOpportunity(
  input: OpportunityInput,
  ask: AskModel,
  calls: { generate: number; score: number; critic: number },
): Promise<{ draft: CoversDraft; model: string }> {
  const { triage, policy } = input;

  const register = profileSection(input.posts);
  const length = targetLength(register);
  const registerLines = renderRegister(register, length);

  const matchedAssetIds = triage.retrieval?.matched.map((m) => m.assetId) ?? [];
  const assets = matchedAssetIds
    .map((id) => input.assetById.get(id))
    .filter((a): a is Asset => Boolean(a));

  // ⚠️ ONLY LIVE CLAIMS REACH THE PROMPT. An expired one in front of the model
  // invites a reply built on it that compliance then has to reject — paying to
  // write something we already knew we would throw away.
  const claims = matchedAssetIds.flatMap((id) => input.claimsByAsset.get(id) ?? []);

  const linksPermitted = promotionPermitted(input.sections, triage.section);

  const promptInput = {
    sectionName: input.sectionName,
    threadTitle: input.item.title,
    postBody: input.post.body,
    context: neighbours(input.posts, input.post.postId),
    problem: triage.intent?.problem ?? '',
    register,
    length,
    assets,
    claims,
    brandNames: policy.brandNames,
    linksPermitted,
  };

  const eligible = eligibleKinds(triage.variants);
  const ineligible = VARIANT_KINDS.filter((k) => !triage.variants[VARIANT_FLAG[k]]).map((k) => ({
    kind: k,
    reason: triage.eligibilityReasons[VARIANT_FLAG[k]] ?? 'Not eligible for this post.',
  }));

  let model = '';
  const written: VariantDraft[] = [];

  // ── 1 & 2. generate ───────────────────────────────────────────────────────
  const libraryKinds = eligible.filter(isLibraryBacked);
  if (libraryKinds.length > 0) {
    calls.generate++;
    const { parsed, model: m } = await askJson(ask, buildBrandPrompt(libraryKinds, promptInput), 1800);
    model = m || model;
    written.push(...parseVariants(parsed, libraryKinds));
  }

  if (eligible.includes('community-only')) {
    // Its own call, with no library in context. See the two-calls note in
    // variants.ts — "does not draw on the library" has to be a fact about how
    // the text was produced, not a label on it.
    calls.generate++;
    const { parsed, model: m } = await askJson(ask, buildCommunityPrompt(promptInput), 900);
    model = m || model;
    written.push(...parseVariants(parsed, ['community-only']));
  }

  // ── 3. score, in one call over everything written ─────────────────────────
  let assessments: VariantAssessment[] = [];
  if (written.length > 0) {
    calls.score++;
    const { parsed, model: m } = await askJson(
      ask,
      buildScorePrompt(written, {
        sectionName: input.sectionName,
        threadTitle: input.item.title,
        postBody: input.post.body,
        problem: triage.intent?.problem ?? '',
        registerLines,
        claims: claims.map((c) => ({ claimId: c.claimId, text: c.text })),
        linksPermitted,
        brandNames: policy.brandNames,
      }),
      1200,
    );
    model = m || model;
    assessments = parseAssessments(parsed, written.map((w) => w.kind));
  }

  // ── 4. compliance and the floors, free ────────────────────────────────────
  const checkable: CheckableClaim[] = claims.map((c) => ({
    claimId: c.claimId,
    text: c.text,
    sourceUrl: c.sourceUrl,
    assetId: c.assetId,
    assetTitle: c.assetTitle,
    live: true,
  }));

  const complianceCtx: ComplianceContext = {
    section: triage.section,
    sections: input.sections,
    register,
    length,
    claims: checkable,
    brandNames: policy.brandNames,
    jurisdiction: policy.jurisdiction,
    threadText: `${input.item.title}\n${input.post.body}`,
    disclosureWording: policy.disclosureWording,
  };

  const compliance = new Map<VariantKind, ComplianceResult>();
  for (const draft of written) {
    compliance.set(draft.kind, checkCompliance(draft, complianceCtx));
  }

  const { survivors, dropped } = dropBeforeCritic({
    eligible,
    ineligible,
    drafts: written,
    assessments,
    compliance,
    floors: policy.floors,
  });

  // ── 5. the critic, only when there is a choice to make ────────────────────
  let selection: Selection;
  if (survivors.length === 0) {
    selection = noneFromDrops(dropped);
  } else if (survivors.length === 1) {
    selection = soleSurvivor(survivors[0], dropped);
  } else {
    calls.critic++;
    const { parsed, model: m } = await askJson(
      ask,
      buildCriticPrompt(survivors, {
        sectionName: input.sectionName,
        threadTitle: input.item.title,
        postBody: input.post.body,
        problem: triage.intent?.problem ?? '',
        registerLines,
      }),
      500,
    );
    model = m || model;
    selection = fromCritic(
      parseCriticVerdict(parsed, survivors.map((s) => s.draft.kind)),
      survivors,
      dropped,
    );
  }

  const context: DraftContext = {
    itemId: input.item.itemId,
    postId: input.post.postId,
    section: triage.section,
    sectionName: input.sectionName,
    threadTitle: input.item.title,
    threadUrl: input.item.url,
    postAuthor: input.post.author,
    postBody: input.post.body,
    postCreatedAtMs: input.post.createdAtMs,
    intent: triage.intent?.intent ?? null,
    problem: triage.intent?.problem ?? '',
    matchedAssets:
      triage.retrieval?.matched.map((m) => ({
        assetId: m.assetId,
        title: m.title,
        triggers: m.why.triggers,
      })) ?? [],
    opportunityScore: triage.score,
  };

  const variants: WrittenVariant[] = written.map((d) => {
    const c = compliance.get(d.kind)!;
    const a = assessments.find((x) => x.kind === d.kind);
    return {
      kind: d.kind,
      text: d.text,
      words: d.words,
      claimIds: d.claimIds,
      scores: a?.scores ?? null,
      recommendation: a?.recommendation ?? null,
      why: a?.why ?? '',
      compliancePassed: c.ok,
      complianceFailures: c.failures,
      evidence: c.evidence,
      assertions: c.assertions,
      disclosure: c.disclosure,
    };
  });

  const draft: CoversDraft = {
    draftId: '',
    projectId: input.projectId,
    platform: 'covers',
    runId: input.runId,
    analysisId: triage.analysisId,
    context,
    variants,
    dropped: selection.dropped,
    selected: selection.selected,
    selectionReason: selection.reason,
    criticCalled: selection.criticCalled,
    // A declined attempt is terminal and is NOT `pending`: nobody needs to
    // review a reply the pipeline decided not to write.
    status: selection.selected === 'NONE' ? 'none' : 'pending',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionReason: '',
    model,
    promptVersions: {
      variants: VARIANT_PROMPT_VERSION,
      score: SCORE_PROMPT_VERSION,
      critic: CRITIC_PROMPT_VERSION,
    },
    createdBy: '',
    createdAt: new Date(),
  };

  return { draft, model };
}

/** Two posts either side, oldest first, for context only. */
function neighbours(posts: readonly StoredCoversPost[], postId: string): string[] {
  const i = posts.findIndex((p) => p.postId === postId);
  if (i < 0) return [];
  return posts
    .slice(Math.max(0, i - 2), i)
    .map((p) => p.body)
    .filter((b) => b.trim());
}

async function askJson(
  ask: AskModel,
  prompt: { system: string; user: string },
  maxTokens: number,
): Promise<{ parsed: unknown; model: string }> {
  const { content, model } = await ask({
    system: prompt.system,
    user: prompt.user,
    // Writing wants a little room; scoring and choosing do not. One temperature
    // for all three is simpler and worse — a deterministic generator writes the
    // same three replies for every thread on the board.
    temperature: maxTokens > 1000 ? 0.7 : 0.2,
    maxTokens,
    json: true,
  });

  try {
    return { parsed: JSON.parse(content), model };
  } catch {
    // Left null: every parser in modules/covers treats unreadable input as
    // "nothing was produced", which is a legitimate outcome meaning NONE.
    return { parsed: null, model };
  }
}

/**
 * Live claims per asset, in the shape the prompt wants.
 *
 * `ASSERTABLE` rather than `live` alone: an `expiring` claim is still assertable
 * — that state exists to ask for re-verification, not to withdraw the fact — and
 * treating it as dead would silently empty the citable set two weeks before
 * anything actually expired.
 */
function groupClaims(
  assets: readonly Asset[],
  claims: readonly Claim[],
  nowMs: number,
): Map<string, PromptClaim[]> {
  const byId = new Map(assets.map((a) => [a.assetId, a]));
  const out = new Map<string, PromptClaim[]>();

  for (const claim of claims) {
    const asset = byId.get(claim.assetId);
    if (!asset) continue;
    if (!(ASSERTABLE as readonly string[]).includes(claimStatus(claim, asset, nowMs))) continue;

    const list = out.get(claim.assetId) ?? [];
    list.push({
      claimId: claim.claimId,
      text: claim.text,
      sourceUrl: claim.sourceUrl,
      assetId: claim.assetId,
      assetTitle: asset.title,
    });
    out.set(claim.assetId, list);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Storing it
// ---------------------------------------------------------------------------

export async function saveDrafts(
  projectId: string,
  run: GenerateRun,
  createdBy: string,
): Promise<{ written: number }> {
  const drafts = project(projectId).collection('drafts');

  let batch = db().batch();
  let pending = 0;
  let written = 0;

  for (const draft of run.drafts) {
    const ref = drafts.doc();
    batch.set(ref, {
      ...draft,
      draftId: ref.id,
      createdBy,
      createdAt: FieldValue.serverTimestamp(),
    });

    written++;
    if (++pending === 200) {
      await batch.commit();
      batch = db().batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();
  return { written };
}

export interface StoredCoversDraft extends Omit<CoversDraft, 'createdAt' | 'decidedAt'> {
  createdAtMs: number | null;
  decidedAtMs: number | null;
}

export async function listCoversDrafts(
  projectId: string,
  opts: { runId?: string; section?: string; status?: string; limit?: number } = {},
): Promise<StoredCoversDraft[]> {
  let query = project(projectId).collection('drafts').where('platform', '==', 'covers');
  if (opts.runId) query = query.where('runId', '==', opts.runId);
  if (opts.status) query = query.where('status', '==', opts.status);

  const snap = await query.limit(Math.max(1, Math.min(500, opts.limit ?? 100))).get();

  return snap.docs
    .map((d) => {
      const data = d.data();
      const created = data.createdAt as Timestamp | null | undefined;
      const decided = data.decidedAt as Timestamp | null | undefined;
      return {
        ...(data as CoversDraft),
        draftId: d.id,
        createdAtMs: created ? created.toMillis() : null,
        decidedAtMs: decided ? decided.toMillis() : null,
      } as StoredCoversDraft;
    })
    .filter((d) => (opts.section ? d.context?.section === opts.section : true))
    .sort((a, b) => (b.context?.opportunityScore ?? 0) - (a.context?.opportunityScore ?? 0));
}

/**
 * Record a person's decision.
 *
 * ⚠️ APPROVING QUEUES NOTHING. There is no job, no agent and no posting code in
 * this phase — approving records that a human read the draft and agreed with it,
 * and the text is theirs to copy. The reason on a rejection is the calibration
 * set the floors get fitted against in phase 5, which is why it is captured on
 * both paths rather than only on the interesting one.
 */
export async function decideDraft(
  projectId: string,
  draftId: string,
  decision: { status: 'approved' | 'rejected'; reason: string },
  by: { uid: string; name: string },
): Promise<void> {
  await project(projectId)
    .collection('drafts')
    .doc(draftId)
    .set(
      {
        status: decision.status,
        decisionReason: decision.reason.trim().slice(0, 1000),
        decidedBy: by.uid,
        decidedByName: by.name,
        decidedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}
