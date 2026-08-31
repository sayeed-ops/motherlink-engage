import 'server-only';

// Running triage over harvested posts, and storing what it decided.
//
// Everything that DECIDES anything is pure and lives in modules/covers —
// screen, policy, intent, triage. This file loads what those need, makes the one
// model call per surviving post, and writes the results. Same split as
// server/knowledge.ts and server/commentKarma.ts.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { loadLibrary } from './knowledge';
import { getCoversConfig, getSectionPace, listCoversItems, listCoversPosts } from './covers';
import { claimStatus } from '@/modules/knowledge/freshness';
import type { Asset } from '@/modules/knowledge/types';
import {
  buildIntentPrompt,
  parseIntent,
  INTENT_SYSTEM,
  INTENT_PROMPT_VERSION,
  type IntentReading,
} from '@/modules/covers/intent';
import {
  triagePost,
  buildGaps,
  triageSummary,
  type Gap,
  type Triage,
  type TriageInput,
} from '@/modules/covers/triage';
import { sectionPace, EMPTY_FOOTPRINT, type Footprint } from '@/modules/covers/screen';
import type { JurisdictionPolicy } from '@/modules/covers/policy';
import { EMPTY_JURISDICTION } from '@/modules/covers/policy';

const db = () => adminDb();
const project = (projectId: string) => db().collection('projects').doc(projectId);

/** The same shape server/interview.ts injects. One definition would be better;
 *  they are deliberately not shared yet because the two runners have different
 *  retry and budget needs and coupling them now would be premature. */
