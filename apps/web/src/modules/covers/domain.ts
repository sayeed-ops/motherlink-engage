// Is this something the client could ever answer — or is it just something the
// forum was talking about?
//
// PURE. No model call, no network, no clock. The gap board is free by design and
// this keeps it free: the filter runs over concepts the intent classifier has
// already returned, using vocabulary we already hold.
//
// ════════════════════════════════════════════════════════════════════════════
// THE FIRST LIVE GAP BOARD ASKED SOMEBODY TO WRITE ABOUT THE HEALTHCARE SYSTEM
//
// Phase 3 shipped a gap board with no domain filter and it produced, from real
// threads: `compassion`, `healthcare system`, `canada`. Every one of them came
// from a genuine unanswered question — the board was working exactly as built —
// and not one of them is a thing a sportsbook could ever publish an asset about.
// A board like that does not merely waste a reader's time; it actively misleads
// the person whose job is to decide what the client should write next.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THERE ARE THREE VERDICTS AND NOT TWO
//
// The obvious filter is "keep what the library recognises". It is also exactly
// wrong, and wrong in the one direction that matters: A GAP IS BY DEFINITION A
// SUBJECT THE LIBRARY HAS NO WORDS FOR. A filter that requires library evidence
// to keep a row would delete the most valuable rows on the board and leave
// behind the ones the client can already answer.
//
// So an unrecognised concept is NOT rejected. It is `unclassified`, and it is
// kept, in its own tray, with a note saying what it was seen next to. Only an
// explicit off-domain topic — politics, healthcare, immigration — produces a
// rejection, and that rejection RECORDS THE TERM THAT FIRED so a wrong one can
// be found and corrected rather than argued about. Nothing is ever silently
// discarded, because a filter whose mistakes are invisible is a filter nobody
// can fix.
// ════════════════════════════════════════════════════════════════════════════

import type { Asset } from '@/modules/knowledge/types';
import { tokenise } from '@/modules/knowledge/retrieval';
import { aliasIndex, hasLexicon } from './teams';

// ---------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------

export type DomainVerdict =
  /** The client's own vocabulary, the vertical's, or this section's sport. */
  | 'in-domain'
  /** An explicit off-domain topic fired. The only destructive verdict. */
  | 'off-domain'
  /** Nothing recognised it. KEPT — this is where a real gap looks like. */
  | 'unclassified';

/** Where the evidence came from. Shown in the UI, because "the client's own
 *  trigger list says so" and "it looks like betting jargon to us" are different
 *  strengths of claim about the same row. */
export type DomainEvidence =
  | 'library' // the client's curated triggers and problem statements
  | 'library-title' // an asset title — weaker, see WEAK below
  | 'vertical' // betting vocabulary shipped with the module
  | 'vertical-weak' // ordinary English that is domain-bearing only in company
  | 'sport' // a team or league name for this section's sport
  | 'off-domain-topic' // an explicit rejection list entry
  | 'post-topic' // the POST it came from was off-domain — see rulePost
  | 'none';

export interface ConceptRuling {
  concept: string;
  verdict: DomainVerdict;
  evidence: DomainEvidence;
  /** The terms that fired, verbatim. The whole point of recording this is that a
   *  bad filtering decision can be looked at rather than only disputed. */
  matched: string[];
  /** One sentence a person can read and disagree with. */
  reason: string;
  /** For an off-domain ruling: which topic. Null otherwise. */
  topic: OffDomainTopic | null;
}

// ---------------------------------------------------------------------------
// Off-domain topics — the only destructive list in the file
// ---------------------------------------------------------------------------

/**
 * Subjects no sportsbook publishes assets about.
 *
 * ⚠️ WHAT IS DELIBERATELY *NOT* HERE:
 *
 *   - GAMBLING HARM. "addiction", "self-exclusion", "deposit limits" look
 *     off-topic and are the opposite: responsible-gambling material is exactly
 *     the kind of asset a regulated client publishes, and a genuine gap in it is
 *     a finding worth acting on. Harm DISCLOSURES never reach this file anyway —
 *     `complaint` routing takes them out of the pipeline entirely, upstream.
 *   - PLACE NAMES. "canada" appeared on the first live board and it is tempting
 *     to reject it. But "is this available in Canada" is a real question about a
 *     licensed operator, and rejecting geography would delete it. A bare place
 *     name is `unclassified`, which is the honest answer: we do not know what
 *     was being asked about it.
 *   - ANYTHING MERELY UNFAMILIAR. Unfamiliar is what `unclassified` is for.
 *
 * Everything on this list is a subject where the client answering would be
 * strange, not merely unlikely.
 */
