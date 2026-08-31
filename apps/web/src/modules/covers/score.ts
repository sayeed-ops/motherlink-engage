// Six numbers per variant, a recommendation, and a sentence a human can argue
// with.
//
// PURE. Prompt and parser; the call lives in server/coversDrafts.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// A SEPARATE CALL FROM WRITING — THE ONE STRUCTURAL RULE HERE
//
// This codebase already learned it once, in forum/reply/critic.ts: a pass that
// writes and then judges its own work always finds something worth posting. It
// has just spent its effort on the text, and the question "how good is this"
// arrives pre-loaded with the assumption that it is good enough to have been
// written.
//
// So evaluation is its own call, with its own system prompt, that has not been
// asked to produce anything and has nothing invested in the answer. It costs one
// more model call per opportunity and it is the difference between a scoring
// stage and a rubber stamp.
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ THESE NUMBERS ARE MODEL OUTPUT, NOT MEASUREMENTS. Nothing here has been
// compared against a human decision yet. They order a queue and they trip the
// floors; they are not probabilities, they are not accuracy, and the review
// screen says so. COVERS-PLAN.md § How NONE stays real, point 4: floors start
// conservative and tighten only once real decisions exist to fit them against.

import type { VariantDraft, VariantKind } from './variants';
import { VARIANT_LABEL } from './variants';

// ---------------------------------------------------------------------------
// The dimensions
// ---------------------------------------------------------------------------

export type ScoreDimension =
  | 'suitability'
  | 'relevance'
  | 'naturalness'
  | 'brandFit'
  | 'risk'
  | 'factual';

export const DIMENSIONS: readonly ScoreDimension[] = [
  'suitability',
  'relevance',
  'naturalness',
  'brandFit',
  'risk',
  'factual',
] as const;

export const DIMENSION_LABEL: Record<ScoreDimension, string> = {
  suitability: 'Overall suitability',
  relevance: 'Conversation relevance',
  naturalness: 'Naturalness',
  brandFit: 'Brand fit',
  risk: 'Promotion / moderation risk',
  factual: 'Factual confidence',
};

export const DIMENSION_ASKS: Record<ScoreDimension, string> = {
  suitability: 'Should this text be posted into this thread at all?',
  relevance: 'Does it answer what was actually asked?',
  naturalness: "Does it read like a member of this section wrote it, measured against the room's own register?",
  brandFit: 'Does the client reference earn its place — and on the variants that name nobody, was not naming them right?',
  risk: 'How likely is this to be read as advertising, or removed by a moderator?',
  factual: 'Is every assertion backed by a live claim or by the thread itself?',
};

/**
 * The one inverted scale.
 *
 * Kept as a named export rather than a convention, because every consumer — the
 * floors, the ranking, the UI colour — has to agree about it, and a system where
 * five numbers mean "more is better" and the sixth quietly does not is a bug
 * waiting to be written by whoever adds the seventh.
 */
export const INVERTED: readonly ScoreDimension[] = ['risk'] as const;

export function isInverted(d: ScoreDimension): boolean {
  return (INVERTED as readonly string[]).includes(d);
}

export type VariantScores = Record<ScoreDimension, number>;

/** What the evaluator would do with it. */
export type Recommendation = 'POST' | 'EDIT' | 'SKIP';

export const RECOMMENDATIONS: readonly Recommendation[] = ['POST', 'EDIT', 'SKIP'] as const;

export interface VariantAssessment {
  kind: VariantKind;
  scores: VariantScores;
  recommendation: Recommendation;
  /** One or two sentences. Empty means the answer could not be read — and an
   *  answer we did not understand is not a licence to post. */
  why: string;
}

