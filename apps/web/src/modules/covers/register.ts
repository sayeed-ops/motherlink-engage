// How this section writes — measured from the thread, never configured.
//
// PURE. No I/O, no clock, no model.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT `forum/reply/roomProfile.ts`
//
// It very nearly is, and the difference is one field that does not exist:
// COVERS HAS NO SCORES. `profileRoom()` builds its whole picture from
// `winnersOf(comments)` — the comments above the thread's own median score — and
// on Covers there is no score, no vote, no rank, and no way to tell a post the
// room liked from one it ignored. Half of that file's inputs are simply absent.
//
// The tempting move is to pass `score: 0` for every post and reuse it. That
// would work, silently, and produce a profile of "the winners" that is really a
// profile of every post in page order — a measurement-shaped object with no
// measurement in it. The reader module already refuses that trade everywhere
// else (see the honest-`unknown` convention in reader/types.ts), and this file
// refuses it too: there is no `medianWinnerWords` here because nothing here
// knows what won. There is `medianWords`, over every post, and it is labelled as
// what it is.
//
// What survives unchanged: length is COPIED, not chosen, and register is
// arithmetic rather than a judgement. Those are the two ideas worth carrying
// over, and they do not need scores.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The register measures TEXT and nothing else, so it asks for nothing else.
 *
 * Deliberately not `CoversPost`: a stored post and a freshly parsed one differ
 * in fields this file never reads, and widening the input to the one property it
 * uses is what lets it run over either without a cast that would quietly hide a
 * genuine mismatch later.
 */
export interface WrittenText {
  body: string;
}

export interface SectionRegister {
  /** Posts the profile was built from. */
  sampleSize: number;

  /**
   * The median post length in this thread.
   *
   * ⚠️ NOT `medianWinnerWords`. Covers exposes no score, so this is the middle
   * of everything written here rather than the middle of what worked. It is a
   * weaker signal than the Reddit equivalent and it is named so that nobody
   * reading a prompt built from it believes otherwise.
   */
  medianWords: number;
  p25Words: number;
  p75Words: number;

  contractionRate: number;
  profanityRate: number;
  questionRate: number;
  firstPersonRate: number;
  lowercaseOpenRate: number;
  /** Quoting is how this forum argues — `[QUOTE]` blocks and `>` lines. */
  quoteRate: number;
  markdownRate: number;

  avgSentenceWords: number;

  /** In-group vocabulary: common here, rare in ordinary English. */
  jargon: string[];
}

/** Below this the profile describes one person's habits, not a section's. */
export const MIN_SAMPLE = 5;

export const EMPTY_REGISTER: SectionRegister = {
  sampleSize: 0,
  medianWords: 0,
  p25Words: 0,
  p75Words: 0,
  contractionRate: 0,
  profanityRate: 0,
  questionRate: 0,
  firstPersonRate: 0,
  lowercaseOpenRate: 0,
  quoteRate: 0,
  markdownRate: 0,
  avgSentenceWords: 0,
  jargon: [],
};

