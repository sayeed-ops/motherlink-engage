// Writing the comment — three attempts, none of them chosen here.
//
// PURE — prompt building and response parsing only, the same split as ./gaps.ts.
// The model call lands in server/commentKarma.ts at Phase 4/5; the agent never
// makes one at all (it has no LLM access — Firestore is the only bus, and the
// finished text is composed server-side at enqueue time and frozen onto the job).
//
// TWO PASSES, DELIBERATELY. This file writes candidates and is not allowed to
// pick between them; ./critic.ts picks and is not allowed to write. A single
// pass that generates and self-selects always chooses, because a model asked
// "which of your three is best" has no way to answer "none of them". Saying
// nothing is the normal outcome here, so the refusal has to live somewhere it
// costs nothing — which is a separate call with a separate job.
//
// WHAT IS NOT ASKED FOR, and must never be: a style, a tone, or a length.
//   - Style falls out of the gap, which ./gaps.ts produced.
//   - Register is COPIED from the room profile — 8 of 10 winners here use
//     contractions is a measurement of this room, not a preference.
//   - Length is COPIED from the comments already winning in this thread; the
//     band arrives from targetLength() and the model is told it, never asked.
// A model invited to choose any of the three returns a model's idea of it,
// which is how comments start sounding like comments.

import type { ThreadComment, ThreadSnapshot } from '../reader/types';
import type { GapAnalysis } from './gaps';
import { countWords, isConfident, type RoomProfile } from './roomProfile';

/**
 * The person this account is.
 *
 * Fixed per account, never regenerated per comment — an account that is a
 * gardener on Monday and a crypto trader on Tuesday is not a person. Phase 4
 * persists this on the account document; the account's existing `notes` field
 * is what feeds `situation` today (the warm-up generate route already uses it
 * as a persona hint, so the shape is not new).
 */
export interface CommentPersona {
  /** What this person plausibly knows about. */
  topics: string[];
  /** A line or two of life situation, in the operator's words. */
  situation: string;
  /** Things this person must never claim to be or to have. The safety rule and
   *  the persona rule are the same rule: a persona that never overclaims can
   *  never be caught out. */
  neverClaims: string[];
}

/** No persona configured. Not a neutral default — it deliberately produces the
 *  most cautious instruction, because an unspecified person who claims
 *  first-hand experience is claiming something nobody has approved. */
export const EMPTY_PERSONA: CommentPersona = { topics: [], situation: '', neverClaims: [] };

export interface CommentCandidate {
  text: string;
  /** Counted with the same function that produced the room's length band. */
  words: number;
}

/** Three. Enough for the critic to have a real choice between different
 *  executions; few enough that one refused generation is cheap. */
export const CANDIDATE_COUNT = 3;

export const GENERATE_SYSTEM = `You write ONE Reddit comment, as the person described in the user message.

You are given a GAP — the thing this thread wants and has not got. Fill exactly that gap and nothing else.

Produce THREE separate attempts. They must differ in LENGTH and in OPENING WORDS. Three rewordings of one sentence is one attempt, not three.

Rules:
- One idea per comment. Not three. People upvote one clear thing.
- The first sentence carries it. Comments are read collapsed, and if the opening does not land nothing after it is read.
- Specifics beat generalities — but only specifics this person could actually know. "Took me about six months, maybe £200" is good. "The average cost is £200" is not, because you could not answer honestly if someone asked where that came from.
- Never link to anything. Never name a brand, product or company.
- Never name another commenter, and never tell anyone they are wrong. If the right point is already there badly put, simply say it clearly — do not announce that you are correcting anyone.
- No sign-offs. No "hope this helps", no "let me know if you have questions", no offers to explain further.
- Do not restate the question back at them.
- Write inside the register described in the user message. Those are measurements of this specific room, not preferences — match them.
- You are allowed to be unremarkable. A short, ordinary, unimpressive comment is a valid attempt, and often the right one.

Output STRICT JSON: {"candidates": ["…", "…", "…"]}. No prose, no markdown, no explanation, no numbering.`;

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** How many of ten, for a rate. Ten rather than a percentage because "8 of 10
 *  comments here open in lowercase" reads as an observation, and "80%" reads as
 *  a target to hit. */
function outOfTen(rate: number): number {
  return Math.round(rate * 10);
}

/**
 * The register lines: what this room measurably does.
 *
 * Only stated when the profile is worth trusting. Below MIN_SAMPLE the profile
 * describes one person's habits, and telling a model "nobody here uses
 * contractions" on the evidence of two comments would manufacture a register
 * rather than copy one.
 */
export function renderRegister(
  profile: RoomProfile,
  length: { min: number; max: number; target: number },
): string[] {
  const lines = [
    `- length: the comments winning here run about ${profile.medianWinnerWords} words. Write between ${length.min} and ${length.max} words.`,
  ];
  if (!isConfident(profile)) {
    lines.push('- this thread is too thin to read the room from; write plainly and keep it short.');
    return lines;
  }

  lines.push(`- ${outOfTen(profile.contractionRate)} of 10 winning comments use contractions`);
  lines.push(`- ${outOfTen(profile.lowercaseOpenRate)} of 10 begin with a lowercase letter`);
  lines.push(`- ${outOfTen(profile.firstPersonRate)} of 10 talk about themselves`);
  lines.push(
    profile.profanityRate > 0.15
      ? '- people swear here; mild swearing is normal'
      : '- nobody swears here',
  );
  if (profile.emojiRate > 0.15) lines.push('- emoji appear here');
  if (profile.markdownRate < 0.15) {
    // The strongest single tell there is. Bullet lists and bold headings in a
    // room that writes plain paragraphs read as machine output before anyone
    // has read a word of the content.
    lines.push('- plain prose only: no bullet lists, no headings, no bold');
  }
  if (profile.jargon.length) {
    lines.push(`- words people use here: ${profile.jargon.slice(0, 8).join(', ')}`);
  }
  if (profile.negative.count > 0) {
    lines.push(`- ${profile.negative.count} comment(s) here were downvoted to nothing`);
  }
  return lines;
}

