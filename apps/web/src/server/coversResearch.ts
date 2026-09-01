import 'server-only';

// The research interchange: a brief out, structured findings back.
//
// Everything that decides anything is pure and lives in
// modules/covers/research.ts. This reads what the brief needs, and writes what
// the import produces.
//
// ════════════════════════════════════════════════════════════════════════════
// AN IMPORT PRODUCES CANDIDATES, NOT KNOWLEDGE
//
// Every capability lands as a DRAFT asset that retrieval will not see —
// `listAssets` is filtered to `active` by every consumer — and its facts land as
// PROPOSALS on that draft rather than as documents in the claim ledger.
//
// The reason is the one rule this whole design is built on: a reply may state a
// fact only by citing a claim whose quote a human checked against text the
// server read or a named person pasted. A search-enabled model's confident
// sentence satisfies none of that, however true it happens to be. So the import
// cannot create a claim, and there is no code path from here that does.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { getConversationMap } from './coversMap';
import { getCoversPolicy, getStoredGapBoard } from './coversTriage';
import { brandLabelOf } from '@/modules/covers/onboarding';
import {
  buildResearchBrief,
  parseResearchImport,
  toCandidateAsset,
  RESEARCH_SCHEMA_VERSION,
  type CandidateAsset,
  type ImportResult,
} from '@/modules/covers/research';

const project = (projectId: string) => adminDb().collection('projects').doc(projectId);

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export interface BriefResult {
  brief: string;
  clientName: string;
  clientDomain: string;
  projectName: string;
  identityGuessed: boolean;
  needs: number;
  /** True when the map is empty — the screen says "build the map first" rather
   *  than handing somebody a brief with no questions in it. */
  needsMap: boolean;
}

/**
 * The brief, built from the audience map and the client's own record.
 *
 * ⚠️ THE CLIENT IS READ FROM THE PROJECT, NOT PASSED IN. Nothing in this file,
 * or in the brief it produces, knows which client it is describing — swapping
 * the client is editing the project, and the brief reshapes itself around
 * whatever the map found.
 */
