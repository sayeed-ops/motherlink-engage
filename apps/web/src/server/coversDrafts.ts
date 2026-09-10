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

import { FieldValue, Timestamp, type Query } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { loadLibrary } from './knowledge';
import { getCoversConfig, getCoversItem, listCoversItems, listCoversPosts, type StoredCoversPost } from './covers';
import { getCoversPolicy, getTriage, listTriage, type CoversPolicyDoc, type StoredTriage } from './coversTriage';
import { coversDraftsQuery, type DraftQueryOptions } from '@/modules/covers/queries';
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
import { selectedVariant } from '@/modules/covers/draft';
import {
  actionFor,
  buildFeedback,
  calibrationReport,
  type CalibrationReport,
  type CoversFeedback,
  type CoversReasonTag,
} from '@/modules/covers/feedback';
import { newOutcome, summariseCampaign, type CampaignSummary, type CoversOutcome } from '@/modules/covers/outcome';
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
  /** ONE opportunity, chosen by a person looking at it.
   *
   *  When set, `runId` and `section` are ignored and exactly this analysis is
   *  written for — the row the operator pressed Draft on, not "whatever the
   *  last run qualified". A batch and a single pick are the same generation
   *  path with a different starting set, so nothing below branches on it.
   *
   *  Still subject to the `opportunity` rule: a person may only draft what the
   *  funnel qualified, and asking for anything else is an error rather than a
   *  quiet no-op (see NotAnOpportunityError). */
  analysisId?: string;
  /** Ceiling on OPPORTUNITIES processed, not on model calls — each opportunity
   *  costs between two and four calls and the count is reported. */
  maxOpportunities: number;
  nowMs: number;
}

/** Thrown when `analysisId` names something the funnel did not qualify. It is a
 *  400, not a 500: the id is real, the request is simply asking for a reply to a
 *  post that was screened, routed out as a complaint, or recorded as a gap. */
export class NotAnOpportunityError extends Error {
  readonly outcome: string;
  constructor(outcome: string, message: string) {
    super(message);
    this.name = 'NotAnOpportunityError';
    this.outcome = outcome;
  }
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
  // One analysis, or a run's worth. The single-pick path reads ONE document
  // instead of listing up to 500 — the whole point of a row-level button is that
  // pressing it should not cost a run-sized read.
  const [config, policy, library, triaged] = await Promise.all([
    getCoversConfig(projectId),
    getCoversPolicy(projectId),
    loadLibrary(projectId),
    opts.analysisId
      ? getTriage(projectId, opts.analysisId).then((t) => (t ? [t] : []))
      : listTriage(projectId, { runId: opts.runId, section: opts.section, limit: 500 }),
  ]);

  if (opts.analysisId) {
    const found = triaged[0];
    if (!found) throw new NotAnOpportunityError('missing', 'That analysis no longer exists.');
    if (found.outcome !== 'opportunity') {
      throw new NotAnOpportunityError(
        found.outcome,
        `That post was recorded as "${found.outcome}", so there is nothing to draft for it.`,
      );
    }
  }

  const activeAssets = library.assets.filter((a) => a.status === 'active');
  const assetById = new Map(activeAssets.map((a) => [a.assetId, a]));
  const claimsByAsset = groupClaims(activeAssets, library.claims, opts.nowMs);

  // Redundant now that `listTriage` applies both in the query — and kept
  // deliberately, because the `analysisId` path above arrives via `getTriage`,
  // a direct document read that no predicate has touched. It runs over an array
  // already in memory and reads nothing.
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
  //
  // The single-pick path fetches ONLY the thread it needs. Listing by section
  // would be both wasteful and wrong here: the list is capped at 500 and the
  // caller may not have sent a section, so the one thread being drafted for
  // could fall outside the page and the draft would silently not happen.
  const postsByItem = new Map<string, StoredCoversPost[]>();
  const items = opts.analysisId
    ? await getCoversItem(projectId, opportunities[0]!.itemId).then((i) => (i ? [i] : []))
    : await listCoversItems(projectId, { section: opts.section, limit: 500 });
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
  opts: DraftQueryOptions = {},
): Promise<StoredCoversDraft[]> {
  // Every predicate and the ordering are in the QUERY — see modules/covers/
  // queries.ts for why `section` in particular had to stop being an array
  // filter, and firestore.indexes.json for the indexes each shape needs.
  const base: Query = project(projectId).collection('drafts');
  const snap = await coversDraftsQuery(base, opts).get();

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
    });
}