function renderPersona(persona: CommentPersona): string[] {
  const lines: string[] = [];
  lines.push(
    persona.situation.trim()
      ? `WHO YOU ARE: ${trim(persona.situation, 600)}`
      : 'WHO YOU ARE: an ordinary member of this community. Claim no expertise, no profession and no first-hand experience you have not been given below.',
  );
  if (persona.topics.length) {
    lines.push(`YOU KNOW ABOUT: ${persona.topics.slice(0, 12).join(', ')} — and nothing else.`);
  }
  if (persona.neverClaims.length) {
    lines.push(`YOU ARE NOT AND MUST NEVER CLAIM TO BE: ${persona.neverClaims.slice(0, 12).join(', ')}.`);
  }
  return lines;
}

function renderComments(comments: ThreadComment[], max: number): string {
  if (!comments.length) return '(no comments yet)';
  return comments
    .slice(0, max)
    .map((c, i) => `[${i + 1}] id=${c.commentId} score=${c.score}${c.isOp ? ' (OP)' : ''}\n${trim(c.body, 400)}`)
    .join('\n\n');
}

export interface GeneratePromptOptions {
  candidates?: number;
  /** Top comments shown, so the attempts do not repeat what is already there. */
  maxComments?: number;
  /** Openings this account has used recently. Passed through from the bot-tell
   *  pressure in ./botTell.ts — the gate does not only refuse, it steers, and
   *  steering before generation is cheaper than rejecting after it. */
  avoidOpenings?: string[];
}

export function buildGenerationPrompt(
  thread: ThreadSnapshot,
  profile: RoomProfile,
  gap: GapAnalysis,
  persona: CommentPersona,
  length: { min: number; max: number; target: number },
  opts: GeneratePromptOptions = {},
): { system: string; user: string } {
  const { post, comments } = thread;
  const n = opts.candidates ?? CANDIDATE_COUNT;

  const target = gap.targetCommentId
    ? comments.find((c) => c.commentId === gap.targetCommentId)
    : undefined;

  const user = [
    `SUBREDDIT: r/${post.subreddit}`,
    `TITLE: ${trim(post.title, 300)}`,
    post.body.trim() ? `BODY: ${trim(post.body, 1500)}` : 'BODY: (none — the title is the whole post)',
    '',
    `WHAT THE POSTER WANTS: ${gap.posterWant}`,
    `WHAT THE THREAD HAS ALREADY GIVEN THEM: ${gap.delivered || '(nothing yet)'}`,
    `THE GAP TO FILL: ${gap.angle}`,
    ...(target
      ? [
          `THE POINT ALREADY MADE BADLY (say this well; do not mention that it was said):\n${trim(target.body, 600)}`,
        ]
      : []),
    '',
    ...renderPersona(persona),
    '',
    'HOW PEOPLE WRITE HERE (measured from this thread — copy it):',
    ...renderRegister(profile, length),
    ...(opts.avoidOpenings?.length
      ? ['', `DO NOT BEGIN WITH: ${opts.avoidOpenings.slice(0, 8).map((o) => `"${o}"`).join(', ')} — this account has opened that way recently.`]
      : []),
    '',
    'ALREADY POSTED (do not repeat these):',
    renderComments(comments, opts.maxComments ?? 8),
    '',
    `Write ${n} attempts. Respond with JSON: {"candidates": [${Array.from({ length: n }, () => '"…"').join(', ')}]}`,
  ].join('\n');

  return { system: GENERATE_SYSTEM, user };
}

/** Strip the wrappers models add when told not to: code fences, list numbering,
 *  surrounding quotes, a "Candidate 2:" label. */
function unwrap(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  t = t.replace(/^(?:candidate|option|attempt)\s*\d*\s*[:.)-]\s*/i, '');
  t = t.replace(/^\d+[.)]\s+/, '');
  t = t.replace(/^[-*]\s+/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** For deduplication only — never for display or posting. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Defensive parse. Never throws; anything unusable is dropped rather than
 * repaired, and an empty array is a legitimate outcome meaning "no comment".
 *
 * NEAR-DUPLICATES ARE DROPPED. Three paraphrases of one sentence give the critic
 * a fake choice, and a fake choice reliably produces a pick — which is the exact
 * failure this system is built to avoid, since the critic's most valuable answer
 * is "none of these".
 */
export function parseCandidates(raw: unknown, max = CANDIDATE_COUNT): CommentCandidate[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { candidates?: unknown }).candidates)
      ? ((raw as { candidates: unknown[] }).candidates)
      : null;
  if (!list) return [];

  const seen = new Set<string>();
  const out: CommentCandidate[] = [];

  for (const item of list) {
    const rawText =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : null;
    if (!rawText) continue;

    const text = unwrap(rawText);
    if (!text) continue;

    const key = normalise(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    out.push({ text, words: countWords(text) });
    if (out.length >= max) break;
  }

  return out;
}