export async function getResearchBrief(projectId: string): Promise<BriefResult> {
  const [snap, map, policy] = await Promise.all([
    project(projectId).get(),
    getConversationMap(projectId),
    getCoversPolicy(projectId),
  ]);
  const p = snap.data() ?? {};

  const projectName = String(p.name ?? '');
  const clientDomain = policy.clientDomain || String(p.clientWebsiteUrl ?? '');

  // ⚠️ THE PROJECT NAME IS THE LAST RESORT, NOT THE FIRST. It is a workspace
  // label — "test project", "testing stake" — and the brief led with it, which
  // told an outside researcher nothing about who they were researching. Order:
  // what a person typed, then the website's own registrable label, then the
  // project name because something has to be said.
  const derived = brandLabelOf(clientDomain);
  const clientName =
    policy.clientName ||
    (derived ? derived.charAt(0).toUpperCase() + derived.slice(1) : '') ||
    projectName;

  return {
    brief: buildResearchBrief({
      clientName,
      clientDomain,
      needs: map.needs,
      postsAnalysed: map.postsMappable,
      sections: map.sections,
    }),
    clientName,
    clientDomain,
    projectName,
    /** True when nothing better than the workspace label was available. The
     *  screen asks for a real one rather than letting the brief go out saying
     *  "Client: test project". */
    identityGuessed: !policy.clientName && !derived,
    needs: map.needs.length,
    needsMap: map.needs.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

/** A candidate as stored. The asset shape, plus what research added. */
export interface StoredCandidate extends CandidateAsset {
  assetId: string;
  status: 'draft' | 'active' | 'retired';
  createdAtMs: number | null;
}

export interface ImportSummary {
  imported: number;
  rejected: ImportResult['rejected'];
  /** The paste had to be repaired to be read at all. */
  repaired: boolean;
  /** Need ids the research named that the map does not have. */
  unknownNeeds: string[];
  /** Needs with at least one candidate against them, and the total. Computed
   *  from what was stored rather than from what the researcher claimed. */
  needsCovered: number;
  needsTotal: number;
}

/**
 * Store researched capabilities as draft assets.
 *
 * ⚠️ `textSource` IS DERIVED FROM THE EVIDENCE, NOT FROM THE CLAIM OF EVIDENCE.
 * A row saying `"verificationState": "verified"` with no source URL was already
 * downgraded by the parser; here, even a sourced row lands `unverified`, because
 * nobody in this process has READ that page. Verification is a separate act — a
 * person opens the source, pastes the text, and the existing paste route records
 * who vouched for it. Importing a URL is not reading it.
 */
export async function importResearch(
  projectId: string,
  raw: unknown,
  actor: { uid: string; name: string },
): Promise<ImportSummary> {
  const map = await getConversationMap(projectId);
  const needIds = map.needs.map((n) => n.needId);

  const parsed = parseResearchImport(raw, needIds);
  const candidates = parsed.capabilities.map(toCandidateAsset);

  const assets = project(projectId).collection('assets');
  let batch = adminDb().batch();
  let pending = 0;
  let imported = 0;

  for (const c of candidates) {
    const ref = assets.doc();
    batch.set(ref, {
      assetId: ref.id,
      projectId,
      title: c.title,
      kind: c.kind,
      purpose: c.purpose,
      problems: c.problems,
      // The retrieval key. Short forum phrases, not sentences — the phase-1
      // importer stored whole questions here and made 64 assets unreachable.
      triggers: c.triggers,
      exclusions: c.exclusions,
      sourceUrl: c.sourceUrl,

      // ⚠️ DRAFT, ALWAYS. Only `active` assets are retrieved, so nothing
      // imported can reach a reply until a person approves it.
      status: 'draft',
      proposedBy: 'model',
      model: 'external-research',
      promptVersion: RESEARCH_SCHEMA_VERSION,
      confirmedBy: null,
      confirmedByName: null,
      confirmedAt: null,

      // ⚠️ UNVERIFIED. Nobody in this process read the source page.
      textSource: 'unverified',
      attestedBy: null,
      attestedByName: null,
      attestedAt: null,
      fetchFailure: null,

      sourceHash: '',
      lastCrawledAt: null,
      sourceChangedAt: null,

      // --- what research added, beyond the asset shape -------------------
      coversNeeds: c.coversNeeds,
      confidence: c.confidence,
      researchNotes: c.notes,
      researchSources: c.facts.map((f) => f.sourceUrl).filter((u, i, all) => all.indexOf(u) === i),
      /**
       * Claim PROPOSALS. Deliberately on the asset rather than in `claims`:
       * a document in the ledger is assertable by definition, and these are not.
       * A person promotes one by verifying its quote against text somebody read.
       */
      proposedFacts: c.facts,

      createdBy: actor.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    imported++;
    if (++pending === 300) {
      await batch.commit();
      batch = adminDb().batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();

  const covered = new Set(candidates.flatMap((c) => c.coversNeeds));

  return {
    imported,
    rejected: parsed.rejected,
    repaired: parsed.repaired,
    unknownNeeds: parsed.unknownNeeds,
    needsCovered: needIds.filter((id) => covered.has(id)).length,
    needsTotal: needIds.length,
  };
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

export interface CandidateView {
  candidates: StoredCandidate[];
  needsCovered: string[];
  needsTotal: number;
  gapBoard: Awaited<ReturnType<typeof getStoredGapBoard>>;
}

/**
 * The review queue: everything research proposed, approved or not.
 *
 * Drafts first, because those are the ones needing a decision — an approved
 * asset is already doing its job and a screen that buries the pending work under
 * it is a screen nobody finishes.
 */
export async function listCandidates(projectId: string): Promise<CandidateView> {
  const [snap, map, gapBoard] = await Promise.all([
    project(projectId).collection('assets').limit(500).get(),
    getConversationMap(projectId),
    // The gap board belongs beside the client's knowledge, not in the reply
    // queue: "somebody asked and we have nothing" is a decision about what to
    // write next, and the queue is about what to post now.
    getStoredGapBoard(projectId),
  ]);

  const candidates = snap.docs
    .map((d) => {
      const data = d.data();
      const created = data.createdAt as { toMillis?: () => number } | undefined;
      return {
        assetId: d.id,
        title: String(data.title ?? ''),
        kind: data.kind,
        purpose: String(data.purpose ?? ''),
        problems: data.problems ?? [],
        triggers: data.triggers ?? [],
        exclusions: data.exclusions ?? [],
        sourceUrl: String(data.sourceUrl ?? ''),
        status: data.status ?? 'draft',
        coversNeeds: data.coversNeeds ?? [],
        confidence: data.confidence ?? 'low',
        notes: String(data.researchNotes ?? ''),
        facts: data.proposedFacts ?? [],
        verificationState: data.textSource === 'unverified' ? 'unverified' : 'verified',
        createdAtMs: created?.toMillis ? created.toMillis() : null,
      } as StoredCandidate;
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'draft' ? -1 : 1;
      return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0);
    });

  const covered = new Set(candidates.flatMap((c) => c.coversNeeds));

  return {
    candidates,
    needsCovered: map.needs.map((n) => n.needId).filter((id) => covered.has(id)),
    needsTotal: map.needs.length,
    gapBoard,
  };
}

/**
 * Approve, edit or reject one candidate.
 *
 * ⚠️ APPROVING ACTIVATES THE ASSET AND CREATES NO CLAIMS. An active asset is
 * retrievable and can shape a reply; stating one of its facts still requires a
 * claim, and a claim still requires a verified quote. Approving research is
 * saying "this is a real capability worth matching on", not "these facts may be
 * asserted in public".
 */
export async function decideCandidate(
  projectId: string,
  assetId: string,
  decision: { status: 'active' | 'retired'; edits?: Partial<CandidateAsset> },
  actor: { uid: string; name: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: decision.status,
    confirmedBy: actor.uid,
    confirmedByName: actor.name,
    confirmedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const e = decision.edits ?? {};
  if (typeof e.title === 'string') patch.title = e.title.trim().slice(0, 120);
  if (typeof e.purpose === 'string') patch.purpose = e.purpose.trim().slice(0, 800);
  for (const field of ['problems', 'triggers', 'exclusions'] as const) {
    if (Array.isArray(e[field])) {
      patch[field] = (e[field] as string[])
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim().slice(0, 200))
        .slice(0, 20);
    }
  }

  await project(projectId).collection('assets').doc(assetId).set(patch, { merge: true });
}
