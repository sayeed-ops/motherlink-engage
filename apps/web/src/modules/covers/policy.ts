// Who we may talk to, and what we may say where.
//
// PURE. Two questions that look similar and are not:
//
//   JURISDICTION — may this person legally be a customer? A hard reject.
//   SECTION      — may a reply here name the client? A mask on the variants.
//
// Both run in the free tier, before any model call, because neither depends on
// anything a model would write.

import type { CoversSection } from './sections';
import { normaliseSection } from './sections';

// ---------------------------------------------------------------------------
// Jurisdiction
// ---------------------------------------------------------------------------

/**
 * Where the client may and may not take customers.
 *
 * Written down per project rather than inferred, because it comes from a
 * licence and changes when the licence does.
 */
export interface JurisdictionPolicy {
  /** Names and abbreviations that mean a place the client CANNOT serve. Matched
   *  case-insensitively on word boundaries: 'United States', 'US', 'Ontario'. */
  prohibited: string[];
  /** Places the client is licensed in. Used only to explain a decision — a
   *  thread naming a licensed jurisdiction is not thereby a better opportunity. */
  licensed: string[];
}

export const EMPTY_JURISDICTION: JurisdictionPolicy = { prohibited: [], licensed: [] };

export interface JurisdictionVerdict {
  /** True when the post names a place the client cannot serve. */
  blocked: boolean;
  /** Which term fired, verbatim as configured, for the reviewer. */
  matched: string[];
}

/** At or below this length, a term is matched CASE-SENSITIVELY. See below. */
const ABBREVIATION_CHARS = 3;

/**
 * Ways of saying somebody IS somewhere, rather than merely naming the place.
 *
 * Deliberately narrow. These are the constructions a bettor uses to situate
 * themselves or the person they are answering — "betting from Ontario",
 * "anyone in the US", "Ontario players" — and they are what separates a post
 * about where somebody bets from a post that happens to mention a country.
 */
const BEFORE = [
  'from', 'in', 'inside', 'within', 'based in', 'living in', 'live in', 'residing in',
  'resident of', 'residents of', 'here in', 'over in', 'located in', 'im in', "i'm in",
  'anyone in', 'anybody in', 'guys in', 'players in', 'bettors in', 'punters in',
];

const AFTER = [
  'player', 'players', 'resident', 'residents', 'customer', 'customers', 'bettor', 'bettors',
  'punter', 'punters', 'account', 'accounts', 'based', 'user', 'users',
];

/**
 * Does this post say somebody is BETTING FROM a jurisdiction the client cannot
 * serve?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NAMING A COUNTRY IS NOT THE SAME AS BETTING FROM IT
 *
 * The first version blocked on a bare mention, and a live run showed the cost
 * immediately: it hard-rejected two posts in a political argument about
 * healthcare because the sentence contained the word "US". Neither had anything
 * to do with betting, and a hard reject explains itself to nobody — those
 * threads would have been silently unreachable forever.
 *
 * So a match needs a LOCATIONAL construction: the place preceded by "from",
 * "in", "living in", or followed by "players", "residents", "customers". "In
 * both US and Canada, illegal immigrants do not qualify…" still matches "in US",
 * which is why this gate no longer stands alone — triage runs it only when a
 * reply would actually draw on the client, and it is the combination that makes
 * it right rather than either half.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ A SHORT CODE IS MATCHED IN THE CASE IT WAS WRITTEN IN. `US` is also the
 * English word "us", and "just us regulars in here" is not a post about American
 * customers. Same lesson the team lexicon learned about `NO` and `WAS`: at two
 * or three characters an abbreviation collides with ordinary English, and how it
 * is WRITTEN is what separates them.
 */
