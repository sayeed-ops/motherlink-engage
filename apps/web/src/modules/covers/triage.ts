// One post, from a harvested thread to a ranked opportunity — or to a recorded
// reason it is not one.
//
// PURE and dependency-injected: the intent call arrives as a function, so the
// whole funnel is testable without a network or a model. Same shape as the
// Reddit pipeline, for the same reason.
//
// ════════════════════════════════════════════════════════════════════════════
// COST ORDER IS THE DESIGN, NOT AN OPTIMISATION
//
//   1. FREE      section role, thread age, our footprint, jurisdiction
//   2. PAID      one intent call, on what survived
//   3. FREE      complaint routing, retrieval, the variant mask, scoring
//
// The paid step sits between two free ones on purpose. Everything that can be
// known without money is known first, and everything that only needs the
// intent's OUTPUT — whether a variant is eligible, whether the library covers
// it — happens after, without a second call.
//
// The result: nothing is generated that could not have been posted, and nothing
// is classified that was never going to be replied to.
// ════════════════════════════════════════════════════════════════════════════

import type { Asset } from '@/modules/knowledge/types';
import { retrieve, hasMatch, type RetrievalResult } from '@/modules/knowledge/retrieval';
import type { CoversPost } from './parse';
import type { CoversSection } from './sections';
import { screen, type Footprint, type ScreenLimits, type ScreenReason, type ScreenVerdict } from './screen';
import {
  checkJurisdiction,
  variantEligibility,
  anyVariantEligible,
  type JurisdictionPolicy,
  type JurisdictionVerdict,
  type VariantEligibility,
  type EligibilityVerdict,
} from './policy';
import { isDraftable, UNREADABLE, type IntentReading } from './intent';
import { rulePost, type ConceptRuling, type DomainLexicon, type DomainVerdict } from './domain';

/**
 * Why an opportunity stopped, if it did.
 *
 * Deliberately NOT collapsed into "rejected". The gap board is built from these:
 * `no-asset-match` is unmet demand and a finding about the library, while
 * `screened` is a fact about the thread and tells us nothing about the client.
 */
export type TriageOutcome =
  | 'opportunity' // survived everything
  | 'screened' // a free rejection
  | 'jurisdiction' // prohibited, hard
  | 'complaint' // left the marketing pipeline entirely
  | 'not-draftable' // banter, or nothing asked
  | 'unreadable' // the classifier could not be believed
  | 'no-variant' // nothing may be said here
  | 'no-asset-match' // the client has nothing to say — a GAP
  | 'budget'; // the paid call was never attempted — NOT a finding

export const OUTCOME_LABEL: Record<TriageOutcome, string> = {
  opportunity: 'Opportunity',
  screened: 'Screened out',
  jurisdiction: 'Prohibited jurisdiction',
  complaint: 'Complaint — routed out',
  'not-draftable': 'Nothing to answer',
  unreadable: 'Could not be read',
  'no-variant': 'Nothing may be said here',
  'no-asset-match': 'No asset covers this',
  budget: 'Not examined — the run hit its budget',
};

/** A triaged post is `analyses/{id}` in the data model. */
export interface Triage {
  postId: string;
  itemId: string;
  section: string;
  outcome: TriageOutcome;
  /** Every free rejection that fired, when it did. */
  screenReasons: ScreenReason[];
  jurisdiction: JurisdictionVerdict;
  /** Null when the funnel stopped before the paid call — which is the point of
   *  recording it: a null here means we spent nothing on this post. */
  intent: IntentReading | null;
  /** Assets that matched, and assets an exclusion vetoed. */
  retrieval: RetrievalRecord | null;
  variants: VariantEligibility;
  eligibilityReasons: EligibilityVerdict['reasons'];
  /** 0-100. Ordering within one scan only — see `scoreOpportunity`. */
  score: number;
  /** What the timing checks measured, kept for the screen and the log. */
  measured: ScreenVerdict['measured'];
}

export interface TriageInput {
  post: CoversPost;
  itemId: string;
  threadTitle: string;
  threadLastPostAtMs: number | null;
  section: string;
  sectionName: string;
  sections: readonly CoversSection[];
  paceMs: number | null;
  footprint: Footprint;
  kickoffMs: number | null;
  jurisdiction: JurisdictionPolicy;
  assets: readonly Asset[];
  /** Live claim counts by assetId. An asset with none is usable, not citable. */
  liveClaimsByAsset: Record<string, number>;
  enabledVariants?: Partial<VariantEligibility>;
  limits?: ScreenLimits;
  nowMs: number;
}

