// What a person actually did with a draft, and why.
//
// PURE. No Firestore, no clock, no 'server-only'.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS IS THE CALIBRATION SET, AND IT IS THE WHOLE POINT OF PHASE 5
//
// Every number the pipeline produces today is model output. The six dimensions,
// the opportunity score, the floors — none of them has ever been compared
// against a decision a person made, and until they have, "suitability 65" means
// nothing more precise than "the model typed 65". COVERS-PLAN.md § How NONE
// stays real, point 4 says so explicitly, and phase 5 exists to fix it.
//
// A record is written for EVERY decision, including the plain approvals. It is
// tempting to capture only edits and rejections — those carry the interesting
// signal — and it would make the dataset useless for the one question that
// matters: does a high score predict an approval? A set containing only the
// disagreements measures how the system fails and cannot measure whether it
// works.
//
// ⚠️ THE SCORES ARE COPIED ONTO THE RECORD, NOT LOOKED UP LATER. A draft can be
// regenerated, a prompt version can change, floors can move. The question this
// dataset answers is "what did the system say at the moment a person disagreed
// with it", and that is only answerable if the numbers travel with the decision.
// ════════════════════════════════════════════════════════════════════════════

import type { VariantScores } from './score';
import type { SelectionOutcome } from './selectVariant';
import type { VariantKind } from './variants';
import type { WrittenVariant } from './draft';

// ---------------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------------

/**
 * Structured reasons, paired with free text.
 *
 * The first nine are `modules/reddit/types.ts` § DRAFT_REASON_TAGS, deliberately
 * unchanged so a later export can pool both platforms. The rest are the failure
 * modes this module has actually produced — every one of them was observed in a
 * live run or a review, and none is speculative.
 */
export const COVERS_REASON_TAGS = [
  // shared with the Reddit path
  'too_salesy',
  'wrong_tone',
  'factual_fix',
  'formatting',
  'too_long',
  'too_short',
  'more_specific',
  'other',
  // Covers-specific, and each one is a thing that has happened
  /** Named the client where it added nothing. */
  'brand_gratuitous',
  /** Should have named the client and did not. */
  'brand_missing',
  /** A client fact restated as general advice. The laundering case. */
  'laundered_claim',
  /** Stated something with nothing behind it. */
  'unbacked_fact',
  /** The wrong one of the three was chosen. */
  'wrong_variant',
  /** Reads wrong for this section specifically. */
  'section_fit',
  /** The post should never have qualified. A finding about TRIAGE, not writing. */
  'not_an_opportunity',
  /** The system declined and it should not have. */
  'should_have_posted',
] as const;

export type CoversReasonTag = (typeof COVERS_REASON_TAGS)[number];

export const COVERS_REASON_LABEL: Record<CoversReasonTag, string> = {
  too_salesy: 'Too salesy',
  wrong_tone: 'Wrong tone',
  factual_fix: 'Factual fix',
  formatting: 'Formatting',
  too_long: 'Too long',
  too_short: 'Too short',
  more_specific: 'Needed to be more specific',
  other: 'Other',
  brand_gratuitous: 'Named the client for no reason',
  brand_missing: 'Should have named the client',
  laundered_claim: 'Client fact passed off as general advice',
  unbacked_fact: 'Stated something unbacked',
  wrong_variant: 'Wrong variant chosen',
  section_fit: 'Wrong for this section',
  not_an_opportunity: 'Should never have qualified',
  should_have_posted: 'Declined when it should have posted',
};

/** Tags that are findings about TRIAGE rather than about the writing.
 *
 *  Separated because they calibrate different things: `not_an_opportunity` says
 *  the opportunity score was wrong, and no amount of moving the six dimensions
 *  fixes it. Mixing them would fit the writing floors against a fault upstream
 *  of the writing. */
export const TRIAGE_TAGS: readonly CoversReasonTag[] = ['not_an_opportunity'] as const;

export function isTriageTag(tag: CoversReasonTag): boolean {
  return (TRIAGE_TAGS as readonly string[]).includes(tag);
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** What the person did. */
export type ReviewAction =
  /** Approved as written. The baseline, and the one most easily forgotten. */
  | 'approved'
  /** Approved after editing the text. Both versions are kept. */
  | 'edited'
  /** Rejected. */
  | 'rejected'
  /** The pipeline said NONE and the person agreed. */
  | 'agreed-none'
  /** The pipeline said NONE and the person thinks something should have gone
   *  out. The single most valuable row in the set, and the one a queue that
   *  hides declines would never collect. */
  | 'overruled-none';

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  'approved',
  'edited',
  'rejected',
  'agreed-none',
  'overruled-none',
] as const;