export interface AskModel {
  (input: { system: string; user: string; temperature: number; maxTokens: number; json: boolean }): Promise<{
    content: string;
    model: string;
  }>;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * `projects/{id}/policy/covers` — jurisdictions and the variant switches.
 *
 * Its own document rather than a corner of the module config, because
 * `policy.manage` is a separate permission in the plan: the list of places a
 * client may not take customers comes from a licence, and changing it is not the
 * same kind of act as changing how many threads a scan reads.
 */
export interface CoversPolicyDoc {
  jurisdiction: JurisdictionPolicy;
  variants: { brandMentioned: boolean; brandInformed: boolean; communityOnly: boolean };
}

export const DEFAULT_POLICY: CoversPolicyDoc = {
  jurisdiction: EMPTY_JURISDICTION,
  // ⚠️ BRAND-MENTIONED IS OFF UNTIL SOMEBODY TURNS IT ON. The section roles
  // already forbid it nearly everywhere; this is the second switch, so that
  // naming a client in public is a thing a person did rather than a default
  // nobody revisited.
  variants: { brandMentioned: false, brandInformed: true, communityOnly: true },
};

export async function getCoversPolicy(projectId: string): Promise<CoversPolicyDoc> {
  const snap = await project(projectId).collection('policy').doc('covers').get();
  if (!snap.exists) return DEFAULT_POLICY;

  const data = snap.data() ?? {};
  const j = (data.jurisdiction ?? {}) as Partial<JurisdictionPolicy>;
  const v = (data.variants ?? {}) as Partial<CoversPolicyDoc['variants']>;

  return {
    jurisdiction: {
      prohibited: strings(j.prohibited),
      licensed: strings(j.licensed),
    },
    variants: {
      brandMentioned: v.brandMentioned === true,
      brandInformed: v.brandInformed !== false,
      communityOnly: v.communityOnly !== false,
    },
  };
}

export async function saveCoversPolicy(
  projectId: string,
  raw: unknown,
  uid: string,
): Promise<CoversPolicyDoc> {
  const input = (raw ?? {}) as Partial<CoversPolicyDoc>;
  const policy: CoversPolicyDoc = {
    jurisdiction: {
      prohibited: strings(input.jurisdiction?.prohibited),
      licensed: strings(input.jurisdiction?.licensed),
    },
    variants: {
      brandMentioned: input.variants?.brandMentioned === true,
      brandInformed: input.variants?.brandInformed !== false,
      communityOnly: input.variants?.communityOnly !== false,
    },
  };

  await project(projectId)
    .collection('policy')
    .doc('covers')
    .set({ ...policy, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });

  return policy;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()).slice(0, 200)
    : [];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface TriageRunOptions {
  section: string;
  /** Ceiling on the PAID calls, not on posts examined. The free tier runs over
   *  everything; this caps what reaches the model. */
  maxIntentCalls: number;
  nowMs: number;
}

export interface TriageRun {
  section: string;
  posts: number;
  triaged: Triage[];
  gaps: Gap[];
  counts: ReturnType<typeof triageSummary>;
  intentCalls: number;
  /** Posts the budget stopped us reaching. Reported, because a queue that is
   *  short because we ran out of money looks exactly like a quiet forum. */
  budgetSkipped: number;
  model: string;
}

/**
 * Triage every harvested post in one section.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE BUDGET CAPS THE PAID CALLS, NOT THE POSTS
 *
 * Every post goes through the free tier, always — it costs nothing and it is
 * what produces the honest count of why things were rejected. Only the survivors
 * consume budget, and when the budget runs out the remainder are recorded as
 * `budgetSkipped` rather than as findings.
 *
 * That distinction is load-bearing for the gap board: a concept that never
 * reached the classifier is not evidence that the library lacks it.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function runTriage(
  projectId: string,
  opts: TriageRunOptions,
  ask: AskModel,
): Promise<TriageRun> {
  const [config, policy, library, items, storedPace] = await Promise.all([
    getCoversConfig(projectId),
    getCoversPolicy(projectId),
    loadLibrary(projectId),
    listCoversItems(projectId, { section: opts.section, limit: 500 }),
    getSectionPace(projectId, opts.section),
  ]);

  const activeAssets = library.assets.filter((a) => a.status === 'active');
  const liveClaimsByAsset = countLiveClaims(activeAssets, library.claims, opts.nowMs);

  // The harvest measured this from every row the listing gave. Falling back to
  // the threads we hold is a much worse sample and is only for a project
  // triaged before that was recorded — and if there are too few of those,
  // sectionPace returns null and the age checks simply do not run.
  const paceMs = storedPace ?? sectionPace(items.map((i) => i.lastPostAtMs));

  const section = config.sections.find((s) => s.slug === opts.section);
  const sectionName = section?.name ?? opts.section;

  let intentCalls = 0;
  let budgetSkipped = 0;
  let modelId = '';

  const triaged: Triage[] = [];
  let posts = 0;

  for (const item of items) {
    const stored = await listCoversPosts(projectId, item.itemId);
    posts += stored.length;

    for (const post of stored) {
      const input: TriageInput = {
        post: {
          postId: post.postId,
          threadId: item.externalId,
          number: post.number,
          author: post.author,
          authorId: post.authorId,
          createdAtMs: post.createdAtMs,
          page: post.page,
          body: post.body,
        },
        itemId: item.itemId,
        threadTitle: item.title,
        threadLastPostAtMs: item.lastPostAtMs,
        section: opts.section,
        sectionName,
        sections: config.sections,
        paceMs,
        // Nothing has ever posted to Covers — there is no code that could until
        // phase 6 — so an empty footprint is a measurement here. See screen.ts.
        footprint: EMPTY_FOOTPRINT as Footprint,
        kickoffMs: null,
        jurisdiction: policy.jurisdiction,
        assets: activeAssets,
        liveClaimsByAsset,
        enabledVariants: policy.variants,
        nowMs: opts.nowMs,
      };

      const result = await triagePost(input, async (i) => {
        // Null, not an error: "not attempted" is a different answer from
        // "classified and unreadable", and only one of them is a finding.
        if (intentCalls >= opts.maxIntentCalls) return null;

        intentCalls++;
        const reading = await readIntent(i, ask);
        modelId = reading.model || modelId;
        return reading.intent;
      });

      if (result.outcome === 'budget') budgetSkipped++;
      triaged.push(result);
    }
  }

  return {
    section: opts.section,
    posts,
    triaged,
    gaps: buildGaps(triaged),
    counts: triageSummary(triaged),
    intentCalls,
    budgetSkipped,
    model: modelId,
  };
}

async function readIntent(
  input: TriageInput,
  ask: AskModel,
): Promise<{ intent: IntentReading; model: string }> {
  const { content, model } = await ask({
    system: INTENT_SYSTEM,
    user: buildIntentPrompt({
      sectionName: input.sectionName,
      threadTitle: input.threadTitle,
      postBody: input.post.body,
    }),
    temperature: 0,
    maxTokens: 500,
    json: true,
  });

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Left null: parseIntent returns UNREADABLE, which is undraftable. A model
    // that did not return JSON has not classified anything.
  }

  return { intent: parseIntent(parsed), model };
}

/** Which assets have at least one claim that may still be stated. */
function countLiveClaims(
  assets: readonly Asset[],
  claims: readonly { claimId: string; assetId: string }[],
  nowMs: number,
): Record<string, number> {
  const byAsset: Record<string, number> = {};
  const assetById = new Map(assets.map((a) => [a.assetId, a]));

  for (const claim of claims) {
    const asset = assetById.get(claim.assetId);
    if (!asset) continue;
    // `live` and nothing else. A stale or expired claim is exactly the case the
    // brand-mentioned variant must not be built on.
    if (claimStatus(claim as never, asset, nowMs) === 'live') {
      byAsset[claim.assetId] = (byAsset[claim.assetId] ?? 0) + 1;
    }
  }

  return byAsset;
}

// ---------------------------------------------------------------------------
// Storing it
// ---------------------------------------------------------------------------

/**
 * Write one triage run.
 *
 * Analyses are IMMUTABLE and keyed by post: re-running triage writes a new
 * document rather than editing the old one, so what the funnel said at a given
 * prompt version survives. Same rule createAnalysis follows on the Reddit side.
 */
export async function saveTriageRun(
  projectId: string,
  run: TriageRun,
  createdBy: string,
): Promise<{ written: number; runId: string }> {
  const analyses = project(projectId).collection('analyses');
  const runId = analyses.doc().id;

  let batch = db().batch();
  let pending = 0;
  let written = 0;

  for (const t of run.triaged) {
    const ref = analyses.doc();
    batch.set(ref, {
      analysisId: ref.id,
      projectId,
      platform: 'covers',
      runId,
      itemId: t.itemId,
      postId: t.postId,
      section: t.section,
      outcome: t.outcome,
      screenReasons: t.screenReasons,
      jurisdiction: t.jurisdiction,
      intent: t.intent,
      retrieval: t.retrieval,
      variants: t.variants,
      eligibilityReasons: t.eligibilityReasons,
      score: t.score,
      measured: t.measured,
      promptVersion: INTENT_PROMPT_VERSION,
      model: run.model,
      createdBy,
      createdAt: FieldValue.serverTimestamp(),
    });

    written++;
    if (++pending === 450) {
      await batch.commit();
      batch = db().batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();

  await project(projectId)
    .collection('modules')
    .doc('coversTriage')
    .set(
      {
        lastRunId: runId,
        lastRunAt: FieldValue.serverTimestamp(),
        lastSection: run.section,
        counts: run.counts,
        gaps: run.gaps.slice(0, 25),
        intentCalls: run.intentCalls,
        budgetSkipped: run.budgetSkipped,
      },
      { merge: true },
    );

  return { written, runId };
}

export interface StoredTriage extends Omit<Triage, 'measured'> {
  analysisId: string;
  runId: string;
  createdAtMs: number | null;
}

/** The queue, best first. Opportunities only unless `all` is asked for. */
export async function listTriage(
  projectId: string,
  opts: { runId?: string; section?: string; all?: boolean; limit?: number } = {},
): Promise<StoredTriage[]> {
  let query = project(projectId).collection('analyses').where('platform', '==', 'covers');
  if (opts.runId) query = query.where('runId', '==', opts.runId);
  if (opts.section) query = query.where('section', '==', opts.section);

  const snap = await query.limit(Math.max(1, Math.min(1000, opts.limit ?? 500))).get();

  return snap.docs
    .map((d) => {
      const data = d.data();
      const created = data.createdAt as Timestamp | null | undefined;
      return {
        analysisId: d.id,
        runId: (data.runId as string) ?? '',
        postId: (data.postId as string) ?? '',
        itemId: (data.itemId as string) ?? '',
        section: (data.section as string) ?? '',
        outcome: data.outcome,
        screenReasons: data.screenReasons ?? [],
        jurisdiction: data.jurisdiction ?? { blocked: false, matched: [] },
        intent: data.intent ?? null,
        retrieval: data.retrieval ?? null,
        variants: data.variants ?? { brandMentioned: false, brandInformed: false, communityOnly: false },
        eligibilityReasons: data.eligibilityReasons ?? {},
        score: (data.score as number) ?? 0,
        createdAtMs: created ? created.toMillis() : null,
      } as StoredTriage;
    })
    .filter((t) => (opts.all ? true : t.outcome === 'opportunity'))
    .sort((a, b) => b.score - a.score || (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
}