export type OffDomainTopic =
  | 'politics'
  | 'healthcare'
  | 'immigration'
  | 'religion'
  | 'war'
  | 'crime'
  | 'personal-life'
  | 'employment'
  | 'consumer-tech';

export const OFF_DOMAIN_TOPIC_LABEL: Record<OffDomainTopic, string> = {
  politics: 'Politics and government',
  healthcare: 'Healthcare and medicine',
  immigration: 'Immigration',
  religion: 'Religion',
  war: 'War and the military',
  crime: 'Crime and policing',
  'personal-life': 'Personal and family life',
  employment: 'Jobs and careers',
  'consumer-tech': 'Consumer technology',
};

/**
 * Phrase-shaped, not word-shaped — the same lesson validate.ts records about
 * banned words. "trump" alone would reject a post about a trump card; "vote"
 * alone would reject "vote for the best prop of the week". Every entry here is
 * either a phrase or a word with no ordinary betting reading.
 */
const OFF_DOMAIN: { term: string; topic: OffDomainTopic }[] = [
  // politics
  { term: 'politics', topic: 'politics' },
  { term: 'political', topic: 'politics' },
  { term: 'president', topic: 'politics' },
  { term: 'presidential', topic: 'politics' },
  { term: 'congress', topic: 'politics' },
  { term: 'senate', topic: 'politics' },
  { term: 'republican', topic: 'politics' },
  { term: 'democrat', topic: 'politics' },
  { term: 'democrats', topic: 'politics' },
  { term: 'liberal', topic: 'politics' },
  { term: 'conservative party', topic: 'politics' },
  { term: 'government policy', topic: 'politics' },
  { term: 'foreign policy', topic: 'politics' },
  { term: 'tariff', topic: 'politics' },
  { term: 'tariffs', topic: 'politics' },

  // healthcare
  { term: 'healthcare', topic: 'healthcare' },
  { term: 'health care', topic: 'healthcare' },
  { term: 'healthcare system', topic: 'healthcare' },
  { term: 'health insurance', topic: 'healthcare' },
  { term: 'medicare', topic: 'healthcare' },
  { term: 'medicaid', topic: 'healthcare' },
  { term: 'hospital', topic: 'healthcare' },
  { term: 'doctors', topic: 'healthcare' },
  { term: 'cancer', topic: 'healthcare' },
  { term: 'vaccine', topic: 'healthcare' },
  { term: 'prescription', topic: 'healthcare' },

  // immigration
  { term: 'immigration', topic: 'immigration' },
  { term: 'immigrant', topic: 'immigration' },
  { term: 'immigrants', topic: 'immigration' },
  { term: 'illegal immigrants', topic: 'immigration' },
  { term: 'deportation', topic: 'immigration' },
  { term: 'border security', topic: 'immigration' },
  { term: 'asylum', topic: 'immigration' },

  // religion
  { term: 'religion', topic: 'religion' },
  { term: 'religious', topic: 'religion' },
  { term: 'christianity', topic: 'religion' },
  { term: 'islam', topic: 'religion' },
  { term: 'church', topic: 'religion' },
  { term: 'the bible', topic: 'religion' },

  // war
  { term: 'war', topic: 'war' },
  { term: 'ukraine', topic: 'war' },
  { term: 'gaza', topic: 'war' },
  { term: 'israel', topic: 'war' },
  { term: 'military', topic: 'war' },
  { term: 'nuclear', topic: 'war' },

  // crime
  { term: 'shooting', topic: 'crime' },
  { term: 'murder', topic: 'crime' },
  { term: 'homicide', topic: 'crime' },
  { term: 'police brutality', topic: 'crime' },
  { term: 'prison', topic: 'crime' },
  { term: 'gun control', topic: 'crime' },

  // personal life
  { term: 'compassion', topic: 'personal-life' },
  { term: 'my marriage', topic: 'personal-life' },
  { term: 'divorce', topic: 'personal-life' },
  { term: 'girlfriend', topic: 'personal-life' },
  { term: 'boyfriend', topic: 'personal-life' },
  { term: 'my kids', topic: 'personal-life' },
  { term: 'funeral', topic: 'personal-life' },
  { term: 'dating', topic: 'personal-life' },

  // employment
  { term: 'my job', topic: 'employment' },
  { term: 'job interview', topic: 'employment' },
  { term: 'resume', topic: 'employment' },
  { term: 'my boss', topic: 'employment' },
  { term: 'unemployment', topic: 'employment' },
  { term: 'minimum wage', topic: 'employment' },

  // consumer tech
  { term: 'iphone', topic: 'consumer-tech' },
  { term: 'android phone', topic: 'consumer-tech' },
  { term: 'laptop', topic: 'consumer-tech' },
  { term: 'operating system', topic: 'consumer-tech' },
  { term: 'social media', topic: 'consumer-tech' },
];