/**
 * The paid step, injected.
 *
 * ⚠️ RETURNING NULL MEANS "NOT ATTEMPTED", and it is a different answer from a
 * classification that failed. A run that stops calling the model because it hit
 * its budget must not leave behind posts marked `unreadable` — that reads as a
 * finding about the post, ends up in the counts, and makes a queue cut short by
 * money look like a quiet forum.
 */
export type IntentReader = (input: TriageInput) => Promise<IntentReading | null>;

const NO_JURISDICTION_HIT: JurisdictionVerdict = { blocked: false, matched: [] };

function stop(
  input: TriageInput,
  outcome: TriageOutcome,
  over: Partial<Triage> = {},
): Triage {
  return {
    postId: input.post.postId,
    itemId: input.itemId,
    section: input.section,
    outcome,
    screenReasons: [],
    jurisdiction: NO_JURISDICTION_HIT,
    intent: null,
    retrieval: null,
    variants: { brandMentioned: false, brandInformed: false, communityOnly: false },
    eligibilityReasons: {},
    score: 0,
    measured: { postAgeMs: null, threadQuietMs: null, paceMs: null },
    ...over,
  };
}

/**
 * Triage one post.
 *
 * Returns a record for EVERY post, including the ones that stopped immediately.
 * A queue showing only the survivors reads as a broken feature when it is the
 * feature working — the same reason a comment-karma draft record is written for
 * every scan rather than only the successful ones.
 */
export async function triagePost(input: TriageInput, readIntent: IntentReader): Promise<Triage> {
  // ── 1. Free ───────────────────────────────────────────────────────────────
  const screened = screen({
    post: input.post,
    threadLastPostAtMs: input.threadLastPostAtMs,
    section: input.section,
    sections: input.sections,
    paceMs: input.paceMs,
    footprint: input.footprint,
    kickoffMs: input.kickoffMs,
    nowMs: input.nowMs,
    limits: input.limits,
  });

  if (!screened.pass) {
    return stop(input, 'screened', { screenReasons: screened.reasons, measured: screened.measured });
  }

  // ── 2. Paid — exactly one call, on a post that survived everything free ────
  const attempted = await readIntent(input).catch(() => UNREADABLE);

  // Never attempted: the caller had no budget left. Recorded as such, with a
  // null intent, so it can be re-run later without pretending we learned
  // something about it.
  if (attempted === null) {
    return stop(input, 'budget', { measured: screened.measured });
  }

  const jurisdiction = checkJurisdiction(`${input.threadTitle}\n${input.post.body}`, input.jurisdiction);

  const intent = attempted;
  const base = { jurisdiction, intent, measured: screened.measured };

  if (intent.confidence === 0 && !intent.problem) {
    return stop(input, 'unreadable', base);
  }

  // A complaint leaves the pipeline. Not a low score — a different destination.
  if (intent.intent === 'complaint') {
    return stop(input, 'complaint', base);
  }

  if (!isDraftable(intent.intent)) {
    return stop(input, 'not-draftable', base);
  }

  // ── 3. Free again — everything that needs only the intent's output ────────
  const result = retrieve(
    { concepts: intent.concepts, text: `${input.threadTitle}\n${input.post.body}` },
    [...input.assets],
  );
  const retrieval = summariseRetrieval(result);

  const matched = result.matches.map((m) => m.asset);
  const hasCitableClaim = matched.some((a) => (input.liveClaimsByAsset[a.assetId] ?? 0) > 0);

  const eligibility = variantEligibility({
    section: input.section,
    sections: input.sections,
    hasAssetMatch: hasMatch(result),
    hasCitableClaim,
    enabled: input.enabledVariants,
  });

  // ── The jurisdiction gate, and WHERE it belongs ──────────────────────────
  //
  // It removes the variants that draw on the client, and nothing else. Offering
  // a sportsbook to somebody who says they bet from a place it cannot serve is
  // the prohibited act; being a useful member of the forum in the same thread is
  // not, so the community reply survives.
  //
  // Running it here rather than in the free tier is the fix for a live failure:
  // as a standalone free check it hard-rejected two posts in a political
  // argument about healthcare, because the sentence said "in US". The gate is
  // right only in combination — a locational construction AND a reply that would
  // actually put the client in front of that person.
  const variants = { ...eligibility.variants };
  const reasons = { ...eligibility.reasons };

  if (jurisdiction.blocked) {
    const why = `The writer places themselves in ${jurisdiction.matched.join(', ')}, which the client cannot serve.`;
    if (variants.brandMentioned) reasons.brandMentioned = why;
    if (variants.brandInformed) reasons.brandInformed = why;
    variants.brandMentioned = false;
    variants.brandInformed = false;
  }

  const withEligibility = {
    ...base,
    retrieval,
    variants,
    eligibilityReasons: reasons,
  };

  // Nothing left that draws on the client, and it was the jurisdiction that took
  // them away: recorded as prohibited rather than as a thin match.
  if (jurisdiction.blocked && !variants.communityOnly) {
    return stop(input, 'jurisdiction', withEligibility);
  }

  // A GAP, not a failure: real demand this client cannot speak to. It costs
  // nothing extra to collect and it is what justifies writing something new.
  if (!hasMatch(result) && !variants.communityOnly) {
    return stop(input, 'no-asset-match', withEligibility);
  }

  if (!anyVariantEligible(variants)) {
    return stop(input, 'no-variant', withEligibility);
  }

  const outcome: TriageOutcome = hasMatch(result) ? 'opportunity' : 'no-asset-match';

  return {
    ...stop(input, outcome, withEligibility),
    score: scoreOpportunity({
      intent,
      topAssetScore: retrieval?.topScore ?? 0,
      variants,
      postAgeMs: screened.measured.postAgeMs,
      paceMs: input.paceMs,
    }),
  };
}