export const REVIEW_ACTION_LABEL: Record<ReviewAction, string> = {
  approved: 'Approved as written',
  edited: 'Edited, then approved',
  rejected: 'Rejected',
  'agreed-none': 'Agreed with the decline',
  'overruled-none': 'Should have posted something',
};

/** `projects/{projectId}/draftFeedback/{id}` with `platform: 'covers'`. */
export interface CoversFeedback {
  feedbackId: string;
  projectId: string;
  platform: 'covers';
  draftId: string;
  /** The triage record, so a `not_an_opportunity` finding can be traced to the
   *  intent call that qualified it. */
  analysisId: string | null;
  section: string;

  action: ReviewAction;
  /** The variant this is about. Null when the pipeline chose NONE and the
   *  person is commenting on that rather than on a text. */
  variant: VariantKind | null;
  /** What the pipeline decided, kept beside what the person decided. */
  selected: SelectionOutcome;

  /** The model's text, untouched. Empty for an `agreed-none`. */
  before: string;
  /** What the person would actually post. Equal to `before` for `approved`. */
  after: string;

  tags: CoversReasonTag[];
  reason: string;

  // --- what the system believed at the moment of the decision ---------------
  /** Copied, never looked up later. See the header. */
  scores: VariantScores | null;
  recommendation: string | null;
  opportunityScore: number;
  /** Ids only — the text of an asset can change, and this is a record of a
   *  decision rather than a snapshot of the library. */
  assetIds: string[];
  claimIds: string[];
  /** True when the variant carried a live claim behind every fact it stated. */
  wasBacked: boolean;

  decidedBy: string;
  decidedByName: string;
  createdAt: Date;
}

export interface FeedbackInput {
  draftId: string;
  analysisId: string | null;
  section: string;
  action: ReviewAction;
  variant: WrittenVariant | null;
  selected: SelectionOutcome;
  opportunityScore: number;
  assetIds: string[];
  after: string;
  tags: CoversReasonTag[];
  reason: string;
  by: { uid: string; name: string };
}

/**
 * Assemble one feedback record.
 *
 * ⚠️ `after` DEFAULTS TO `before`, NOT TO EMPTY. An approval is a data point
 * saying "this exact text was good enough", and storing an empty `after` for it
 * would make every approval look like a deletion to anything reading the pair.
 */
export function buildFeedback(input: FeedbackInput): Omit<CoversFeedback, 'feedbackId' | 'projectId' | 'createdAt'> {
  const before = input.variant?.text ?? '';
  const after = input.after.trim() || before;

  return {
    platform: 'covers',
    draftId: input.draftId,
    analysisId: input.analysisId,
    section: input.section,
    action: input.action,
    variant: input.variant?.kind ?? null,
    selected: input.selected,
    before,
    after,
    tags: [...new Set(input.tags)].filter((t) =>
      (COVERS_REASON_TAGS as readonly string[]).includes(t),
    ),
    reason: input.reason.trim().slice(0, 2000),
    scores: input.variant?.scores ?? null,
    recommendation: input.variant?.recommendation ?? null,
    opportunityScore: input.opportunityScore,
    assetIds: input.assetIds,
    claimIds: input.variant?.claimIds ?? [],
    wasBacked: Boolean(
      input.variant &&
        input.variant.assertions.length > 0 &&
        input.variant.assertions.every((a) => a.backedBy !== null),
    ),
    decidedBy: input.by.uid,
    decidedByName: input.by.name,
  };
}

/** Did the text change substantively? Whitespace is not an edit, and recording
 *  it as one would inflate the disagreement rate with formatting noise. */
export function isSubstantiveEdit(before: string, after: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(before) !== norm(after);
}

/** Which action a decision amounts to, from what the person did rather than
 *  from what they clicked. An "approve" that changed the text is an edit. */