// ---------------------------------------------------------------------------
// The vertical's own vocabulary
// ---------------------------------------------------------------------------

/**
 * Betting language with no ordinary English reading. A single one of these is
 * enough to call a concept in-domain.
 *
 * This is a lexicon for the VERTICAL, not for a client. It is what lets the
 * board keep "same game parlay" for a client whose library has never heard of
 * one — which is precisely the row a gap board exists to surface.
 */
export const VERTICAL_STRONG: readonly string[] = [
  // markets and prices
  'moneyline', 'money line', 'puckline', 'puck line', 'runline', 'run line',
  'point spread', 'against the spread', 'ats', 'handicap', 'asian handicap',
  'juice', 'vig', 'vigorish', 'overround', 'closing line', 'closing line value',
  'clv', 'line movement', 'opening line', 'steam move', 'reverse line movement',
  'alt line', 'alternate line', 'buy points', 'key numbers', 'half point',
  'first half line', 'second half line', 'live odds', 'in play odds',

  // bet types
  'parlay', 'parlays', 'accumulator', 'teaser', 'teasers', 'pleaser',
  'same game parlay', 'sgm', 'round robin', 'prop bet', 'player prop',
  'futures bet', 'outright', 'each way', 'in play betting', 'live betting',
  'hedging a bet', 'arbitrage betting', 'middling', 'bet slip', 'betslip',

  // operators and accounts
  'sportsbook', 'sportsbooks', 'bookmaker', 'bookmakers', 'bookie',
  'offshore book', 'betting exchange', 'oddsmaker', 'oddsmakers',
  'limited account', 'account limited', 'bet limits', 'stake limits',
  'kyc', 'know your customer', 'geolocation', 'self exclusion',
  'responsible gambling', 'deposit limit', 'wagering requirement', 'rollover',
  'free bet', 'freebet', 'odds boost', 'profit boost', 'deposit bonus',
  'welcome bonus', 'reload bonus', 'no deposit bonus', 'cashback',
  'cashout', 'cash out', 'early cashout', 'partial cashout',
  'withdrawal', 'withdrawals', 'payout speed', 'chargeback',

  // craft
  'handicapping', 'handicapper', 'cappers', 'bankroll', 'bankroll management',
  'expected value', 'positive ev', 'plus ev', 'hit rate', 'sharp money',
  'square money', 'public money', 'betting consensus', 'betting model',
  'bet tracker', 'betting units', 'unit size', 'sharps', 'chalk', 'dog money',
  'parlay calculator', 'odds calculator', 'implied probability', 'devigging',
  'push', 'graded', 'settled bet', 'voided bet', 'market suspended',
] as const;

/**
 * Ordinary English that is domain-bearing only in company.
 *
 * ⚠️ ONE OF THESE ALONE DOES NOT CLASSIFY ANYTHING. "line", "book", "unit",
 * "edge" and "model" are all perfectly ordinary words, and a lexicon that reads
 * "book" as a sportsbook will call a thread about a novel in-domain. Two of them
 * together, or one alongside a strong term, is evidence; one on its own leaves
 * the concept `unclassified`, where a person can look at it.
 *
 * The same strong/weak split entities.ts already applies to team abbreviations,
 * for the same reason and with the same failure behind it.
 */
export const VERTICAL_WEAK: readonly string[] = [
  'odds', 'line', 'lines', 'spread', 'total', 'totals', 'over', 'under',
  'bet', 'bets', 'betting', 'wager', 'wagers', 'book', 'books', 'stake',
  'unit', 'units', 'edge', 'model', 'projection', 'projections', 'record',
  'pick', 'picks', 'ticket', 'slip', 'market', 'markets', 'price', 'pricing',
  'bonus', 'promo', 'promotion', 'deposit', 'payout', 'bankroll', 'roi',
  'favorite', 'favourite', 'underdog', 'dog', 'cover', 'covers', 'fade',
  'tail', 'lock', 'juice', 'hedge', 'prop', 'props', 'futures', 'streak',
] as const;

// ---------------------------------------------------------------------------
// The lexicon
// ---------------------------------------------------------------------------