/**
 * What retrieval decided, kept in the form a person can argue with.
 *
 * ⚠️ THE MATCHED PHRASES ARE STORED, NOT JUST THE ASSET IDS. "This asset
 * matched" is unreviewable; "this asset matched because the post says 'cash out'
 * and the asset lists that as a trigger" is the difference between a reviewer
 * being able to correct the library and being able only to disagree with it.
 * retrieval.ts already computes it — dropping it here would throw away the one
 * output that makes a wrong match fixable.
 */
export interface RetrievalRecord {
  matched: {
    assetId: string;
    title: string;
    score: number;
    why: { triggers: string[]; problems: string[] };
  }[];
  vetoed: { assetId: string; title: string; exclusion: string }[];
  topScore: number;
}

function summariseRetrieval(result: RetrievalResult): RetrievalRecord {
  return {
    matched: result.matches.map((m) => ({
      assetId: m.asset.assetId,
      title: m.asset.title,
      score: m.score,
      why: { triggers: m.matched.triggers, problems: m.matched.problems },
    })),
    vetoed: result.vetoed.map((v) => ({
      assetId: v.asset.assetId,
      title: v.asset.title,
      exclusion: v.exclusion,
    })),
    topScore: result.matches[0]?.score ?? 0,
  };
}

/**
 * How this opportunity ranks against the others in the same scan.
 *
 * ⚠️ ORDERING, NOT A MEASUREMENT. Nothing here has been calibrated against a
 * human decision yet, so the number's only job is to put the better ones nearer
 * the top of a queue a person then reads. Calling it a probability, or gating on
 * it, would be inventing precision — the plan says these numbers stay
 * uncalibrated until real decisions have been compared against them.
 *
 * Freshness is scored against the SECTION's pace rather than in hours, for the
 * same reason the cold-thread window is: an hour is old on one board and new on
 * another.
 */
