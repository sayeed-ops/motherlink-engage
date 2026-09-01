// What we can work out about a client without asking, and what we must ask.
//
// PURE. No I/O, no clock.
//
// ════════════════════════════════════════════════════════════════════════════
// THE SPLIT THIS FILE EXISTS TO MAKE
//
// Setting up a Covers client involves about eight values. Seven of them are
// either derivable from things the system already holds or have a defensible
// default, and ONE PAIR IS NOT: which jurisdictions the client may not serve,
// and what disclosure wording their counsel requires. Those come from a licence
// and a lawyer. Nothing in this codebase can guess them, and a plausible guess
// would be worse than an empty field because it would look answered.
//
// So: everything else is seeded automatically at project creation and never
// asked about, and those two are held in an explicitly UNCONFIRMED state until
// a person says otherwise.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ AN EMPTY brandNames LIST SILENTLY DISABLES BRAND DETECTION
//
// This is the failure that made the file necessary. `brandMentions()` counts
// occurrences of the configured names; with an empty list it counts zero, so:
//
//   - a community-only reply could name the client and `brand-named` never fires
//   - a brand-mentioned reply could omit the client and `brand-absent` never fires
//   - the per-thread mention ceiling can never be exceeded
//
// Nothing errors. Three gates just quietly pass everything. The list is
// therefore DERIVED at creation from the project name, the client's website and
// the interview, and `deriveBrandNames` is written so that it cannot return
// empty for a project that has a name — which every project does, because the
// create route rejects one without.
// ════════════════════════════════════════════════════════════════════════════

import type { JurisdictionPolicy } from './policy';

/** Everything the system already knows about a client when a project is made. */
export interface KnownClient {
  /** `projects/{id}.name`. Always present — the create route requires it. */
  projectName: string;
  /** `projects/{id}.clientWebsiteUrl`. Often present, sometimes empty. */
  clientWebsiteUrl?: string;
  /** `interview/current.clientName`, when the deep interview has been run.
   *  Frequently the company's real trading name where the project name is a
   *  shorthand somebody typed in a hurry. */
  interviewClientName?: string;
  /** Source URLs from the asset library. Their registrable labels are names the
   *  client actually publishes under, which is better evidence than anything
   *  typed into a form. */
  assetUrls?: readonly string[];
}

/**
 * Legal-form suffixes, stripped before a name becomes a brand term.
 *
 * "Northwind Ltd" is filed as that and written as "Northwind" by every person on
 * a forum. Matching on the full legal name would miss every real mention, and
 * the gate would report a clean reply that names the client in every sentence.
 */
const LEGAL_SUFFIX = /\s+(ltd|limited|inc|incorporated|llc|l\.l\.c\.|plc|gmbh|b\.?v\.?|s\.?a\.?|ag|pty|pte|co|corp|corporation|holdings|group|company)\.?$/i;

/**
 * Two-level public suffixes, so `northwind.co.uk` yields `northwind` and not
 * `co`. Not a complete public-suffix list and does not pretend to be — it is
 * the handful that actually appear, and an unknown one falls back to the
 * second-to-last label, which is right for every single-level TLD.
 */
const TWO_LEVEL_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.nz', 'co.za', 'com.au', 'net.au',
  'org.au', 'com.br', 'com.mx', 'co.jp', 'co.in', 'com.sg', 'co.kr',
]);

/** The registrable label of a hostname — the bit that is the brand. */
export function brandLabelOf(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let host: string;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }

  const parts = host.replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? null;

  const lastTwo = parts.slice(-2).join('.');
  const label = TWO_LEVEL_SUFFIX.has(lastTwo) ? parts[parts.length - 3] : parts[parts.length - 2];

  return label ?? null;
}