export function checkJurisdiction(text: string, policy: JurisdictionPolicy): JurisdictionVerdict {
  const matched = policy.prohibited.filter((term) => {
    const t = term.trim();
    if (!t) return false;

    const caseSensitive = t.length <= ABBREVIATION_CHARS;
    const flags = caseSensitive ? 'i' : 'i'; // see `cased` below
    const place = escapeRe(t);

    const before = `(?:${BEFORE.map(escapeRe).join('|')})\\s+(?:the\\s+)?`;
    const after = `(?:${AFTER.map(escapeRe).join('|')})`;

    const pattern = new RegExp(
      `(?<![A-Za-z0-9])(?:${before}${place}|${place}[-\\s]+${after})(?![A-Za-z0-9])`,
      flags,
    );

    if (!pattern.test(text)) return false;

    // Case is checked separately from the construction: a short code must still
    // have been written as a code somewhere in the text.
    return caseSensitive
      ? new RegExp(`(?<![A-Za-z0-9])${place}(?![A-Za-z0-9])`).test(text)
      : true;
  });

  return { blocked: matched.length > 0, matched };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Variant eligibility
// ---------------------------------------------------------------------------

/** The three replies of the plan, by the flags that switch them on. */
export interface VariantEligibility {
  /** Names the client. */
  brandMentioned: boolean;
  /** Draws on the library, names nobody. */
  brandInformed: boolean;
  /** General reasoning and what is in the thread. */
  communityOnly: boolean;
}

export const NO_VARIANTS: VariantEligibility = {
  brandMentioned: false,
  brandInformed: false,
  communityOnly: false,
};

export interface EligibilityInput {
  section: string;
  sections: readonly CoversSection[];
  /** Did retrieval find anything the client can actually speak to? */
  hasAssetMatch: boolean;
  /** Is at least one matched asset citable — a live claim behind it? */
  hasCitableClaim: boolean;
  /** The project's own switches. A client may simply not want a variant. */
  enabled?: Partial<VariantEligibility>;
}

export interface EligibilityVerdict {
  variants: VariantEligibility;
  /** Why each disabled variant is disabled. Shown in review, because "we chose
   *  not to name them" and "we are not allowed to name them here" are different
   *  facts about the same silence. */
  reasons: Partial<Record<keyof VariantEligibility, string>>;
}

/**
 * Which replies are even worth generating.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE MASK RUNS BEFORE GENERATION, NOT AFTER
 *
 * A reply-only section removes the brand-mentioned variant here, for free, and
 * the generator is never asked to write one. Discovering afterwards that the
 * best of three replies is the one that may not be posted is how a pipeline
 * spends money to produce something it then throws away.
 *
 * Expect variant 1 to be eligible far less often than it sounds: `promote` is
 * held by one section and the forum treats commercial posts elsewhere as
 * bannable. Variants 2 and 3 will carry the volume, which is a fact about the
 * forum rather than a shortcoming of the design.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function variantEligibility(input: EligibilityInput): EligibilityVerdict {
  const slug = normaliseSection(input.section);
  const section = input.sections.find((s) => s.slug === slug);
  const enabled = input.enabled ?? {};
  const reasons: EligibilityVerdict['reasons'] = {};

  // An unconfigured section permits nothing that names the client. Same rule as
  // promotionPermitted: a section nobody has classified is not a section anyone
  // has said we may advertise in.
  const mayPromote = section?.roles.includes('promote') ?? false;
  const mayReply = mayPromote || (section?.roles.includes('reply') ?? false);

  const variants: VariantEligibility = { ...NO_VARIANTS };

  // --- variant 1: names the client ------------------------------------------
  if (enabled.brandMentioned === false) {
    reasons.brandMentioned = 'Turned off for this client.';
  } else if (!mayPromote) {
    reasons.brandMentioned = section
      ? `${section.name} does not permit promotion.`
      : 'This section is not configured, so promotion is not permitted.';
  } else if (!input.hasAssetMatch) {
    reasons.brandMentioned = 'Nothing in the library speaks to this.';
  } else if (!input.hasCitableClaim) {
    // The variant that names the client is the one that states facts about
    // them, and a stated fact needs a live claim behind it.
    reasons.brandMentioned = 'The matching asset has no live claim to cite.';
  } else {
    variants.brandMentioned = true;
  }

  // --- variant 2: informed by the library, names nobody ---------------------
  if (enabled.brandInformed === false) {
    reasons.brandInformed = 'Turned off for this client.';
  } else if (!mayReply) {
    reasons.brandInformed = 'This section is watch-only.';
  } else if (!input.hasAssetMatch) {
    reasons.brandInformed = 'Nothing in the library speaks to this.';
  } else {
    // Deliberately does NOT require a citable claim. An asset whose only claim
    // expired is still usable — the knowledge still shapes an answer; what it
    // may no longer do is carry a stated fact. Requiring citability here would
    // have collapsed the two and killed this variant.
    variants.brandInformed = true;
  }

  // --- variant 3: the thread and general reasoning --------------------------
  if (enabled.communityOnly === false) {
    reasons.communityOnly = 'Turned off for this client.';
  } else if (!mayReply) {
    reasons.communityOnly = 'This section is watch-only.';
  } else {
    variants.communityOnly = true;
  }

  return { variants, reasons };
}

export function anyVariantEligible(v: VariantEligibility): boolean {
  return v.brandMentioned || v.brandInformed || v.communityOnly;
}