export function scoreOpportunity(input: {
  intent: IntentReading;
  topAssetScore: number;
  variants: VariantEligibility;
  postAgeMs: number | null;
  paceMs: number | null;
}): number {
  // Somebody asking a question is a better place to answer than somebody
  // narrating their card.
  const byIntent: Record<string, number> = {
    question: 30,
    'tool-request': 28,
    comparison: 24,
    education: 16,
    'pick-sharing': 8,
    complaint: 0,
    banter: 0,
  };

  let score = byIntent[input.intent.intent] ?? 0;
  if (input.intent.asksSomething) score += 8;

  // How well the library actually covers it, capped so a strong match cannot by
  // itself carry a thread nobody asked anything in.
  score += Math.min(30, Math.round(input.topAssetScore * 0.3));

  // Being able to say something specific is worth more than being able to say
  // something general.
  if (input.variants.brandInformed) score += 8;
  if (input.variants.brandMentioned) score += 6;

  // Freshness, in units of the section's own rhythm.
  if (input.postAgeMs !== null && input.paceMs !== null && input.paceMs > 0) {
    const ages = input.postAgeMs / input.paceMs;
    score += ages <= 1 ? 18 : ages <= 3 ? 12 : ages <= 6 ? 5 : 0;
  }

  // The model's own confidence moves it a little, and cannot make or break it.
  score += Math.round(input.intent.confidence * 10);

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// The gap board
// ---------------------------------------------------------------------------

export interface Gap {
  /** The concept people keep raising. */
  concept: string;
  /** How many posts raised it with nothing in the library to answer. */
  posts: number;
  /** Distinct threads, so one loud thread does not look like demand. */
  threads: number;
  /** The problems, verbatim, so a person can see what was actually asked. */
  examples: string[];
  sections: string[];
  /** Why this row is on the tray it is on. Kept in full — a filter whose
   *  decisions cannot be read is a filter nobody can correct. */
  domain: ConceptRuling;
  /**
   * In-domain concepts raised by the same posts. AN ANNOTATION, NEVER A VERDICT.
   *
   * It is what makes the unclassified tray workable: a row nothing recognised,
   * sitting next to `parlay` and `closing line`, is almost certainly a real gap
   * in the library, and one sitting next to nothing is probably forum noise. The
   * reader can tell those apart at a glance without the filter having to pretend
   * it knows which is which.
   */
  seenWith: string[];
}

/**
 * The gap board, in three trays.
 *
 * ⚠️ NOTHING IS DISCARDED. `offDomain` is a tray, not a bin: every rejected
 * concept keeps its count, its examples and the term that rejected it, so a
 * filtering mistake is a row somebody can point at. The alternative — dropping
 * them at the door — makes the board look clean and makes the filter unfixable,
 * which is the worse trade in a system whose whole job is to be checkable.
 */
export interface GapBoard {
  /** Recognised by the client's library, the vertical, or the section's sport. */
  gaps: Gap[];
  /** Nothing recognised them, and that is exactly what an unmet need looks
   *  like. Kept, ranked, and shown separately rather than mixed in. */
  unclassified: Gap[];
  /** Rejected, with the topic and the term that did it. */
  offDomain: Gap[];
  counts: { inDomain: number; unclassified: number; offDomain: number };
}

export const EMPTY_GAP_BOARD: GapBoard = {
  gaps: [],
  unclassified: [],
  offDomain: [],
  counts: { inDomain: 0, unclassified: 0, offDomain: 0 },
};

interface GapRow {
  posts: number;
  threads: Set<string>;
  examples: string[];
  sections: Set<string>;
  domain: ConceptRuling;
  seenWith: Set<string>;
}

/**
 * What people keep asking that this client cannot answer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A GAP REQUIRES SOMEBODY TO HAVE ASKED SOMETHING
 *
 * The first live run produced nine "gaps" from four threads, and most of them
 * were somebody narrating their card: `aaron donald`, `star-studded d-line`,
 * `16-10-1 overall`. Nobody was asking anything. A gap board built from every
 * unmatched post measures what the forum TALKS about, and what it talks about is
 * football — so it would send a person off to write an asset about Aaron
 * Donald's contract for a sportsbook's knowledge base.
 *
 * Unmet demand means demand. `asksSomething` is the classifier's own answer to
 * exactly that question, and pick-sharing is excluded outright: a card with a
 * question in it is classified as a question, so anything still labelled
 * pick-sharing has nothing being asked in it.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AND A GAP REQUIRES THE SUBJECT TO BE ONE THE CLIENT COULD EVER ADDRESS
 *
 * The second thing the first live board proved: demand is not enough either. It
 * offered `compassion`, `healthcare system` and `canada` — real questions,
 * genuinely unanswered, from a political argument that happened to be running on
 * a betting forum. Asking somebody to write a sportsbook asset about the
 * healthcare system is worse than showing them nothing.
 *
 * ./domain.ts rules each concept and the three verdicts become three trays. The
 * off-domain ones are KEPT and shown with the term that rejected them, because
 * the filter will be wrong sometimes and the only way that gets fixed is if its
 * mistakes are visible.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Clustered by CONCEPT rather than by post, and counted by THREAD as well as by
 * post: twenty replies inside one argument is one conversation, not twenty
 * pieces of demand, and ranking on raw post counts would send somebody off to
 * write an asset for an argument.
 */
export function buildGaps(
  triaged: readonly Triage[],
  lexicon: DomainLexicon,
  limit = 25,
): GapBoard {
  const byConcept = new Map<string, GapRow>();

  for (const t of triaged) {
    if (t.outcome !== 'no-asset-match' || !t.intent) continue;
    if (!t.intent.asksSomething) continue;
    if (t.intent.intent === 'pick-sharing') continue;

    // Ruled a post at a time, so an outlier concept can be judged against the
    // company it was keeping. See rulePost.
    const rulings = rulePost(t.intent.concepts, lexicon);
    const inDomainHere = rulings.filter((r) => r.verdict === 'in-domain').map((r) => r.concept);

    for (const ruling of rulings) {
      const row = byConcept.get(ruling.concept) ?? {
        posts: 0,
        threads: new Set<string>(),
        examples: [],
        sections: new Set<string>(),
        domain: ruling,
        seenWith: new Set<string>(),
      };

      row.posts++;
      row.threads.add(t.itemId);
      row.sections.add(t.section);
      for (const sibling of inDomainHere) {
        if (sibling !== ruling.concept) row.seenWith.add(sibling);
      }
      if (row.examples.length < 5 && t.intent.problem && !row.examples.includes(t.intent.problem)) {
        row.examples.push(t.intent.problem);
      }

      // The same concept can be ruled differently in two posts — `election` is
      // off-domain in a politics thread and stays off-domain, but a concept
      // ruled in-domain anywhere has real evidence for it, and the strongest
      // ruling seen is the one worth keeping.
      if (rank(ruling.verdict) > rank(row.domain.verdict)) row.domain = ruling;

      byConcept.set(ruling.concept, row);
    }
  }

  const rows = [...byConcept.entries()].map(([concept, row]) => ({
    concept,
    posts: row.posts,
    threads: row.threads.size,
    examples: row.examples,
    sections: [...row.sections],
    domain: row.domain,
    seenWith: [...row.seenWith].slice(0, 6),
  }));

  const tray = (verdict: DomainVerdict): Gap[] =>
    rows
      .filter((r) => r.domain.verdict === verdict)
      .sort((a, b) => b.threads - a.threads || b.posts - a.posts || a.concept.localeCompare(b.concept))
      .slice(0, limit);

  const gaps = tray('in-domain');
  const unclassified = tray('unclassified');
  const offDomain = tray('off-domain');

  return {
    gaps,
    unclassified,
    offDomain,
    // Counted over EVERY row, not over the trays: the trays are capped at
    // `limit` and a count that shrank when the cap bit would be a lie about how
    // much the filter rejected.
    counts: {
      inDomain: rows.filter((r) => r.domain.verdict === 'in-domain').length,
      unclassified: rows.filter((r) => r.domain.verdict === 'unclassified').length,
      offDomain: rows.filter((r) => r.domain.verdict === 'off-domain').length,
    },
  };
}

/** in-domain beats unclassified beats off-domain, when one concept was ruled
 *  more than once. Deliberately asymmetric with rulePost's rejection rule: there
 *  it is one post deciding its own outlier, here it is evidence accumulated
 *  across posts, and evidence that a concept IS in domain does not stop being
 *  true because another thread used the word differently. */
function rank(v: DomainVerdict): number {
  return v === 'in-domain' ? 2 : v === 'unclassified' ? 1 : 0;
}

/** Ranked, best first. Only the ones a person can act on. */
export function rankOpportunities(triaged: readonly Triage[]): Triage[] {
  return triaged.filter((t) => t.outcome === 'opportunity').sort((a, b) => b.score - a.score);
}

/** One line per outcome, for the screen and the log. */
export function triageSummary(triaged: readonly Triage[]): Record<TriageOutcome, number> {
  const counts = {
    opportunity: 0,
    screened: 0,
    jurisdiction: 0,
    complaint: 0,
    'not-draftable': 0,
    unreadable: 0,
    'no-variant': 0,
    'no-asset-match': 0,
    budget: 0,
  } as Record<TriageOutcome, number>;

  for (const t of triaged) counts[t.outcome]++;
  return counts;
}

/** How many posts reached the paid call. The bill, in one number. */
export function paidCalls(triaged: readonly Triage[]): number {
  return triaged.filter((t) => t.intent !== null).length;
}
