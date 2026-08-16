// The second pass: choose one of the written comments, or none of them.
//
// PURE — prompt and parser, like ./gaps.ts and ./generate.ts.
//
// SEPARATE FROM GENERATION ON PURPOSE. A model asked to write three comments and
// then pick its favourite will pick one every time; it has just spent its effort
// on them and the question "which is best" contains the assumption that one is.
// A fresh call whose entire job is to judge can answer "none", and "none" is the
// outcome this system needs most — skipping is normal, filler is what gets an
// account spotted.
//
// The critic is also the LAST place a human judgement is made. Everything after
// it is arithmetic (./validate.ts, ./conflict.ts, ./botTell.ts), so this prompt
// carries the questions arithmetic cannot answer: does it actually fill the gap,
// and does it sound like a person who belongs in this room.

import type { ThreadSnapshot } from '../reader/types';
import type { CommentCandidate } from './generate';
import type { GapAnalysis } from './gaps';
import type { RoomProfile } from './roomProfile';

export interface CriticVerdict {
  /** Index into the candidate array, or null for "none of these". */
  chosenIndex: number | null;
  /** Why. Empty means we did not understand the answer, and an answer we did
   *  not understand is not a licence to post. */
  reason: string;
}

/** No candidate chosen. Not a failure — the expected outcome most of the time. */
export const NO_CHOICE: CriticVerdict = { chosenIndex: null, reason: '' };

export const CRITIC_SYSTEM = `You are choosing between Reddit comments that have already been written, for a thread you are shown. You are NOT writing or rewriting anything.

Choose the ONE that would earn upvotes in this specific room, or choose none.

Judge on:
- Does it fill the stated gap, or does it answer a question nobody asked? Someone venting does not want advice, and advice they did not ask for is the most common way a comment is ignored.
- Would the first sentence make someone stop scrolling? Comments are read collapsed.
- Does it sound like a person who is already in this room, or like someone performing being helpful?
- Could every claim in it be defended honestly if challenged?
- Does it risk starting an argument?

CHOOSE NONE FREELY. It is the right answer more often than not. A comment that is merely fine is not worth posting: saying nothing costs this account nothing, and a comment that lands flat is one more piece of evidence that the account is not a person. Do not pick the least bad one — if none of them would earn an upvote, choose none.

Do not rewrite, improve, combine or edit any candidate. Your only outputs are a number and a reason.

Output STRICT JSON: {"chosen": <number or null>, "reason": "<one sentence>"}. No prose, no markdown.`;

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function buildCriticPrompt(
  candidates: CommentCandidate[],
  thread: ThreadSnapshot,
  gap: GapAnalysis,
  profile: RoomProfile,
): { system: string; user: string } {
  const { post, comments } = thread;

  const user = [
    `SUBREDDIT: r/${post.subreddit}`,
    `TITLE: ${trim(post.title, 300)}`,
    post.body.trim() ? `BODY: ${trim(post.body, 1200)}` : 'BODY: (none — the title is the whole post)',
    '',
    `WHAT THE POSTER WANTS: ${gap.posterWant}`,
    `THE GAP THESE WERE WRITTEN TO FILL: ${gap.angle}`,
    `THE COMMENTS WINNING HERE RUN ABOUT ${profile.medianWinnerWords} WORDS.`,
    '',
    'TOP COMMENTS ALREADY POSTED:',
    comments.length
      ? comments
          .slice(0, 5)
          .map((c, i) => `[${i + 1}] score=${c.score}\n${trim(c.body, 300)}`)
          .join('\n\n')
      : '(no comments yet)',
    '',
    'CANDIDATES:',
    // Numbered from 1, and the model answers with that number. Zero-based
    // indexing between a prompt and a parser is a bug waiting to be written:
    // an off-by-one here does not throw, it posts a comment nobody chose.
    ...candidates.map((c, i) => `(${i + 1}) [${c.words} words]\n${c.text}`),
    '',
    'Respond with JSON: {"chosen": <the number of the candidate, or null>, "reason": "<one sentence>"}',
  ].join('\n\n');

  return { system: CRITIC_SYSTEM, user };
}

/**
 * Defensive parse. Never throws.
 *
 * `count` is the number of candidates actually offered, and out-of-range is a
 * SKIP rather than a clamp. Clamping would post a comment the critic did not
 * choose, which is worse than posting nothing — and a number outside the range
 * means the answer was not about these candidates at all.
 */
export function parseCriticVerdict(raw: unknown, count: number): CriticVerdict {
  if (!raw || typeof raw !== 'object') return NO_CHOICE;
  const o = raw as Record<string, unknown>;

  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';

  const n = typeof o.chosen === 'number' ? o.chosen : null;
  if (n === null || !Number.isInteger(n) || n < 1 || n > count) {
    // Includes the explicit null: "none of these", the answer we want to be easy
    // to give. The reason is kept either way, because "none, they all read as
    // advice to someone who was venting" is exactly what the review panel and
    // the learning loop need to see.
    return { chosenIndex: null, reason };
  }

  // A choice with no reason is not a choice we can check, and this is the last
  // judgement before an account's reputation is spent. Same rule as an empty
  // `angle` collapsing to 'none' in gaps.ts.
  if (!reason) return NO_CHOICE;

  return { chosenIndex: n - 1, reason };
}

/** Resolve a verdict against the candidates it was made about.
 *
 *  Takes the text from OUR array, never from the model's response — a critic
 *  that returns a rewritten `text` field has quietly bypassed every generation
 *  constraint and every gate that ran on the original. */
export function chosenCandidate(
  verdict: CriticVerdict,
  candidates: CommentCandidate[],
): CommentCandidate | null {
  if (verdict.chosenIndex === null) return null;
  return candidates[verdict.chosenIndex] ?? null;
}
