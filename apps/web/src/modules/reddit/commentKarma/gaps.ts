// The gap: what this thread wants, minus what it already got.
//
// PURE — prompt building and response parsing only. The model call itself lives
// in server/commentKarma.ts, the same split as llm/select.ts vs llm/resolve.ts:
// the part most likely to be got subtly wrong takes plain data in and returns a
// decision, so it can be tested without a network or an API key.
//
// This is the ONE judgement in the system. Everything else — which post, how
// long, how formal, when — is measured. Two questions only:
//
//     What does the poster actually want?
//     What has the thread already delivered?
//
// The response style is NOT asked for and must never be. Funny/useful/agreeing
// falls out of the gap; asking a model to pick a style produces a model's idea
// of a style, which is how comments end up sounding like comments.

import type { ThreadComment, ThreadSnapshot } from '../reader/types';
import type { RoomProfile } from './roomProfile';

/** What the poster is actually after. Getting this wrong is the most common way
 *  a comment is ignored — SOMEONE VENTING DOES NOT WANT ADVICE, and no amount of
 *  good writing rescues advice they did not ask for. */
export type PosterWant =
  | 'information'
  | 'opinions'
  | 'comfort'
  | 'entertainment'
  | 'decision'
  | 'vent';

/**
 * The state of the thing worth saying.
 *
 * Operator clarification, 2026-08-16, and the reason this is five states rather
 * than a boolean: a point already made is NOT automatically a reason to stay
 * out. The best-phrased version of an obvious answer routinely outranks whoever
 * said it first, so 'said-badly' is a first-class move, not a fallback.
 */
export type GapState =
  /** Nobody has said it. */
  | 'absent'
  /** Right idea, poor delivery — rambling, hedged, unclear. Say it better. */
  | 'said-badly'
  /** Right idea sitting at the bottom with no votes. Say it where it is seen. */
  | 'buried'
  /** Right, but missing the qualifier that makes it usable. */
  | 'partial'
  /** Said well, and at the top. The only true no-go. */
  | 'none';

export interface GapAnalysis {
  posterWant: PosterWant;
  /** One line on what the thread has actually delivered so far. */
  delivered: string;
  gapState: GapState;
  /** What to say, or how to say it better. Empty when gapState is 'none'. */
  angle: string;
  /** The comment being improved on, for said-badly / buried / partial. */
  targetCommentId: string | null;
  /** 0..1. Low confidence plus a marginal state should skip. */
  confidence: number;
}

export const POSTER_WANTS: readonly PosterWant[] = [
  'information',
  'opinions',
  'comfort',
  'entertainment',
  'decision',
  'vent',
];

export const GAP_STATES: readonly GapState[] = ['absent', 'said-badly', 'buried', 'partial', 'none'];

/** The JSON shape demanded of the model. Sent in the user message, mirroring
 *  modules/reddit/prompts.ts, which does the same for analysis. */
export const GAP_SCHEMA = {
  posterWant: `one of: ${POSTER_WANTS.join(' | ')}`,
  delivered: 'one sentence on what the thread has already given them',
  gapState: `one of: ${GAP_STATES.join(' | ')}`,
  angle: 'one sentence: what to say, or how to say the existing point better. Empty string when gapState is none.',
  targetCommentId: 'the comment id being improved on, or null',
  confidence: 'number 0-1',
} as const;

export const GAP_SYSTEM = `You read a Reddit thread and decide whether there is anything worth adding. You are not writing the comment.

Answer two questions.

1. WHAT DOES THE POSTER WANT? Choose exactly one:
- information — a fact, a how-to, a recommendation
- opinions — other people's views or experiences
- comfort — to be heard; they are upset, grieving or overwhelmed
- entertainment — an amusing prompt; they want to be entertained back
- decision — help choosing between options
- vent — to say a thing out loud, with no request attached

COMFORT AND VENT DO NOT WANT ADVICE. If someone is describing something painful and has not asked a question, giving them steps is the single most common way to be ignored or downvoted. Say so by choosing comfort or vent.

2. WHAT IS THE STATE OF THE THING WORTH SAYING?
- absent — nobody has said it
- said-badly — the right idea is there but delivered poorly: rambling, hedged, buried in jargon, unclear. Saying it CLEARLY is worth doing; the best-phrased version of an obvious point routinely outranks whoever said it first.
- buried — the right idea is there, correct, and has almost no votes
- partial — the right idea is there but missing the qualifier that makes it usable
- none — it has been said, said well, and is at the top

CHOOSE 'none' FREELY. Most threads do not need another comment. A system that always finds something to say posts filler, and filler is what gets an account noticed. 'none' is the expected answer, not a failure.

Never suggest a style, a tone, or a length. Do not propose jokes, empathy or explanations as formats. Describe only what is missing.

Output STRICT JSON matching the schema in the user message. No prose, no markdown.`;

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Render the comments the model must reason over.
 *
 *  Ids are included because the model has to be able to POINT at the comment it
 *  would improve on — 'said-badly' with no target is unactionable downstream. */
