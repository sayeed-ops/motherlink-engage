// The mechanical gate: everything about a comment that can be decided by
// arithmetic and pattern matching.
//
// PURE. No model, no I/O, no clock.
//
// This exists because the expensive judgements have already been made by the
// time a comment reaches here, and a model asked "is this comment too long" or
// "does this contain a link" will sometimes say no while the link is on screen.
// Anything checkable is checked here, cheaply, deterministically, and BEFORE the
// critic call — a candidate that fails a mechanical rule is not worth paying a
// model to judge.
//
// THE LENGTH RULE IS THE ONE THAT MATTERS. It is not a preference and not a
// setting: the band comes from targetLength(), which measured the comments
// already winning in this exact thread. Writing 120 considered words into a
// thread whose top five comments are one line each is the single most reliable
// way to be invisible, and no amount of quality rescues it.
//
// NOTE ON THE WORD AND PHRASE LISTS: they are informed PRIORS, not measurements,
// and they are deliberately phrase-shaped rather than word-shaped. Banning
// common single words ("robust", "navigate", "leverage") catches ordinary people
// far more often than it catches a machine. Em dashes are deliberately NOT
// banned for the same reason — plenty of people use them, and banning
// punctuation is a game that ends with prose nobody writes.

import type { ThreadComment } from '../reader/types';
import { countWords, isConfident, type RoomProfile } from './roomProfile';

export type ValidationCode =
  | 'empty'
  /** Shorter than this room's own comments run. */
  | 'too-short'
  /** Longer than this room's own comments run — the invisible one. */
  | 'too-long'
  /** The opening does not survive being read collapsed. */
  | 'first-line-too-long'
  | 'banned-opener'
  | 'banned-closer'
  /** Phrasing that reads as an assistant rather than a commenter. */
  | 'assistant-tell'
  | 'link'
  /** A brand, product or company we would be promoting. */
  | 'brand'
  /** Bullets or headings in a room that writes plain prose. */
  | 'formatting'
  /** A number or statistic stated as general fact, which we could not defend. */
  | 'unverifiable-statistic'
  /** "Studies show…" — an appeal to a source we do not have. */
  | 'appeal-to-authority'
  /** Comments about the thread rather than in it. */
  | 'meta'
  /** Repeats a comment already in the thread. */
  | 'duplicate';

export interface Failure {
  code: ValidationCode;
  detail: string;
}

export interface ValidationContext {
  /** From targetLength(profile) — measured, never chosen. */
  length: { min: number; max: number; target: number };
  profile: RoomProfile;
  /** Brands, clients and domains this account must never mention. Account-scoped
   *  karma carries NO narrative; a brand mention here is the whole reason the
   *  growth pipeline and this system share no code. */
  bannedTerms?: string[];
  /** Comments already in the thread, to catch a candidate that restates one. */
  existing?: ThreadComment[];
}

/** A first sentence longer than this is not scannable in a collapsed comment.
 *  Scaled up for essay rooms, where 40 words in is still the first breath. */
export const FIRST_SENTENCE_MAX_WORDS = 25;

