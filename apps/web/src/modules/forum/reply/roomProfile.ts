// What this room rewards — measured, never configured.
//
// PURE. No 'server-only', no I/O, no clock. Tested directly.
//
// The design rule this file exists to serve: LENGTH IS COPIED, NOT CHOSEN. A
// system that decides "this should be a thorough answer" writes 120 words into a
// thread whose top five comments are one line each, and sinks. So the target
// length comes from the comments that are ALREADY WINNING in this exact thread,
// and everything else about register comes from the same place.
//
// Nothing here asks a model anything. Whether a room wants jokes or answers is a
// judgement and lives in ./gaps.ts; how long, how formal, how profane and which
// words are in-group are all arithmetic, and arithmetic is cheaper, faster and
// does not hallucinate.

import type { ThreadComment } from '../reader/types';

export interface RoomProfile {
  /** Comments the profile was built from. Low numbers mean low confidence — see
   *  MIN_SAMPLE. */
  sampleSize: number;

  /** THE number. Match this and you are the right size for the room. */
  medianWinnerWords: number;
  /** The band a reply should land inside; the median alone hides the spread
   *  between a one-liner sub and an essay sub. */
  p25Words: number;
  p75Words: number;

  /** 0..1, measured over winners. */
  contractionRate: number;
  profanityRate: number;
  emojiRate: number;
  questionRate: number;
  firstPersonRate: number;
  lowercaseOpenRate: number;
  markdownRate: number;

  avgSentenceWords: number;

  /** In-group vocabulary: terms common here and rare in ordinary English.
   *  Using these correctly is the cheapest "I belong here" signal available. */
  jargon: string[];

  /** What got PUNISHED. More informative than the winners, because failure here
   *  is usually about tone rather than content. */
  negative: {
    count: number;
    medianWords: number;
  };
}

/** Below this the profile is one person's habits, not a room's culture. */
export const MIN_SAMPLE = 4;

const CONTRACTION_RE = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const FIRST_PERSON_RE = /\b(i|i'm|i've|my|me|mine|myself)\b/i;
const MARKDOWN_RE = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>)|\*\*|\bhttps?:\/\//;
// Deliberately small and mild. This measures REGISTER — does this room swear at
// all — not content, so it needs breadth of usage rather than a slur list.
const PROFANITY_RE = /\b(fuck\w*|shit\w*|damn|hell|crap|ass|bitch\w*|piss\w*|bloody)\b/i;

const STOPWORDS = new Set(
  ('the a an and or but if then than that this these those i you he she it we they me him her them my your his its our their ' +
    'is are was were be been being am do does did doing have has had having will would can could should shall may might must ' +
    'of to in on at by for with about against between into through during before after above below from up down out off over under ' +
    'again further once here there when where why how all any both each few more most other some such no nor not only own same so ' +
    'too very s t just dont now get got go going like really think know thing things people even also because what who which')
    .split(' '),
);

/** THE word counter for the whole system.
 *
 *  Exported rather than kept private because the length band is derived here and
 *  enforced in ./validate.ts. Two different counters would let a comment
 *  measured at 9 words be validated at 11 and rejected against a band its own
 *  measurement produced. */
export function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function countWords(text: string): number {
  return wordsOf(text).length;
}

const words = wordsOf;

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

function rate(list: ThreadComment[], test: (body: string) => boolean): number {
  if (!list.length) return 0;
  return list.filter((c) => test(c.body)).length / list.length;
}

/**
 * Which comments count as "winning" here.
 *
 * Above the thread's own median score, not an absolute cut-off: 12 points is a
 * triumph in a small sub and invisible in a default one, and this file must work
 * in both without being told which it is.
 */