/** Title-case a lowercase domain label so it reads as a name rather than a slug. */
function presentable(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Terms that are too short or too generic to match on.
 *
 * The same lesson `checkJurisdiction` records about two- and three-letter codes
 * and `entities.ts` records about team abbreviations: at this length a brand
 * name collides with ordinary English, and a false brand hit would reject a
 * perfectly good community-only reply for naming a client it never mentioned.
 */
const MIN_BRAND_CHARS = 3;

const TOO_GENERIC = new Set([
  'the', 'app', 'web', 'bet', 'betting', 'sports', 'sport', 'book', 'books',
  'online', 'digital', 'media', 'global', 'international', 'services', 'solutions',
]);

/**
 * Every name this client is plausibly written as.
 *
 * ⚠️ CANNOT RETURN EMPTY for a client with a project name, and the test suite
 * asserts it. See the header — an empty list is not a mild misconfiguration, it
 * is three gates silently passing everything.
 *
 * Ordered most-specific first so the review screen shows the real trading name
 * before a domain label, and deduplicated case-insensitively because "Northwind"
 * and "northwind" are one term to a case-insensitive matcher and two rows to a
 * person reading a list.
 */
export function deriveBrandNames(known: KnownClient): string[] {
  const candidates: string[] = [];

  const fromName = (raw: string | undefined) => {
    const name = (raw ?? '').trim();
    if (!name) return;
    candidates.push(name);
    const stripped = name.replace(LEGAL_SUFFIX, '').trim();
    if (stripped && stripped !== name) candidates.push(stripped);
  };

  // The interview's name first: it is the trading name somebody researched,
  // where the project name is whatever was typed into a create form.
  fromName(known.interviewClientName);
  fromName(known.projectName);

  const label = brandLabelOf(known.clientWebsiteUrl ?? '');
  if (label) candidates.push(presentable(label));

  // Asset source URLs — where the client actually publishes. A help centre on
  // `help.northwind.example` and a blog on `northwindbet.example` are two names
  // the same client answers to.
  for (const url of known.assetUrls ?? []) {
    const l = brandLabelOf(url);
    if (l) candidates.push(presentable(l));
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of candidates) {
    const term = raw.trim().replace(/[.,;:]+$/, '');
    if (term.length < MIN_BRAND_CHARS) continue;
    if (TOO_GENERIC.has(term.toLowerCase())) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }

  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

/**
 * The two values nothing can derive.
 *
 * Named as a list rather than left implicit so the UI, the seed and the tests
 * all agree about what "confirmation" means, and so adding a third later is one
 * edit rather than three.
 */
export const COMPLIANCE_DECISIONS = [
  'Which jurisdictions the client may not take customers from',
  'What disclosure wording is required when a reply names the client',
] as const;

export interface SeededPolicy {
  jurisdiction: JurisdictionPolicy;
  variants: { brandMentioned: boolean; brandInformed: boolean; communityOnly: boolean };
  brandNames: string[];
  disclosureWording: string;
  /**
   * Has a person confirmed the compliance decisions?
   *
   * ⚠️ FALSE IS NOT A WARNING, IT IS A STATE THAT CHANGES BEHAVIOUR — see
   * policy.ts § variantEligibility. Until this is true, the variants that draw
   * on the client are withheld and only the community reply is written. An
   * unconfirmed prohibited-jurisdiction list does not mean "there are no
   * prohibited jurisdictions"; it means nobody has said, and offering a
   * sportsbook to somebody it cannot legally serve is the one mistake here that
   * is not recoverable by editing a draft.
   */
  complianceConfirmed: boolean;
  /** Where the brand names came from, so the screen can say "we worked these
   *  out" rather than presenting a guess as a decision. */
  brandNamesDerived: boolean;
}

/**
 * A new client's Covers policy, ready to save without anybody typing anything.
 *
 * Everything here is either derived or a defensible default. `brandMentioned`
 * stays FALSE — naming a client in public is a decision somebody makes, not a
 * default nobody revisited — and it is not one of the two confirmations,
 * because leaving it off is safe and leaving jurisdictions unknown is not.
 */
export function seedCoversPolicy(known: KnownClient): SeededPolicy {
  const brandNames = deriveBrandNames(known);

  return {
    jurisdiction: { prohibited: [], licensed: [] },
    variants: { brandMentioned: false, brandInformed: true, communityOnly: true },
    brandNames,
    disclosureWording: '',
    complianceConfirmed: false,
    brandNamesDerived: brandNames.length > 0,
  };
}

/** What still needs a person, in the words the screen shows. Empty means the
 *  client is fully configured. */
export function outstandingDecisions(policy: {
  complianceConfirmed: boolean;
  brandNames: readonly string[];
}): string[] {
  const out: string[] = [];
  if (policy.brandNames.length === 0) {
    // Should be unreachable for a seeded project; surfaced rather than assumed
    // because the consequence is silent.
    out.push('No brand names are set — brand detection is disabled until at least one is added');
  }
  if (!policy.complianceConfirmed) out.push(...COMPLIANCE_DECISIONS);
  return out;
}