export const SCORE_PROMPT_VERSION = 'covers-score-v1';

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const SCORE_SYSTEM = `You are evaluating replies that have already been written for a sports betting forum. You did not write them. You are NOT rewriting, improving or combining anything.

Score each reply on six dimensions, 0 to 100.

1. suitability — should this text be posted into this thread at all?
2. relevance — does it answer what was actually asked, rather than something adjacent?
3. naturalness — does it read like a member of this section, measured against the register given below? Bullet lists in a plain-prose room, assistant phrasing, and sign-offs all belong here.
4. brandFit — does naming the client earn its place? For a reply that names nobody, score whether NOT naming them was the right call: a reply that obviously should have pointed somewhere and did not scores low.
5. risk — HOW LIKELY IS THIS TO BE READ AS ADVERTISING OR REMOVED BY A MODERATOR. THIS SCALE IS INVERTED: 0 is safe, 100 is certain removal. Do not score it like the others.
6. factual — is every assertion backed by one of the verified claims listed, or by something in the thread itself? An unbacked number, a stated product behaviour with no claim, or an appeal to "studies" scores low.

Then give a recommendation:
- "POST" — this is worth posting as written.
- "EDIT" — the idea is right, the text is not there yet.
- "SKIP" — this should not be posted. Use it freely.

BE HARSH. Saying nothing costs this account nothing. A reply that is merely fine is not worth posting: it lands flat, it is one more piece of evidence that the account is not a person, and there is no upside to a forgettable post. If a reply invents an experience the writer has not had, or states a fact with nothing behind it, score factual near zero and recommend SKIP regardless of how well it reads.

Output STRICT JSON:
{"assessments": [{"kind": "<the kind>", "suitability": 0, "relevance": 0, "naturalness": 0, "brandFit": 0, "risk": 0, "factual": 0, "recommendation": "POST" | "EDIT" | "SKIP", "why": "<one or two sentences>"}]}
No prose, no markdown outside the JSON.`;

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface ScorePromptInput {
  sectionName: string;
  threadTitle: string;
  postBody: string;
  problem: string;
  /** Rendered register lines, from register.ts. The evaluator judges
   *  naturalness against the same measurements the writer was given — scoring
   *  against a different yardstick than the one the text was written to is how
   *  a pipeline argues with itself. */
  registerLines: string[];
  /** The claims that were available, so `factual` can be checked rather than
   *  guessed at. */
  claims: readonly { claimId: string; text: string }[];
  /** True only in a section tagged `promote`. */
  linksPermitted: boolean;
  brandNames: readonly string[];
}

