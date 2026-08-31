// The record of one attempt to reply — including the attempts that decided not
// to.
//
// PURE. No Firestore, no clock, no 'server-only'. The shape lives here rather
// than in server/ because three places must agree on it: the pipeline that
// writes it, the review screen that renders it, and whatever phase 5 does with
// an approved one.
//
// ════════════════════════════════════════════════════════════════════════════
// A DRAFT IS AN ATTEMPT, NOT A REPLY
//
// Most attempts produce nothing. NONE is the normal outcome by design — see
// selectVariant.ts — and a system that always finds something to post is a
// system posting filler. So a record is written whatever happened, carrying the
// stage it stopped at and every reason, and the review screen shows the declines
// alongside the successes. A queue listing only the successes reads as an empty
// broken feature after twenty runs of the feature working correctly.
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ THERE IS NO `queued`, NO `posted`, AND NO `jobId` ON THIS RECORD
//
// Not "there is one and it is unused". The status vocabulary below is the whole
// vocabulary, and it stops at `approved`. COVERS-PLAN.md § The staged build:
// phases 0–5 cannot post — not "are configured not to", THERE IS NO CODE THAT
// CAN — and a draft type carrying a posted state would be the first half of
// that code, sitting in the tree waiting for somebody to write the second half.
//
// An approved Covers draft in phase 4 means exactly one thing: a person read it,
// agreed with it, and will copy it into their own browser if they want it
// posted. Phase 6 is where a job kind gets added, and it will be added
// deliberately, next to this comment.
// ════════════════════════════════════════════════════════════════════════════

import type { ComplianceFailure, ClaimEvidence, DisclosureFlag } from './compliance';
import type { Recommendation, VariantScores } from './score';
import type { DroppedVariant, SelectionOutcome } from './selectVariant';
import type { VariantKind } from './variants';
import type { PostIntent } from './intent';

/**
 * `pending` — written, waiting for a person.
 * `approved` — a person read it and agreed. They post it by hand, or not.
 * `rejected` — a person said no. Terminal, and the reason is the calibration set.
 * `none` — the pipeline itself declined. Terminal, and the common case.
 *
 * There is no state after `approved`, because there is no mechanism after it.
 */
export type CoversDraftStatus = 'pending' | 'approved' | 'rejected' | 'none';

export const COVERS_DRAFT_STATUSES: readonly CoversDraftStatus[] = [
  'pending',
  'approved',
  'rejected',
  'none',
] as const;

export const COVERS_DRAFT_STATUS_LABEL: Record<CoversDraftStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved — post by hand',
  rejected: 'Rejected',
  none: 'Declined — nothing to post',
};

/** One written variant, with everything that was decided about it. */
export interface WrittenVariant {
  kind: VariantKind;
  text: string;
  words: number;
  /** What the generator said it relied on. A declaration — `evidence` below is
   *  the checked version. */
  claimIds: string[];

  /** Null when the evaluator's answer could not be read for this variant. */
  scores: VariantScores | null;
  recommendation: Recommendation | null;
  /** The evaluator's sentence. */
  why: string;

  compliancePassed: boolean;
  complianceFailures: ComplianceFailure[];
  /**
   * The claim behind every fact the reply states, with the page it came from.
   *
   * ⚠️ THIS IS WHAT THE REVIEW SCREEN SHOWS BESIDE THE TEXT. Approving a
   * factual assertion on the system's word is exactly the act this design exists
   * to prevent, so the evidence travels with the draft rather than being
   * re-derivable from it. Denormalised for the same reason the thread is: by
   * review time the claim may have been re-verified or retired, and what matters
   * is what was true when the reply was written.
   */
  evidence: ClaimEvidence[];
  /** Every sentence that states a fact, and what backed it. `null` backing on a
   *  passing variant is impossible; on a failing one it is the reason. */
  assertions: { sentence: string; backedBy: string | null }[];
  disclosure: DisclosureFlag;
}

/** Enough of the thread to review without paying for another read. */
export interface DraftContext {
  itemId: string;
  postId: string;
  section: string;
  sectionName: string;
  threadTitle: string;
  threadUrl: string;
  postAuthor: string;
  postBody: string;
  postCreatedAtMs: number | null;
  /** The intent classifier's reading, carried through from triage. */
  intent: PostIntent | null;
  problem: string;
  /** Assets retrieval matched, and the phrase that fired. Shown so a reviewer
   *  can fix the library rather than only disagree with the draft. */
  matchedAssets: { assetId: string; title: string; triggers: string[] }[];
  /** The opportunity score from phase 3. Ordering only, uncalibrated. */
  opportunityScore: number;
}

/** `projects/{projectId}/drafts/{draftId}` with `platform: 'covers'`. */
export interface CoversDraft {
  draftId: string;
  projectId: string;
  platform: 'covers';
  /** The generation run this came from. */
  runId: string;
  /** The triage record this was generated from, so a draft can be traced back
   *  to the intent call that qualified it. */
  analysisId: string | null;

  context: DraftContext;

  /** Every variant that was written, in the order they were generated. */
  variants: WrittenVariant[];
  /** Every variant that was not, with the stage and the reasons. */
  dropped: DroppedVariant[];

  selected: SelectionOutcome;
  selectionReason: string;
  /** False when arithmetic settled it. Reported because the bill is a client's. */
  criticCalled: boolean;

  status: CoversDraftStatus;
  /** Set when a person decides. The reason on a rejection is the calibration
   *  set phase 5 fits the floors against. */
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string;

  model: string;
  promptVersions: { variants: string; score: string; critic: string };
  createdBy: string;
  createdAt: Date;
}

/** The variant that was chosen, or null. Resolved from OUR array by kind — never
 *  from anything a model returned, so a critic that echoes back an edited text
 *  cannot bypass the gates that ran on the original. */
export function selectedVariant(draft: {
  variants: readonly WrittenVariant[];
  selected: SelectionOutcome;
}): WrittenVariant | null {
  if (draft.selected === 'NONE') return null;
  return draft.variants.find((v) => v.kind === draft.selected) ?? null;
}

/** The text a person copies. Empty when the pipeline declined — and an empty
 *  string is the honest answer there, not an error. */
export function copyableText(draft: {
  variants: readonly WrittenVariant[];
  selected: SelectionOutcome;
}): string {
  return selectedVariant(draft)?.text ?? '';
}

/** One line per outcome, for the screen and the log. */
export function draftSummary(
  drafts: readonly { selected: SelectionOutcome }[],
): Record<string, number> {
  const counts: Record<string, number> = { NONE: 0 };
  for (const d of drafts) {
    counts[d.selected] = (counts[d.selected] ?? 0) + 1;
  }
  return counts;
}