const CONTRACTION_RE = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/i;
const FIRST_PERSON_RE = /\b(i|i'm|i've|my|me|mine|myself)\b/i;
const MARKDOWN_RE = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s)|\*\*/;
const QUOTE_RE = /(^|\n)\s*(>|\[quote)/i;
const PROFANITY_RE = /\b(fuck\w*|shit\w*|damn|hell|crap|ass|bitch\w*|piss\w*|bloody)\b/i;

const STOPWORDS = new Set(
  ('the a an and or but if then than that this these those i you he she it we they me him her them my your his its our their ' +
    'is are was were be been being am do does did doing have has had having will would can could should shall may might must ' +
    'of to in on at by for with about against between into through during before after above below from up down out off over under ' +
    'again further once here there when where why how all any both each few more most other some such no nor not only own same so ' +
    'too very s t just dont now get got go going like really think know thing things people even also because what who which')
    .split(' '),
);

export function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function countWords(text: string): number {
  return wordsOf(text).length;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

function rate(list: readonly WrittenText[], test: (body: string) => boolean): number {
  if (!list.length) return 0;
  return list.filter((p) => test(p.body)).length / list.length;
}

/** Terms common in this thread and rare in ordinary English. */
export function extractJargon(posts: readonly WrittenText[], max = 12): string[] {
  const counts = new Map<string, number>();

  for (const p of posts) {
    // Per-post uniqueness: one person's pet phrase used eight times is not the
    // section's vocabulary.
    const seen = new Set<string>();
    for (const raw of wordsOf(p.body.toLowerCase())) {
      const w = raw.replace(/[^a-z0-9'/-]/g, '');
      if (w.length < 3 || w.length > 24) continue;
      if (STOPWORDS.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      seen.add(w);
    }
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  const floor = Math.max(2, Math.ceil(posts.length * 0.15));
  return [...counts.entries()]
    .filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

/**
 * Measure a section's register from the posts of one thread.
 *
 * Every post counts, because there is no honest way to weight them. A very short
 * post ("lol same") is part of how this room writes and dropping it would be
 * choosing a register rather than measuring one — the exact substitution this
 * file exists to prevent.
 */
export function profileSection(posts: readonly WrittenText[]): SectionRegister {
  const written = posts.filter((p) => p.body.trim());
  if (written.length === 0) return EMPTY_REGISTER;

  const lengths = written.map((p) => countWords(p.body)).sort((a, b) => a - b);

  const sentenceCounts = written.map((p) => {
    const parts = p.body.split(/[.!?]+\s/).filter((s) => s.trim());
    return parts.length ? countWords(p.body) / parts.length : countWords(p.body);
  });

  return {
    sampleSize: written.length,
    medianWords: median(lengths),
    p25Words: quantile(lengths, 0.25),
    p75Words: quantile(lengths, 0.75),
    contractionRate: rate(written, (b) => CONTRACTION_RE.test(b)),
    profanityRate: rate(written, (b) => PROFANITY_RE.test(b)),
    questionRate: rate(written, (b) => b.includes('?')),
    firstPersonRate: rate(written, (b) => FIRST_PERSON_RE.test(b)),
    lowercaseOpenRate: rate(written, (b) => /^[a-z]/.test(b.trim())),
    quoteRate: rate(written, (b) => QUOTE_RE.test(b)),
    markdownRate: rate(written, (b) => MARKDOWN_RE.test(b)),
    avgSentenceWords: Math.round(sentenceCounts.reduce((a, b) => a + b, 0) / sentenceCounts.length),
    jargon: extractJargon(written),
  };
}

/**
 * The length band a reply must land inside to look native.
 *
 * Widened at both ends because p25/p75 over a handful of posts is a coarse
 * instrument, and rejecting an otherwise-good reply for being three words short
 * costs more than it saves.
 */
export function targetLength(register: SectionRegister): { min: number; max: number; target: number } {
  const target = Math.max(3, register.medianWords);
  return {
    min: Math.max(2, Math.floor(register.p25Words * 0.6)),
    max: Math.max(target + 10, Math.ceil(register.p75Words * 1.4)),
    target,
  };
}

/** Is this profile worth trusting? Below MIN_SAMPLE it describes a person. */
export function isConfident(register: SectionRegister): boolean {
  return register.sampleSize >= MIN_SAMPLE;
}

/** How many of ten, for a rate. Ten rather than a percentage because "8 of 10
 *  posts here use contractions" reads as an observation and "80%" reads as a
 *  target to hit. */
function outOfTen(rate: number): number {
  return Math.round(rate * 10);
}

/**
 * The register lines handed to the generator.
 *
 * ⚠️ EVERY LINE SAYS "POSTS", NOT "WINNING POSTS". The Reddit generator can
 * honestly say "8 of 10 winning comments use contractions" because it counted
 * winners. Here there are none to count, and a prompt that claimed otherwise
 * would be the system quietly upgrading its own evidence.
 */
export function renderRegister(
  register: SectionRegister,
  length: { min: number; max: number; target: number },
): string[] {
  const lines = [
    `- length: posts here run about ${register.medianWords} words. Write between ${length.min} and ${length.max} words.`,
  ];

  if (!isConfident(register)) {
    lines.push('- this thread is too thin to read the room from; write plainly and keep it short.');
    return lines;
  }

  lines.push(`- ${outOfTen(register.contractionRate)} of 10 posts use contractions`);
  lines.push(`- ${outOfTen(register.lowercaseOpenRate)} of 10 begin with a lowercase letter`);
  lines.push(`- ${outOfTen(register.firstPersonRate)} of 10 talk about themselves`);
  lines.push(
    register.profanityRate > 0.15 ? '- people swear here; mild swearing is normal' : '- nobody swears here',
  );
  if (register.quoteRate > 0.25) {
    lines.push('- people quote each other here before replying');
  }
  if (register.markdownRate < 0.15) {
    // The strongest single tell there is: bullet lists and bold headings in a
    // room that writes plain paragraphs read as machine output before anybody
    // has read a word of the content.
    lines.push('- plain prose only: no bullet lists, no headings, no bold');
  }
  if (register.jargon.length) {
    lines.push(`- words people use here: ${register.jargon.slice(0, 8).join(', ')}`);
  }

  return lines;
}