export function winnersOf(comments: ThreadComment[]): ThreadComment[] {
  const scored = comments.filter((c) => c.body.trim());
  if (scored.length <= MIN_SAMPLE) return scored;
  const med = median([...scored.map((c) => c.score)].sort((a, b) => a - b));
  const above = scored.filter((c) => c.score > med);
  // Fall back only when the split produced (almost) nothing — which happens when
  // every score ties, common on a young thread. NOT when the winners are merely
  // few: three clear winners out of six is a real signal about the room, and
  // treating "few winners" as "no winners" would silently profile the losers
  // alongside them. How much to trust a small sample is a separate question,
  // reported through sampleSize and isConfident().
  return above.length >= 2 ? above : scored;
}

/** Terms common here and rare in ordinary English. */
export function extractJargon(comments: ThreadComment[], max = 12): string[] {
  const counts = new Map<string, number>();
  for (const c of comments) {
    // Per-comment uniqueness: one person using their pet phrase eight times is
    // not the room's vocabulary.
    const seen = new Set<string>();
    for (const raw of words(c.body.toLowerCase())) {
      const w = raw.replace(/[^a-z0-9'/-]/g, '');
      if (w.length < 3 || w.length > 24) continue;
      if (STOPWORDS.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      seen.add(w);
    }
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  const floor = Math.max(2, Math.ceil(comments.length * 0.15));
  return [...counts.entries()]
    .filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** Measure a room from one thread's top-level comments. */
export function profileRoom(comments: ThreadComment[]): RoomProfile {
  const winners = winnersOf(comments);
  const lengths = winners.map((c) => words(c.body).length).sort((a, b) => a - b);

  const sentenceCounts = winners.map((c) => {
    const parts = c.body.split(/[.!?]+\s/).filter((s) => s.trim());
    return parts.length ? words(c.body).length / parts.length : words(c.body).length;
  });

  // Score <= 0 is the punished set. Reddit's fuzzing means a genuinely
  // downvoted comment often sits at 0 or 1 rather than negative, so this is a
  // lower bound on how much a room dislikes something, never an upper one.
  const negative = comments.filter((c) => c.score <= 0 && c.body.trim());
  const negLengths = negative.map((c) => words(c.body).length).sort((a, b) => a - b);

  return {
    sampleSize: winners.length,
    medianWinnerWords: median(lengths),
    p25Words: quantile(lengths, 0.25),
    p75Words: quantile(lengths, 0.75),
    contractionRate: rate(winners, (b) => CONTRACTION_RE.test(b)),
    profanityRate: rate(winners, (b) => PROFANITY_RE.test(b)),
    emojiRate: rate(winners, (b) => EMOJI_RE.test(b)),
    questionRate: rate(winners, (b) => b.includes('?')),
    firstPersonRate: rate(winners, (b) => FIRST_PERSON_RE.test(b)),
    lowercaseOpenRate: rate(winners, (b) => /^[a-z]/.test(b.trim())),
    markdownRate: rate(winners, (b) => MARKDOWN_RE.test(b)),
    avgSentenceWords: sentenceCounts.length
      ? Math.round(sentenceCounts.reduce((a, b) => a + b, 0) / sentenceCounts.length)
      : 0,
    jargon: extractJargon(winners),
    negative: { count: negative.length, medianWords: median(negLengths) },
  };
}

/**
 * The length band a reply must land inside to look native.
 *
 * Widened by a few words at each end because p25/p75 from a handful of comments
 * is a coarse instrument, and a validator that rejects an otherwise-good reply
 * for being three words long costs more than it saves.
 */
export function targetLength(profile: RoomProfile): { min: number; max: number; target: number } {
  const target = Math.max(3, profile.medianWinnerWords);
  return {
    min: Math.max(2, Math.floor(profile.p25Words * 0.6)),
    max: Math.max(target + 10, Math.ceil(profile.p75Words * 1.4)),
    target,
  };
}

/** Is this profile worth trusting? Below MIN_SAMPLE it describes a person. */
export function isConfident(profile: RoomProfile): boolean {
  return profile.sampleSize >= MIN_SAMPLE;
}