/**
 * Record a person's decision — and the feedback record that goes with it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * APPROVING QUEUES NOTHING, AND STILL WRITES A ROW
 *
 * There is no job, no agent and no posting code in this phase. Approving records
 * that a human read the draft and agreed with it; the text is theirs to copy.
 *
 * What changed in phase 5 is that EVERY decision now writes a `draftFeedback`
 * row, not only the interesting ones. A calibration set containing only edits
 * and rejections can measure how the system fails and cannot measure whether it
 * works — "does a high score predict an approval" needs the approvals in it.
 * See modules/covers/feedback.ts.
 *
 * The action is derived from what the person DID rather than from what they
 * clicked: an "approve" that changed the text is recorded as an edit, and both
 * versions are kept.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function decideDraft(
  projectId: string,
  draftId: string,
  decision: {
    status: 'approved' | 'rejected';
    reason: string;
    /** The text the person would actually post. Empty means "as written". */
    editedText?: string;
    tags?: string[];
  },
  by: { uid: string; name: string },
): Promise<{ action: string }> {
  const ref = project(projectId).collection('drafts').doc(draftId);
  const snap = await ref.get();
  const draft = snap.data() as CoversDraft | undefined;
  if (!draft) throw new Error('No such draft.');

  const variant = selectedVariant(draft);
  const declined = draft.selected === 'NONE';

  const action = actionFor({
    approved: decision.status === 'approved',
    declined,
    before: variant?.text ?? '',
    after: decision.editedText ?? '',
    // On a declined draft, "approved" is the person saying something should
    // have gone out — the most valuable row in the set, and one a queue that
    // hid its declines would never collect.
    overruled: decision.status === 'approved',
  });

  const edited = (decision.editedText ?? '').trim();

  await ref.set(
    {
      status: decision.status,
      decisionReason: decision.reason.trim().slice(0, 1000),
      // The draft's own text is NEVER overwritten. The model's output stays as
      // written so the pair (before, after) remains trainable — the same rule
      // `aiOriginalBody` follows on the Reddit side.
      editedText: edited || null,
      decidedBy: by.uid,
      decidedByName: by.name,
      decidedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const feedback = project(projectId).collection('draftFeedback').doc();
  await feedback.set({
    ...buildFeedback({
      draftId,
      analysisId: draft.analysisId ?? null,
      section: draft.context?.section ?? '',
      action,
      variant,
      selected: draft.selected,
      opportunityScore: draft.context?.opportunityScore ?? 0,
      assetIds: (draft.context?.matchedAssets ?? []).map((a) => a.assetId),
      after: edited,
      tags: (decision.tags ?? []) as CoversReasonTag[],
      reason: decision.reason,
      by,
    }),
    feedbackId: feedback.id,
    projectId,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { action };
}

export async function listFeedback(
  projectId: string,
  limit = 500,
): Promise<CoversFeedback[]> {
  const snap = await project(projectId)
    .collection('draftFeedback')
    .where('platform', '==', 'covers')
    .limit(Math.max(1, Math.min(1000, limit)))
    .get();

  return snap.docs.map((d) => ({ ...(d.data() as CoversFeedback), feedbackId: d.id }));
}

/** What the decisions say about the numbers. Reports; fits nothing. */
export async function getCalibration(projectId: string): Promise<CalibrationReport> {
  return calibrationReport(await listFeedback(projectId));
}

// ---------------------------------------------------------------------------
// Outcomes — what happened after a person posted it by hand
// ---------------------------------------------------------------------------

/**
 * Record that a reply went out.
 *
 * ⚠️ `postedText` IS WHAT THE PERSON ACTUALLY POSTED, not the draft's text. They
 * may have changed a word in their browser after approving, and a measurement
 * attached to text that never appeared on the forum measures nothing. It
 * defaults to the edited text, then the draft's — but the caller may override,
 * and the review screen asks.
 */
export async function recordPosted(
  projectId: string,
  input: { draftId: string; permalink?: string; postedText?: string; postedAtMs?: number },
  by: { uid: string; name: string },
): Promise<{ outcomeId: string }> {
  const draftRef = project(projectId).collection('drafts').doc(input.draftId);
  const snap = await draftRef.get();
  const draft = snap.data() as (CoversDraft & { editedText?: string | null }) | undefined;
  if (!draft) throw new Error('No such draft.');
  if (draft.selected === 'NONE') throw new Error('This draft has no selected variant.');

  const variant = selectedVariant(draft);
  if (!variant) throw new Error('The selected variant is missing from the draft.');

  const ref = project(projectId).collection('outcomes').doc();
  await ref.set({
    ...newOutcome({
      draftId: input.draftId,
      itemId: draft.context?.itemId ?? '',
      section: draft.context?.section ?? '',
      variant: variant.kind,
      postedText: (input.postedText ?? draft.editedText ?? variant.text ?? '').trim(),
      permalink: input.permalink?.trim() || null,
      postedAtMs: input.postedAtMs ?? Date.now(),
    }),
    outcomeId: ref.id,
    projectId,
    createdBy: by.uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  await draftRef.set({ postedByHandAt: FieldValue.serverTimestamp() }, { merge: true });

  return { outcomeId: ref.id };
}

/**
 * Record what somebody found when they went and looked.
 *
 * Only the fields supplied are written. An omitted field stays null — "not
 * checked" — rather than being reset to a zero that would read as a measurement.
 */
export async function measureOutcome(
  projectId: string,
  outcomeId: string,
  measured: {
    replies?: number | null;
    quoted?: boolean | null;
    threadPostsAfter?: number | null;
    moderation?: CoversOutcome['moderation'];
    consequence?: CoversOutcome['consequence'];
    externalPostId?: string | null;
    notes?: string;
  },
  by: { uid: string; name: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    measuredAtMs: Date.now(),
    measuredBy: by.uid,
  };

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined);

  if (num(measured.replies) !== undefined) patch.replies = num(measured.replies);
  if (num(measured.threadPostsAfter) !== undefined) patch.threadPostsAfter = num(measured.threadPostsAfter);
  if (typeof measured.quoted === 'boolean') patch.quoted = measured.quoted;
  if (measured.moderation) patch.moderation = measured.moderation;
  if (measured.consequence) patch.consequence = measured.consequence;
  if (typeof measured.externalPostId === 'string') patch.externalPostId = measured.externalPostId.trim() || null;
  if (typeof measured.notes === 'string') patch.notes = measured.notes.trim().slice(0, 2000);

  await project(projectId).collection('outcomes').doc(outcomeId).set(patch, { merge: true });
}

export async function listOutcomes(projectId: string, limit = 200): Promise<CoversOutcome[]> {
  const snap = await project(projectId)
    .collection('outcomes')
    .where('platform', '==', 'covers')
    .limit(Math.max(1, Math.min(500, limit)))
    .get();

  return snap.docs
    .map((d) => ({ ...(d.data() as CoversOutcome), outcomeId: d.id }))
    .sort((a, b) => b.postedAtMs - a.postedAtMs);
}

export async function getCampaign(projectId: string): Promise<CampaignSummary> {
  return summariseCampaign(await listOutcomes(projectId));
}
/**
 * IS THERE ANYTHING IN THE PERFORMANCE PANELS — for two reads instead of seven
 * hundred.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY A COUNT AND NOT THE DOCUMENTS
 *
 * The campaign and calibration panels render only when they have something to
 * say (`posted > 0`, `decisions > 0`), and the review screen used to establish
 * that by READING every outcome and every feedback row — about 700 documents —
 * on every load and every filter click. On a fresh project both numbers are
 * zero, so the whole 700 was spent to render nothing at all.
 *
 * `count()` is an aggregation query: Firestore bills one read per 1,000 index
 * entries it scans, so this is 2 reads where the collections are small and stays
 * 2 reads until they run to thousands. It answers the only question the screen
 * needs answered before a person asks for the detail — is there any — and the
 * documents themselves are fetched when they press the disclosure.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function getPerformanceCounts(
  projectId: string,
): Promise<{ outcomes: number; decisions: number }> {
  const countOf = async (name: string): Promise<number> =>
    (await project(projectId).collection(name).where('platform', '==', 'covers').count().get()).data()
      .count;

  const [outcomes, decisions] = await Promise.all([countOf('outcomes'), countOf('draftFeedback')]);
  return { outcomes, decisions };
}