const BANNED_OPENERS: [RegExp, string][] = [
  [/^(great|good|excellent|interesting) question/i, 'flattering the poster'],
  // Genuinely used by real people — and also the single most common opener of
  // a machine claiming credentials it does not have. Cheap to lose.
  [/^as (someone|a|an) /i, 'claims a credential in the first three words'],
  [/^speaking as /i, 'claims a credential in the first three words'],
  [/^first of all/i, 'announces a list'],
  [/^(it'?s|it is) worth noting/i, 'assistant phrasing'],
  [/^i (completely|totally|fully) agree/i, 'agreement with nothing added'],
  [/^fun fact/i, 'introduces a fact we cannot defend'],
  [/^unpopular opinion/i, 'invites an argument before the first sentence'],
  [/^congratulations[,!]/i, 'reads as a template'],
  [/^i'?m sorry (to hear|for your)/i, 'the condolence template'],
];

const BANNED_CLOSERS: [RegExp, string][] = [
  [/hope (this|that) helps/i, 'assistant sign-off'],
  [/hope (this|that) (is|was) helpful/i, 'assistant sign-off'],
  [/let me know if you (have|need)/i, 'offers support nobody asked for'],
  [/feel free to (ask|reach out|dm|message)/i, 'offers support nobody asked for'],
  [/best of luck (with|on)/i, 'assistant sign-off'],
  [/you'?ve got this/i, 'reads as a greetings card'],
  [/wishing you (all the best|the best)/i, 'reads as a greetings card'],
];

const ASSISTANT_TELLS: [RegExp, string][] = [
  [/\bas an ai\b/i, 'says what it is'],
  [/\b(it'?s|it is) important to (note|remember|understand)\b/i, 'lecturing register'],
  [/\bthere are a few (things|factors) to consider\b/i, 'lecturing register'],
  [/\b(furthermore|moreover|in conclusion|firstly)\b/i, 'nobody writes essay connectives in a comment'],
  [/\bdelve into\b/i, 'not a word anyone says'],
  [/\ba testament to\b/i, 'not a phrase anyone says'],
  [/\bi'?d be happy to\b/i, 'offers a service'],
  [/\bhere (are|is) (some|a few) (tips|things|ways|options)\b/i, 'announces a list'],
];

const META_TELLS: [RegExp, string][] = [
  [/\bcommenting (so|to) (i can )?(find|save|come back)/i, 'karma-farm signature'],
  [/\bfollowing this\b/i, 'karma-farm signature'],
  [/\bremindme!/i, 'a bot command'],
  [/\bthanks for sharing\b/i, 'comments about the post, not in it'],
  [/\b(great|nice|awesome) (post|thread)\b/i, 'comments about the post, not in it'],
  [/^edit:/i, 'nothing has been edited yet'],
  [/\btl;?dr\b/i, 'summarises a comment nobody has read yet'],
];

const LINK_RE = /(https?:\/\/|www\.[a-z0-9-]|\b[a-z0-9-]{2,}\.(com|net|org|io|co|uk|de|shop|app|ai)\b)/i;
const MARKDOWN_STRUCTURE_RE = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s)|\*\*[^*]+\*\*/;

// Numbers presented as measurement, which we would be asked to source.
const SPECIFIC_RE =
  /([£$€]\s?\d|\b\d[\d,.]*\s?(%|percent|k\b|million|billion|years?|months?|weeks?|days?|hours?|minutes?|miles?|km|kg|lbs?|dollars?|pounds?|euros?)\b)/i;
const FIRST_PERSON_RE = /\b(i|i'?m|i'?ve|i'?d|i'?ll|my|me|mine|myself|we|our|us)\b/i;
const HEDGE_RE =
  /\b(i think|i reckon|i'?d say|i suspect|imo|imho|in my experience|probably|maybe|might be|i guess|seems|afaik|from what i|for me)\b/i;
const AUTHORITY_RE =
  /\b(studies (show|have shown|suggest)|research (shows|suggests)|according to|statistics show|data shows|science says|experts (say|agree)|it'?s well known|everyone knows)\b/i;

export type ClaimKind =
  /** The speaker's own experience. Defensible because it is theirs. */
  | 'experience'
  /** Flagged as an opinion, so a challenge is a conversation, not a correction. */
  | 'opinion'
  /** A measurement stated as general truth. NOT defensible — we made it up. */
  | 'fact'
  /** An ordinary conversational statement with nothing specific in it. */
  | 'assertion';

export interface Claim {
  text: string;
  kind: ClaimKind;
  /** Could we answer honestly if someone asked "where does that come from"?
   *  Going silent after being challenged looks worse than never commenting. */
  defensible: boolean;
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Classify what each sentence is claiming.
 *
 * The distinction that does the work is between a specific the speaker LIVED and
 * a specific they are ASSERTING. The design wants specifics — "six months, about
 * £200" beats "it varies" — so a rule that rejected all numbers would remove the
 * best thing a comment can contain. What it rejects is the same number with the
 * speaker taken out of it, because that version is a citation, and we have no
 * source to give when asked for one.
 */
export function extractClaims(text: string): Claim[] {
  return sentencesOf(text).map((s) => {
    if (AUTHORITY_RE.test(s)) return { text: s, kind: 'fact' as const, defensible: false };
    if (SPECIFIC_RE.test(s) && !FIRST_PERSON_RE.test(s)) {
      return { text: s, kind: 'fact' as const, defensible: false };
    }
    if (HEDGE_RE.test(s)) return { text: s, kind: 'opinion' as const, defensible: true };
    if (FIRST_PERSON_RE.test(s)) return { text: s, kind: 'experience' as const, defensible: true };
    return { text: s, kind: 'assertion' as const, defensible: true };
  });
}

/** The first sentence, which is the whole comment as far as most readers are
 *  concerned. */
export function firstSentence(text: string): string {
  return sentencesOf(text)[0] ?? '';
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Run every mechanical check. Collects ALL failures rather than stopping at the
 * first: the review panel in Phase 4 shows an operator why nothing was posted,
 * and "too long" alone hides the fact that it also linked to something.
 */
export function validateComment(text: string, ctx: ValidationContext): { ok: boolean; failures: Failure[] } {
  const failures: Failure[] = [];
  const add = (code: ValidationCode, detail: string) => failures.push({ code, detail });

  const body = text.trim();
  if (!body) return { ok: false, failures: [{ code: 'empty', detail: 'nothing to post' }] };

  // --- length: copied from this thread, never chosen -----------------------
  const words = countWords(body);
  if (words < ctx.length.min) {
    add('too-short', `${words} words, this room runs ${ctx.length.min}–${ctx.length.max}`);
  }
  if (words > ctx.length.max) {
    add('too-long', `${words} words, this room runs ${ctx.length.min}–${ctx.length.max}`);
  }

  // --- the opening ---------------------------------------------------------
  const opener = firstSentence(body);
  // Measured against the room, not a constant: 40 words in is still the first
  // breath in an essay room and a wall of text in a one-liner room.
  const openerCap = Math.max(FIRST_SENTENCE_MAX_WORDS, Math.round(ctx.length.target * 0.5));
  if (countWords(opener) > openerCap) {
    add('first-line-too-long', `first sentence is ${countWords(opener)} words, cap is ${openerCap}`);
  }
  for (const [re, why] of BANNED_OPENERS) {
    if (re.test(opener)) add('banned-opener', why);
  }

  // --- the closing ---------------------------------------------------------
  for (const [re, why] of BANNED_CLOSERS) {
    if (re.test(body)) add('banned-closer', why);
  }

  // --- register tells ------------------------------------------------------
  for (const [re, why] of ASSISTANT_TELLS) {
    if (re.test(body)) add('assistant-tell', why);
  }
  for (const [re, why] of META_TELLS) {
    if (re.test(body)) add('meta', why);
  }

  // --- links and brands ----------------------------------------------------
  if (LINK_RE.test(body)) {
    add('link', 'a young account posting links is what spam filters are for');
  }
  for (const term of ctx.bannedTerms ?? []) {
    const t = term.trim();
    if (!t) continue;
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) {
      add('brand', `mentions "${t}" — this account carries no narrative`);
    }
  }

  // --- formatting ----------------------------------------------------------
  // Only where the room has been measured well enough to say. A thin thread
  // cannot tell us that nobody here uses bullets.
  if (isConfident(ctx.profile) && ctx.profile.markdownRate < 0.15 && MARKDOWN_STRUCTURE_RE.test(body)) {
    add('formatting', 'bullets or headings in a room that writes plain prose');
  }

  // --- defensibility -------------------------------------------------------
  for (const claim of extractClaims(body)) {
    if (claim.defensible) continue;
    if (AUTHORITY_RE.test(claim.text)) {
      add('appeal-to-authority', `cites a source we do not have: "${claim.text.slice(0, 80)}"`);
    } else {
      add('unverifiable-statistic', `states a number as fact: "${claim.text.slice(0, 80)}"`);
    }
  }

  // --- saying what is already there ---------------------------------------
  const key = normalise(body);
  for (const c of ctx.existing ?? []) {
    if (normalise(c.body) === key) {
      add('duplicate', `identical to ${c.commentId}`);
      break;
    }
  }

  return { ok: failures.length === 0, failures };
}
