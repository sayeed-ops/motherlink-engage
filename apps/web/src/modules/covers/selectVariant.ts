// Which of the written replies should exist — or none of them.
//
// PURE. The arithmetic runs here; the one model call it may make lives in
// server/coversDrafts.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// NONE IS THE NORMAL ANSWER, SO IT MUST BE THE CHEAP ONE
//
// A model asked to pick a winner picks a winner. It has three replies in front
// of it and the question "which is best" contains the assumption that one is. So
// the decline is not left to the critic's goodwill — it is arithmetic, and it
// runs first:
//
//   1. FLOORS AND GATES, free. Any variant below a per-dimension floor,
//      recommended SKIP, or failing compliance is dropped before the critic sees
//      anything. ALL DROPPED IS **NONE WITH NO MODEL CALL**.
//   2. ONE SURVIVOR IS THE ANSWER. No critic call — there is nothing to choose
//      between, and paying a model to agree with arithmetic is a bill, not a
//      safeguard.
//   3. TWO OR THREE GO TO THE CRITIC, which ranks them and may still return
//      NONE.
//
// ⚠️ NONE IS RECORDED LIKE ANY OTHER OUTCOME, with the stage it happened at and
// every reason. A queue showing only successes reads as broken when it is the
// feature working — the same rule that makes commentKarma write a draft record
// for every scan including the skips.
// ════════════════════════════════════════════════════════════════════════════

import type { ComplianceFailure, ComplianceResult } from './compliance';
import type { FloorFailure, ScoreFloors, VariantAssessment } from './score';
import { belowFloor, overallOf } from './score';
import type { VariantDraft, VariantKind } from './variants';
import { VARIANT_LABEL } from './variants';

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/**
 * Where a variant stopped.
 *
 * Ordered as the pipeline runs, so a tally across many opportunities reads as a
 * funnel — and a funnel that collapses at one stage is the fastest way to notice
 * that a prompt or a floor has drifted. Same idea as SkipStage in
 * forum/reply/drafts.ts.
 */
export type DropStage =
  /** The eligibility mask removed it in phase 3, for free. Never written. */
  | 'ineligible'
  /** Eligible, asked for, and the model returned nothing usable for it. */
  | 'not-written'
  /** Written, and the evaluator returned no readable assessment for it. */
  | 'not-scored'
  /** Failed a compliance check. */
  | 'compliance'
  /** Below a per-dimension floor. */
  | 'floor'
  /** The evaluator itself said SKIP. */
  | 'recommendation'
  /** Survived everything and the critic preferred another, or none. */
  | 'critic';

export const DROP_STAGE_LABEL: Record<DropStage, string> = {
  ineligible: 'Not eligible here',
  'not-written': 'Nothing usable was written',
  'not-scored': 'Could not be scored',
  compliance: 'Failed a compliance check',
  floor: 'Below a score floor',
  recommendation: 'The evaluator said skip',
  critic: 'The critic did not choose it',
};

export interface DroppedVariant {
  kind: VariantKind;
  stage: DropStage;
  /** Every reason, in the reviewer's language. Collected rather than
   *  short-circuited — see checkCompliance. */
  reasons: string[];
  /** Populated for a `floor` drop, so the screen can show the number and the
   *  bar side by side rather than a sentence about them. */
  floorFailures?: FloorFailure[];
}

export interface Survivor {
  draft: VariantDraft;
  assessment: VariantAssessment;
  compliance: ComplianceResult;
  /** Ordering only — see overallOf. Never a verdict. */
  overall: number;
}

export interface DropInput {
  /** Every kind the mask said was eligible. */
  eligible: readonly VariantKind[];
  /** Everything the mask removed, with the phase-3 reason. */
  ineligible: readonly { kind: VariantKind; reason: string }[];
  drafts: readonly VariantDraft[];
  assessments: readonly VariantAssessment[];
  /** Keyed by variant kind. Every written draft must have one. */
  compliance: ReadonlyMap<VariantKind, ComplianceResult>;
  floors: ScoreFloors;
}

export interface DropResult {
  survivors: Survivor[];
  dropped: DroppedVariant[];
}

const detail = (f: ComplianceFailure) => `${f.code}: ${f.detail}`;

/**
 * Everything that can drop a variant without asking a model anything.
 *
 * ORDER WITHIN ONE VARIANT DOES NOT SHORT-CIRCUIT — a draft that fails
 * compliance is still scored against the floors if an assessment exists, and
 * both sets of reasons are recorded. The stage reported is the first one that
 * fired, because that is the one to fix; the reasons are all of them, because
 * fixing one and rediscovering the next is a wasted round trip.
 */
