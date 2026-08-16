// Will this start a fight?
//
// PURE. No model, no I/O.
//
// A downvoted comment costs a few points. An argument costs the account: it
// draws attention to a profile, it invites someone to read the rest of it, and
// the one thing this system cannot survive is a person deciding to look closely.
// So the bar here is not "is this defensible" but "is there any version of this
// exchange that ends well", and where the answer is unclear the comment is
// dropped — skipping is free.
//
// Disagreement is not banned. It is permitted in EXACTLY ONE SHAPE:
//
//     acknowledge the other view → add the missing piece → say why
//
// Never "you're wrong". That shape is checkable mechanically, which is why the
// rule is written this way rather than as a judgement call handed to a model.
//
// PRIORS, NOT MEASUREMENTS. Every list below is a starting position for the
// learning loop to replace, and the charged-topics list in particular is a risk
// decision belonging to the operator, not a claim about which subjects are
// legitimate. It is here because no comment an anonymous warm-up account makes
// about them earns more than it risks.

import type { ThreadComment } from '../reader/types';
import { sentencesOf } from './validate';

export type ConflictCode =
  /** u/someone, or @someone. */
  | 'names-a-person'
  /** "you clearly haven't", "OP is wrong". */
  | 'second-person-accusation'
  /** "everyone knows", "that never works" — an unwinnable claim. */
  | 'absolute'
  | 'moral-judgment'
  | 'charged-topic'
  /** Contradiction with no acknowledgement in front of it. */
  | 'blunt-contradiction'
  /** Contradiction with no reason after it. */
  | 'unexplained-disagreement'
  /** The room is already arguing. No version of entering ends well. */
  | 'hostile-thread';

export interface ConflictFailure {
  code: ConflictCode;
  detail: string;
}

const MENTION_RE = /(^|\s)(u\/[a-z0-9_-]{3,}|@[a-z0-9_-]{3,})/i;

const ACCUSATION_RE =
  /\b(you'?re (wrong|clearly|obviously|just)|you (clearly|obviously|apparently) (don'?t|didn'?t|haven'?t|have no)|you have no idea|op is (wrong|lying)|did you even read|read the post)\b/i;

// Universal quantifiers. Flagged only when nothing scopes them to the speaker —
// "I never managed it" is a story, "that never works" is a claim someone will
// arrive with a counterexample to.
const ABSOLUTE_RE = /\b(everyone|everybody|nobody|no one|always|never|objectively|obviously|anyone who)\b/i;
const SELF_SCOPE_RE = /\b(i|i'?ve|i'?m|my|me|we|our|us|for me|in my)\b/i;

const MORAL_RE =
  /\b(should be ashamed|disgusting|disgraceful|shameful|selfish|immoral|evil|pathetic|toxic|narcissist(ic)?|abusive|gaslighting|red flag|deserve(d|s) it|bad parent|terrible person)\b/i;

// Subjects where the upside is a few points and the downside is an argument in
// public on a profile we need nobody to read.
const CHARGED_RE =
  /\b(trump|biden|maga|republican|democrat|election|abortion|immigrant|immigration|deport|vaccine|anti-?vax|gun control|second amendment|israel|palestin\w+|zionist|hamas|trans(gender)?|woke|feminis[tm]|patriarchy|racis[tm]|white people|black people|muslim|christian|atheist|religion|communis[tm]|fascis[tm])\b/i;

// Sentence-initial "actually"/"nope"/"no," rather than the bare words: people
// write "I actually did that" and "there's nothing wrong with it" constantly,
// and a gate that fires on those rejects ordinary comments for being ordinary.
const CONTRADICTION_RE =
  /(^|[.!?]\s+)(actually\b|nope\b|no,)|\b(you'?re wrong|that'?s wrong|that'?s not (true|right|how it works)|not true|i disagree|that'?s nonsense|that'?s a myth|factually incorrect)\b/i;
const ACKNOWLEDGE_RE =
  /\b(fair|true|that'?s true|you'?re right|good point|makes sense|i get (it|that|why)|agreed?|i see why|in some cases|often|usually|for a lot of people)\b/i;
const REASON_RE =
  /\b(because|since|the reason|which is why|so that|in my case|when i|for me|otherwise|turns out)\b/i;

/**
 * How much of this thread is already an argument. 0..1.
 *
 * Two signals, both free from data we already hold: comments the room has
 * punished, and comments contradicting each other. Reddit's vote fuzzing means
 * a genuinely downvoted comment often shows 0 or 1 rather than a negative, so
 * this is a LOWER bound on how hot the room is, never an upper one.
 */
export function threadTemperature(comments: ThreadComment[]): number {
  if (!comments.length) return 0;
  const punished = comments.filter((c) => c.score <= 0).length;
  const arguing = comments.filter((c) => CONTRADICTION_RE.test(c.body) || ACCUSATION_RE.test(c.body)).length;
  return Math.min(1, (punished + arguing) / comments.length);
}

/** Above this, the room is having an argument rather than a conversation. */
export const MAX_TEMPERATURE = 0.3;

export function screenConflict(
  text: string,
  comments: ThreadComment[] = [],
): { ok: boolean; failures: ConflictFailure[] } {
  const failures: ConflictFailure[] = [];
  const add = (code: ConflictCode, detail: string) => failures.push({ code, detail });
  const body = text.trim();

  if (MENTION_RE.test(body)) add('names-a-person', 'names another user');
  if (ACCUSATION_RE.test(body)) add('second-person-accusation', 'tells someone what they did or did not do');
  if (MORAL_RE.test(body)) add('moral-judgment', 'passes judgement on a person');
  if (CHARGED_RE.test(body)) add('charged-topic', 'politics or identity — nothing here is worth the argument');

  for (const sentence of sentencesOf(body)) {
    const m = ABSOLUTE_RE.exec(sentence);
    if (!m) continue;
    // Only the part BEFORE the absolute can scope it: "everyone I know" is still
    // a claim about everyone, while "I have never" is a claim about one person.
    const before = sentence.slice(0, m.index);
    if (!SELF_SCOPE_RE.test(before)) {
      add('absolute', `"${m[0]}" — an unwinnable claim`);
      break;
    }
  }

  // The one permitted shape for disagreement.
  const contradiction = CONTRADICTION_RE.exec(body);
  if (contradiction) {
    const before = body.slice(0, contradiction.index);
    const after = body.slice(contradiction.index);
    if (!ACKNOWLEDGE_RE.test(before)) {
      add('blunt-contradiction', 'contradicts without acknowledging the other view first');
    }
    if (!REASON_RE.test(after)) {
      add('unexplained-disagreement', 'disagrees without saying why');
    }
  }

  const temp = threadTemperature(comments);
  if (temp > MAX_TEMPERATURE) {
    add('hostile-thread', `${Math.round(temp * 100)}% of this thread is already arguing`);
  }

  return { ok: failures.length === 0, failures };
}