function renderComments(comments: ThreadComment[], max: number): string {
  if (!comments.length) return '(no comments yet)';
  return comments
    .slice(0, max)
    .map((c, i) => `[${i + 1}] id=${c.commentId} score=${c.score}${c.isOp ? ' (OP)' : ''}\n${trim(c.body, 600)}`)
    .join('\n\n');
}

export interface GapPromptOptions {
  /** How many top comments to show. More is not better: the question is what
   *  the room has SAID, and the tail of a thread is not part of that. */
  maxComments?: number;
}

export function buildGapPrompt(
  thread: ThreadSnapshot,
  profile: RoomProfile,
  opts: GapPromptOptions = {},
): { system: string; user: string } {
  const { post, comments } = thread;

  // The profile is included as CONTEXT for judging what "said badly" means in
  // this room — a 60-word comment is rambling where winners run 8 words and
  // terse where they run 200 — not as a style instruction. The model is never
  // asked to pick a length.
  const user = [
    `SUBREDDIT: r/${post.subreddit}`,
    `TITLE: ${trim(post.title, 300)}`,
    post.body.trim() ? `BODY: ${trim(post.body, 1500)}` : 'BODY: (none — the title is the whole post)',
    '',
    `ROOM: winning comments here run about ${profile.medianWinnerWords} words${
      profile.jargon.length ? `; common vocabulary: ${profile.jargon.slice(0, 8).join(', ')}` : ''
    }.`,
    '',
    'COMMENTS ALREADY POSTED (highest scoring first):',
    renderComments(comments, opts.maxComments ?? 10),
    '',
    'Respond with JSON exactly matching this schema:',
    JSON.stringify(GAP_SCHEMA, null, 2),
  ].join('\n');

  return { system: GAP_SYSTEM, user };
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);

/**
 * Defensive parse. Never throws.
 *
 * Anything unrecognised collapses to a SKIP rather than a guess: an unparseable
 * response must not become a comment. Returns null when the payload is not
 * usable at all, which callers treat exactly like 'none'.
 */
export function parseGapAnalysis(raw: unknown): GapAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const gapState = GAP_STATES.includes(o.gapState as GapState) ? (o.gapState as GapState) : null;
  const posterWant = POSTER_WANTS.includes(o.posterWant as PosterWant)
    ? (o.posterWant as PosterWant)
    : null;
  // An unknown state or want means we did not understand the answer. Skip.
  if (!gapState || !posterWant) return null;

  const confidenceRaw = typeof o.confidence === 'number' ? o.confidence : 0;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));

  const angle = asString(o.angle);
  // A gap with nothing to say is not a gap. Downgrading rather than trusting the
  // label keeps a confident-sounding empty answer from reaching generation.
  const state: GapState = gapState !== 'none' && !angle ? 'none' : gapState;

  return {
    posterWant,
    delivered: asString(o.delivered),
    gapState: state,
    angle: state === 'none' ? '' : angle,
    targetCommentId: asString(o.targetCommentId) || null,
    confidence,
  };
}

/** Minimum confidence for the states that improve on someone else's comment.
 *  Higher than for 'absent' deliberately: saying nothing is free, while saying
 *  "actually, better put" about a comment that was fine reads as arrogant. */
export const IMPROVE_CONFIDENCE = 0.6;
export const ABSENT_CONFIDENCE = 0.45;

/** Should this analysis proceed to generation? */
export function shouldProceed(gap: GapAnalysis | null): boolean {
  if (!gap || gap.gapState === 'none' || !gap.angle) return false;
  if (gap.gapState === 'absent') return gap.confidence >= ABSENT_CONFIDENCE;
  // said-badly / buried / partial all position us against an existing comment,
  // so they need a target as well as confidence.
  return gap.confidence >= IMPROVE_CONFIDENCE && !!gap.targetCommentId;
}