export function dropBeforeCritic(input: DropInput): DropResult {
  const survivors: Survivor[] = [];
  const dropped: DroppedVariant[] = [];

  for (const { kind, reason } of input.ineligible) {
    dropped.push({ kind, stage: 'ineligible', reasons: [reason] });
  }

  for (const kind of input.eligible) {
    const draft = input.drafts.find((d) => d.kind === kind);
    if (!draft) {
      dropped.push({
        kind,
        stage: 'not-written',
        reasons: ['The generator returned nothing usable for this variant.'],
      });
      continue;
    }

    const compliance = input.compliance.get(kind);
    const assessment = input.assessments.find((a) => a.kind === kind);

    const complianceReasons = compliance ? compliance.failures.map(detail) : [];
    const floorFailures = assessment ? belowFloor(assessment.scores, input.floors) : [];
    const floorReasons = floorFailures.map((f) => f.detail);

    if (!assessment) {
      // Conservative direction, deliberately: an unscored variant is dropped
      // rather than passed through unjudged. A missing assessment means the
      // evaluator's answer could not be read, and an answer we did not
      // understand is not a licence to post.
      dropped.push({
        kind,
        stage: 'not-scored',
        reasons: [
          'The evaluator returned no readable assessment for this variant.',
          ...complianceReasons,
        ],
      });
      continue;
    }

    if (complianceReasons.length > 0) {
      dropped.push({
        kind,
        stage: 'compliance',
        reasons: [...complianceReasons, ...floorReasons],
        floorFailures,
      });
      continue;
    }

    if (assessment.recommendation === 'SKIP') {
      dropped.push({
        kind,
        stage: 'recommendation',
        reasons: [`The evaluator said SKIP: ${assessment.why}`, ...floorReasons],
        floorFailures,
      });
      continue;
    }

    if (floorFailures.length > 0) {
      dropped.push({ kind, stage: 'floor', reasons: floorReasons, floorFailures });
      continue;
    }

    survivors.push({
      draft,
      assessment,
      compliance: compliance!,
      overall: overallOf(assessment.scores),
    });
  }

  // Best first, so the critic prompt and the review screen agree about order.
  survivors.sort((a, b) => b.overall - a.overall);

  return { survivors, dropped };
}

// ---------------------------------------------------------------------------
// The critic
// ---------------------------------------------------------------------------

export const CRITIC_PROMPT_VERSION = 'covers-critic-v1';

export const CRITIC_SYSTEM = `You are choosing between replies that have already been written for one post on a sports betting forum. You did not write them and you are NOT rewriting, improving or combining anything.

These are not three drafts of the same reply. They are DIFFERENT KINDS of reply — one may name the client, one is shaped by what the client knows but names nobody, one is an ordinary forum post with no client behind it. Each is valid on its own terms. Your question is not "which is best written". It is "which of these, if any, should be posted into this thread".

Judge on:
- Does it answer what this person actually asked? Advice nobody asked for is the most common way a reply is ignored.
- Would somebody in this section read the first line and keep reading?
- Does it sound like a member of this section, or like someone performing being helpful?
- Could every statement in it be defended honestly if challenged?
- Would a moderator, or a regular, read it as an advert?

CHOOSE NONE FREELY. It is the right answer more often than not. Posting nothing costs this account nothing; a reply that lands flat is one more piece of evidence that the account is not a person, and a reply read as an advert is how the account is lost. Do not pick the least bad one — if none of them should be posted here, choose none.

Prefer the reply that is genuinely most useful to the person who asked, even when that is the one with no client in it. A community-only reply is a complete and correct answer, not a fallback.

Output STRICT JSON: {"chosen": "<the kind, exactly as given>" or null, "reason": "<one sentence>"}
No prose, no markdown.`;

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface CriticPromptInput {
  sectionName: string;
  threadTitle: string;
  postBody: string;
  problem: string;
  registerLines: string[];
}

export function buildCriticPrompt(
  survivors: readonly Survivor[],
  input: CriticPromptInput,
): { system: string; user: string } {
  const user = [
    `SECTION: ${input.sectionName}`,
    `THREAD: ${trim(input.threadTitle, 300)}`,
    '',
    'THE POST BEING ANSWERED:',
    `"""\n${trim(input.postBody, 1500)}\n"""`,
    '',
    `WHAT THEY WANT: ${input.problem}`,
    '',
    'HOW PEOPLE WRITE HERE:',
    ...input.registerLines,
    '',
    'THE CANDIDATES:',
    // Addressed by KIND rather than by index. A numbered list between a prompt
    // and a parser is an off-by-one waiting to happen, and an off-by-one here
    // does not throw — it selects a reply nobody chose. The kinds are distinct
    // strings and the parser matches them exactly.
    ...survivors.map(
      (s) =>
        `--- kind: ${s.draft.kind} (${VARIANT_LABEL[s.draft.kind]}) · ${s.draft.words} words\n${s.draft.text}\n  the evaluator said: ${s.assessment.why}`,
    ),
    '',
    `Respond with JSON: {"chosen": ${survivors.map((s) => `"${s.draft.kind}"`).join(' | ')} | null, "reason": "<one sentence>"}`,
  ].join('\n');

  return { system: CRITIC_SYSTEM, user };
}