export function actionFor(input: {
  approved: boolean;
  declined: boolean;
  before: string;
  after: string;
  overruled?: boolean;
}): ReviewAction {
  if (input.declined) return input.overruled ? 'overruled-none' : 'agreed-none';
  if (!input.approved) return 'rejected';

  // ⚠️ AN EMPTY `after` MEANS "AS WRITTEN", NOT "DELETED EVERYTHING". The review
  // screen sends an empty edit box for a plain approval, and comparing that
  // against the draft's text made every untouched approval an `edited` row with
  // identical before/after — which would have inflated `editRate` with exactly
  // the decisions that prove the system works. buildFeedback already resolves an
  // empty `after` to `before`; this has to agree with it.
  if (!input.after.trim()) return 'approved';

  return isSubstantiveEdit(input.before, input.after) ? 'edited' : 'approved';
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * How many decisions before any floor may be moved.
 *
 * Twenty, matching `forum/reply/learn.ts` — the same guard, for the same reason:
 * below it, one strong opinion on a Tuesday becomes a threshold. It is a floor
 * on the DATA, not a target; nothing here fits anything automatically, and phase
 * 5 moves the numbers by hand with this report in front of a person.
 */
export const MIN_DECISIONS_TO_FIT = 20;

export interface CalibrationReport {
  decisions: number;
  /** Enough to say anything at all? */
  fittable: boolean;
  /** Of the drafts the pipeline offered, how many did a person keep — as
   *  written or after an edit. */
  approvalRate: number;
  editRate: number;
  /** Of the times the pipeline declined, how often did a person disagree. The
   *  number that says whether the floors are too tight. */
  overruleRate: number;
  /** Mean score per dimension, split by what the person then did. A dimension
   *  whose two means are the same is a dimension that predicts nothing. */
  byDimension: Record<
    string,
    { kept: number | null; refused: number | null; separation: number | null }
  >;
  /** The tags people actually reach for, commonest first. */
  topTags: { tag: CoversReasonTag; n: number }[];
}

const DIMS = ['suitability', 'relevance', 'naturalness', 'brandFit', 'risk', 'factual'] as const;

const mean = (xs: number[]): number | null =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/**
 * What the decisions say about the numbers.
 *
 * ⚠️ REPORTS, AND FITS NOTHING. It returns a description a person reads before
 * moving a floor by hand. Automatic fitting is phase 7's job (`learn.ts`, on
 * measured outcomes), and doing it here — on approvals rather than on what
 * actually happened after posting — would fit the system to the reviewer's taste
 * and call it performance.
 *
 * `separation` is the honest headline: a dimension where kept and refused drafts
 * score the same is measuring nothing, however plausible its name.
 */
export function calibrationReport(feedback: readonly CoversFeedback[]): CalibrationReport {
  const decisions = feedback.length;

  const offered = feedback.filter((f) => f.action !== 'agreed-none' && f.action !== 'overruled-none');
  const declines = feedback.filter((f) => f.action === 'agreed-none' || f.action === 'overruled-none');

  const kept = offered.filter((f) => f.action === 'approved' || f.action === 'edited');
  const refused = offered.filter((f) => f.action === 'rejected');

  const rate = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100) / 100);

  const byDimension: CalibrationReport['byDimension'] = {};
  for (const d of DIMS) {
    const k = mean(kept.map((f) => f.scores?.[d]).filter((n): n is number => typeof n === 'number'));
    const r = mean(refused.map((f) => f.scores?.[d]).filter((n): n is number => typeof n === 'number'));
    byDimension[d] = {
      kept: k,
      refused: r,
      // Signed, and for `risk` a NEGATIVE separation is the correct direction —
      // refused drafts should score HIGHER on the inverted scale. Left signed
      // rather than absolute so a dimension pointing the wrong way is visible
      // as such instead of looking strong.
      separation: k !== null && r !== null ? k - r : null,
    };
  }

  const tagCounts = new Map<CoversReasonTag, number>();
  for (const f of feedback) {
    for (const t of f.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }

  return {
    decisions,
    fittable: decisions >= MIN_DECISIONS_TO_FIT,
    approvalRate: rate(kept.length, offered.length),
    editRate: rate(offered.filter((f) => f.action === 'edited').length, offered.length),
    overruleRate: rate(declines.filter((f) => f.action === 'overruled-none').length, declines.length),
    byDimension,
    topTags: [...tagCounts.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n),
  };
}