export interface DomainLexicon {
  /** Curated by a person for this client: asset triggers and problem
   *  statements. The strongest evidence available, because somebody typed it. */
  library: PhraseSet;
  /** Asset TITLES. Weak, matching retrieval.ts's own weighting — a title word
   *  is an accident of naming, a trigger is a statement of intent. */
  libraryTitles: PhraseSet;
  vertical: PhraseSet;
  verticalWeak: PhraseSet;
  /** Team and league names for this section's sport. Empty and honest when we
   *  have no lexicon for the league — see teams.ts. */
  sport: PhraseSet;
  /** True when the section's sport has a team lexicon at all. A soccer section
   *  yields no teams, and that is ignorance rather than absence. */
  sportKnown: boolean;
  offDomain: { tokens: string[]; term: string; topic: OffDomainTopic }[];
}

/** A phrase list pre-tokenised once. Every phrase must have all its tokens
 *  present to match — the same rule retrieval.ts applies to a trigger. */
export interface PhraseSet {
  phrases: { tokens: string[]; term: string }[];
}

function phraseSet(terms: Iterable<string>): PhraseSet {
  const seen = new Set<string>();
  const phrases: { tokens: string[]; term: string }[] = [];

  for (const term of terms) {
    const tokens = tokenise(term);
    if (tokens.length === 0) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push({ tokens, term: term.trim() });
  }

  return { phrases };
}

export interface DomainLexiconInput {
  /** Active assets only. A retired asset's vocabulary is not this client's
   *  domain any more, and a draft one is not yet anybody's decision. */
  assets: readonly Asset[];
  /** The section's sport, for team names. Null for a general section. */
  sport: string | null;
  /** Terms an operator has added by hand, treated as strongly as the library —
   *  because a person typed them for this client, which is the same act. */
  extra?: readonly string[];
}

/**
 * The client's domain, assembled from what we already hold.
 *
 * THE CLIENT'S OWN LIBRARY IS THE PRIMARY DEFINITION, and that is the design
 * rather than a convenience: a payroll client and a sportsbook would both get a
 * correct board from this function with no code change, because the vocabulary
 * that decides is theirs. The shipped vertical list is a floor under a thin
 * library, not the authority.
 */