export interface CriticVerdict {
  chosen: VariantKind | null;
  reason: string;
}

export const NO_CHOICE: CriticVerdict = { chosen: null, reason: '' };

/**
 * Read the critic's answer, or refuse it.
 *
 * ⚠️ A KIND THAT WAS NOT OFFERED IS A DECLINE, NOT A CORRECTION. Snapping an
 * unrecognised answer to the nearest candidate would post a reply the critic did
 * not choose, and an answer naming something outside the list means the response
 * was not about these candidates at all. Same rule parseCriticVerdict applies to
 * an out-of-range index on the Reddit side.
 *
 * A choice with no reason is also a decline. This is the last judgement before a
 * human reads the draft, and a pick nobody can check is not a pick.
 */
export function parseCriticVerdict(raw: unknown, offered: readonly VariantKind[]): CriticVerdict {
  if (!raw || typeof raw !== 'object') return NO_CHOICE;
  const o = raw as Record<string, unknown>;

  const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 500) : '';

  const chosen = typeof o.chosen === 'string' ? (o.chosen.trim().toLowerCase() as VariantKind) : null;
  if (!chosen || !offered.includes(chosen)) {
    // Includes the explicit null — "none of these", the answer this system needs
    // to be easy to give. The reason is kept either way, because "none, they all
    // read as an advert to somebody who asked a simple question" is exactly what
    // the review screen and the calibration set need.
    return { chosen: null, reason };
  }

  if (!reason) return NO_CHOICE;

  return { chosen, reason };
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

export type SelectionOutcome = VariantKind | 'NONE';

/** Where the selection landed, and why. Written to the draft record whatever
 *  the answer is. */
export interface Selection {
  selected: SelectionOutcome;
  reason: string;
  /** Did we pay for a critic call? False when arithmetic settled it — which is
   *  most of the time, and is the point of the ordering. */
  criticCalled: boolean;
  survivors: Survivor[];
  dropped: DroppedVariant[];
}

/** The answer when nothing survived the free tier. No model call was made and
 *  none should be: there is nothing to choose between. */
export function noneFromDrops(dropped: DroppedVariant[]): Selection {
  return {
    selected: 'NONE',
    reason:
      dropped.length === 0
        ? 'No variant was eligible here.'
        : `Every variant was dropped before the critic: ${dropped
            .map((d) => `${VARIANT_LABEL[d.kind]} (${DROP_STAGE_LABEL[d.stage].toLowerCase()})`)
            .join('; ')}.`,
    criticCalled: false,
    survivors: [],
    dropped,
  };
}

/** One survivor. The answer, without paying a model to agree with arithmetic. */
export function soleSurvivor(survivor: Survivor, dropped: DroppedVariant[]): Selection {
  return {
    selected: survivor.draft.kind,
    reason: `The only variant to clear the floors and the gates. ${survivor.assessment.why}`,
    criticCalled: false,
    survivors: [survivor],
    dropped,
  };
}

/** Two or three survivors, and the critic has answered. */
export function fromCritic(
  verdict: CriticVerdict,
  survivors: Survivor[],
  dropped: DroppedVariant[],
): Selection {
  if (verdict.chosen === null) {
    return {
      selected: 'NONE',
      reason: verdict.reason || 'The critic chose none of them, and gave no reason we could read.',
      criticCalled: true,
      survivors,
      dropped: [
        ...dropped,
        ...survivors.map((s) => ({
          kind: s.draft.kind,
          stage: 'critic' as const,
          reasons: [verdict.reason || 'The critic chose none of them.'],
        })),
      ],
    };
  }

  return {
    selected: verdict.chosen,
    reason: verdict.reason,
    criticCalled: true,
    survivors,
    dropped: [
      ...dropped,
      ...survivors
        .filter((s) => s.draft.kind !== verdict.chosen)
        .map((s) => ({
          kind: s.draft.kind,
          stage: 'critic' as const,
          reasons: [`The critic chose ${VARIANT_LABEL[verdict.chosen!]} instead: ${verdict.reason}`],
        })),
    ],
  };
}