export function buildScorePrompt(
  drafts: readonly VariantDraft[],
  input: ScorePromptInput,
): { system: string; user: string } {
  const user = [
    `SECTION: ${input.sectionName}`,
    `THREAD: ${trim(input.threadTitle, 300)}`,
    '',
    'THE POST BEING ANSWERED:',
    `"""\n${trim(input.postBody, 1500)}\n"""`,
    '',
    `WHAT THEY WANT: ${input.problem}`,
    `THE CLIENT IS CALLED: ${input.brandNames.join(', ') || '(not configured)'}`,
    `LINKS IN THIS SECTION: ${input.linksPermitted ? 'permitted' : 'NOT permitted'}`,
    '',
    'HOW PEOPLE WRITE HERE (judge naturalness against this):',
    ...input.registerLines,
    '',
    'VERIFIED CLAIMS THAT WERE AVAILABLE:',
    input.claims.length
      ? input.claims.map((c) => `[${c.claimId}] ${trim(c.text, 250)}`).join('\n')
      : '(none — any stated fact about the client is unbacked)',
    '',
    'THE REPLIES:',
    ...drafts.map(
      (d) =>
        `--- kind: ${d.kind} (${VARIANT_LABEL[d.kind]}) · ${d.words} words · cites: ${
          d.claimIds.length ? d.claimIds.join(', ') : 'nothing'
        }\n${d.text}`,
    ),
    '',
    `Score all ${drafts.length}. Respond with JSON: {"assessments": [${drafts
      .map((d) => `{"kind": "${d.kind}", …}`)
      .join(', ')}]}`,
  ].join('\n');

  return { system: SCORE_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function clamp(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Read the evaluator's answer, or refuse it.
 *
 * ⚠️ A MISSING DIMENSION IS NOT DEFAULTED. Filling an absent `factual` with 0
 * would look safe and is not: it produces a confident-looking failing score for
 * a reply nobody actually judged, and downstream cannot tell that apart from a
 * real one. A partial assessment is dropped, and a variant with no assessment is
 * dropped before the critic — which is the conservative direction.
 */
export function parseAssessments(
  raw: unknown,
  asked: readonly VariantKind[],
): VariantAssessment[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { assessments?: unknown }).assessments)
      ? (raw as { assessments: unknown[] }).assessments
      : null;
  if (!list) return [];

  const wanted = new Set(asked);
  const seen = new Set<VariantKind>();
  const out: VariantAssessment[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const kind = typeof o.kind === 'string' ? (o.kind.trim().toLowerCase() as VariantKind) : null;
    if (!kind || !wanted.has(kind) || seen.has(kind)) continue;

    const scores = {} as VariantScores;
    let complete = true;
    for (const d of DIMENSIONS) {
      const v = clamp(o[d]);
      if (v === null) {
        complete = false;
        break;
      }
      scores[d] = v;
    }
    if (!complete) continue;

    const rec = typeof o.recommendation === 'string' ? o.recommendation.trim().toUpperCase() : '';
    if (!(RECOMMENDATIONS as readonly string[]).includes(rec)) continue;

    const why = typeof o.why === 'string' ? o.why.trim().slice(0, 500) : '';
    // A judgement with no reason cannot be checked by the person reviewing it.
    // Same rule parseIntent applies to a classification with no problem
    // statement, and parseCriticVerdict to a choice with no reason.
    if (!why) continue;

    seen.add(kind);
    out.push({ kind, scores, recommendation: rec as Recommendation, why });
  }

  return out;
}

// ---------------------------------------------------------------------------
// The floors
// ---------------------------------------------------------------------------

/**
 * The minimum each dimension must clear, before any critic is asked anything.
 *
 * ⚠️ CONSERVATIVE ON PURPOSE, AND UNCALIBRATED. Every number here is a
 * judgement made before a single human decision existed to compare against, and
 * phase 5 is where they get fitted. Starting them loose and tightening later is
 * the wrong direction: the cost of a floor that is too high is a reply nobody
 * posts, and the cost of one that is too low is a reply that gets an account
 * banned in a forum that treats promotion outside one section as bannable.
 */
export interface ScoreFloors {
  suitability: number;
  relevance: number;
  naturalness: number;
  brandFit: number;
  /** A CEILING, not a floor — `risk` is the inverted scale. Named `risk` to
   *  match the dimension it guards; the comparison is `<=`, in `belowFloor`. */
  risk: number;
  factual: number;
}

export const DEFAULT_FLOORS: ScoreFloors = {
  suitability: 60,
  relevance: 60,
  naturalness: 55,
  brandFit: 40,
  risk: 40,
  factual: 60,
};

export function normaliseFloors(raw: unknown): ScoreFloors {
  const input = (raw ?? {}) as Partial<Record<ScoreDimension, unknown>>;
  const out = { ...DEFAULT_FLOORS };
  for (const d of DIMENSIONS) {
    const v = clamp(input[d]);
    if (v !== null) out[d] = v;
  }
  return out;
}

export interface FloorFailure {
  dimension: ScoreDimension;
  score: number;
  floor: number;
  detail: string;
}

/**
 * Which floors this variant failed. Empty means it survives to the critic.
 *
 * Collected rather than short-circuited, exactly as the gates are: the review
 * screen has to show every reason a variant was dropped, and "naturalness 40"
 * alone hides that the same reply also had nothing behind its one stated fact.
 */
export function belowFloor(scores: VariantScores, floors: ScoreFloors): FloorFailure[] {
  const out: FloorFailure[] = [];

  for (const d of DIMENSIONS) {
    const score = scores[d];
    const floor = floors[d];

    const failed = isInverted(d) ? score > floor : score < floor;
    if (!failed) continue;

    out.push({
      dimension: d,
      score,
      floor,
      detail: isInverted(d)
        ? `${DIMENSION_LABEL[d]} ${score}, ceiling is ${floor} (lower is better)`
        : `${DIMENSION_LABEL[d]} ${score}, floor is ${floor}`,
    });
  }

  return out;
}

/** One number for ordering only — the mean of the five upward dimensions with
 *  risk subtracted. Never a floor, never shown as a verdict: the six numbers are
 *  the answer and this is only how two survivors get put in an order. */
export function overallOf(scores: VariantScores): number {
  const upward = DIMENSIONS.filter((d) => !isInverted(d));
  const mean = upward.reduce((a, d) => a + scores[d], 0) / upward.length;
  return Math.max(0, Math.min(100, Math.round(mean - scores.risk * 0.3)));
}