export function buildDomainLexicon(input: DomainLexiconInput): DomainLexicon {
  const library: string[] = [];
  const titles: string[] = [];

  for (const asset of input.assets) {
    if (asset.status !== 'active') continue;
    library.push(...asset.triggers, ...asset.problems);
    titles.push(asset.title);
  }
  library.push(...(input.extra ?? []));

  const sportTerms = input.sport && hasLexicon(input.sport)
    ? aliasIndex(input.sport)
        // Weak aliases are two- and three-letter abbreviations that collide with
        // ordinary English — the `NO` / `WAS` failure entities.ts records. A
        // concept is a short phrase with no surrounding sentence to corroborate
        // against, so there is nothing here that could rescue one.
        .filter((a) => a.strength === 'strong')
        .map((a) => a.alias)
    : [];

  return {
    library: phraseSet(library),
    libraryTitles: phraseSet(titles),
    vertical: phraseSet(VERTICAL_STRONG),
    verticalWeak: phraseSet(VERTICAL_WEAK),
    sport: phraseSet(sportTerms),
    sportKnown: hasLexicon(input.sport),
    offDomain: OFF_DOMAIN.map((o) => ({ tokens: tokenise(o.term), term: o.term, topic: o.topic })).filter(
      (o) => o.tokens.length > 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// Ruling one concept
// ---------------------------------------------------------------------------

/** Every phrase in `set` all of whose tokens appear in `haystack`. */
function hits(set: PhraseSet, haystack: Set<string>): string[] {
  return set.phrases.filter((p) => p.tokens.every((t) => haystack.has(t))).map((p) => p.term);
}

/**
 * What is this concept, to this client?
 *
 * ORDER MATTERS AND IS NOT AN OPTIMISATION. The off-domain check runs FIRST,
 * before any evidence that would keep the row, because "healthcare system"
 * tokenises to `healthcare`, `system` and a client with an asset about "system
 * requirements" would otherwise pull it in on the word `system`. A rejection
 * list that can be outvoted by an accidental token overlap is not a rejection
 * list.
 */
export function ruleConcept(concept: string, lex: DomainLexicon): ConceptRuling {
  const tokens = new Set(tokenise(concept));

  const base = { concept, matched: [] as string[], topic: null as OffDomainTopic | null };

  if (tokens.size === 0) {
    return {
      ...base,
      verdict: 'unclassified',
      evidence: 'none',
      reason: 'Nothing left to read once ordinary words were removed.',
    };
  }

  // --- 1. the rejection list ------------------------------------------------
  const off = lex.offDomain.filter((o) => o.tokens.every((t) => tokens.has(t)));
  if (off.length > 0) {
    const topics = [...new Set(off.map((o) => o.topic))];
    return {
      concept,
      verdict: 'off-domain',
      evidence: 'off-domain-topic',
      matched: off.map((o) => o.term),
      topic: topics[0],
      reason: `${OFF_DOMAIN_TOPIC_LABEL[topics[0]]} — matched "${off[0].term}". No client asset could answer this.`,
    };
  }

  // --- 2. the client's own words -------------------------------------------
  const fromLibrary = hits(lex.library, tokens);
  if (fromLibrary.length > 0) {
    return {
      ...base,
      verdict: 'in-domain',
      evidence: 'library',
      matched: fromLibrary,
      reason: `The client's library uses this language — matched "${fromLibrary[0]}".`,
    };
  }

  // --- 3. the vertical ------------------------------------------------------
  const fromVertical = hits(lex.vertical, tokens);
  if (fromVertical.length > 0) {
    return {
      ...base,
      verdict: 'in-domain',
      evidence: 'vertical',
      matched: fromVertical,
      reason: `Betting vocabulary — matched "${fromVertical[0]}".`,
    };
  }

  // --- 4. this section's teams ---------------------------------------------
  const fromSport = hits(lex.sport, tokens);
  if (fromSport.length > 0) {
    return {
      ...base,
      verdict: 'in-domain',
      evidence: 'sport',
      matched: fromSport,
      reason: `Names a team in this section's sport — "${fromSport[0]}".`,
    };
  }

  // --- 5. weak evidence, which is only evidence in company -----------------
  const weak = hits(lex.verticalWeak, tokens);
  const fromTitle = hits(lex.libraryTitles, tokens);
  const supporting = [...new Set([...weak, ...fromTitle])];

  if (supporting.length >= 2) {
    return {
      ...base,
      verdict: 'in-domain',
      evidence: weak.length >= 2 ? 'vertical-weak' : 'library-title',
      matched: supporting,
      reason: `Two ordinary words that are domain-bearing together — "${supporting.slice(0, 2).join('", "')}".`,
    };
  }

  if (supporting.length === 1) {
    return {
      ...base,
      verdict: 'unclassified',
      evidence: 'none',
      matched: supporting,
      // Said plainly, because this is the case a reader most needs to
      // understand: we saw something, and one ordinary word is not enough.
      reason: `Only "${supporting[0]}" was recognised, and on its own it is an ordinary English word.`,
    };
  }

  return {
    ...base,
    verdict: 'unclassified',
    evidence: 'none',
    reason: 'Nothing in the library, the betting vocabulary or this section recognised it.',
  };
}

// ---------------------------------------------------------------------------
// Ruling a post's concepts together
// ---------------------------------------------------------------------------

/**
 * Rule every concept from ONE post, letting the post decide its outliers.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE POST IS THE UNIT OF SUBJECT, NOT THE CONCEPT
 *
 * `compassion` on the first live board came out of a political argument about
 * healthcare and immigration. Judged alone it is an abstract noun; judged next
 * to its siblings it is obviously part of an off-domain conversation. So: when a
 * post has an off-domain concept and NOTHING in domain, every concept from that
 * post is off-domain, and each one records the sibling that decided it.
 *
 * The converse is deliberately NOT symmetrical. An in-domain sibling never
 * promotes an unclassified concept — "is betting on the election legal" is a
 * real betting question containing a real off-domain word, and quietly relabelling
 * `election` as in-domain because `betting` sat beside it would be the filter
 * inventing evidence. Promotion needs a reason of its own; rejection is allowed
 * to read the room.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function rulePost(concepts: readonly string[], lex: DomainLexicon): ConceptRuling[] {
  const rulings = concepts.map((c) => ruleConcept(c, lex));

  const anyInDomain = rulings.some((r) => r.verdict === 'in-domain');
  const offDomain = rulings.filter((r) => r.verdict === 'off-domain');

  if (anyInDomain || offDomain.length === 0) return rulings;

  const decider = offDomain[0];

  return rulings.map((r) =>
    r.verdict === 'unclassified'
      ? {
          ...r,
          verdict: 'off-domain' as const,
          evidence: 'post-topic' as const,
          topic: decider.topic,
          matched: decider.matched,
          reason: `The post it came from is about ${OFF_DOMAIN_TOPIC_LABEL[decider.topic!].toLowerCase()} — it also raised "${decider.concept}".`,
        }
      : r,
  );
}
