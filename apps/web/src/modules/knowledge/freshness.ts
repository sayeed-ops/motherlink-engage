// Whether a fact may still be stated, and whether an asset may still be used.
//
// PURE. Every function here is arithmetic over data the caller already has, plus
// a clock passed in as an argument. Nothing reads Date.now() — a knowledge base
// whose answers depend on an ambient clock cannot be tested, and this is the
// part that must be right.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO WAYS A FACT STOPS BEING TRUE, AND THEY ARE NOT THE SAME
//
//   EXPIRED — nobody has looked at it for CLAIM_TTL_DAYS. The page may well
//   still say exactly this. We simply do not know, and "we have not checked
//   since May" is not a defence.
//
//   STALE — the page CHANGED. This is worse and it is specific: somebody edited
//   the source after we verified the claim, so there is positive evidence that
//   what we recorded may no longer be what it says. Staleness beats expiry
//   because it is knowledge rather than the absence of knowledge, and it is the
//   only one of the two that a re-crawl can discover on its own.
//
// Both make a claim unassertable. They are reported separately because the fix
// differs: an expired claim needs someone to look; a stale one needs someone to
// look AT THE DIFF, and may need the asset itself rewritten.
// ════════════════════════════════════════════════════════════════════════════

import { normaliseForMatch } from './extract';
import {
  ASSERTABLE,
  CLAIM_EXPIRING_DAYS,
  CLAIM_TTL_DAYS,
  type Asset,
  type Claim,
  type ClaimStatus,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** verifiedAt + the TTL. The one place the expiry is computed, so a claim
 *  written by ingestion and one written by a re-verification cannot disagree. */
export function expiryFor(verifiedAtMs: number): number {
  return verifiedAtMs + CLAIM_TTL_DAYS * DAY_MS;
}

/**
 * Where this claim stands right now.
 *
 * ORDER MATTERS AND IS THE RULE: staleness is checked first, so a claim whose
 * page changed reports `stale` even when it is also within its TTL. Reporting
 * "verified" for a fact we know may have moved would be the single most
 * misleading thing this file could do.
 */
export function claimStatus(claim: Claim, asset: Asset | null, nowMs: number): ClaimStatus {
  const changedMs = asset?.sourceChangedAt?.getTime();
  if (changedMs != null && changedMs > claim.verifiedAt.getTime()) return 'stale';

  const expiresMs = claim.expiresAt.getTime();
  if (nowMs >= expiresMs) return 'expired';
  if (nowMs >= expiresMs - CLAIM_EXPIRING_DAYS * DAY_MS) return 'expiring';
  return 'live';
}

/** May a reply state this fact? `expiring` still may — it is a prompt to look,
 *  not a withdrawal, and blocking on it would take the library offline every
 *  time someone went on holiday. */
export function isAssertable(status: ClaimStatus): boolean {
  return (ASSERTABLE as readonly string[]).includes(status);
}

export interface AssetReadiness {
  /** May this asset be offered to the matcher at all? */
  usable: boolean;
  /** May a reply that NAMES the client be built on it? Needs a live fact. */
  citable: boolean;
  assertable: Claim[];
  blocked: { claim: Claim; status: ClaimStatus }[];
  /** Why not, in one sentence, for the review panel. Empty when usable. */
  reason: string;
}

/**
 * What this asset can currently support.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR: `usable` and `citable` are not the
 * same question, and collapsing them would quietly destroy the brand-informed
 * variant.
 *
 * An asset with no assertable claim can still legitimately shape a reply — it
 * says what the client knows about, what problems it addresses, what angle is
 * useful. That is variant 2 (brand-informed) working exactly as intended: the
 * knowledge improves the answer and nothing is attributed to anyone.
 *
 * What it cannot do is carry variant 1. Naming the client and then stating a
 * fact requires a fact somebody has verified, which is what `citable` means.
 */
export function assetReadiness(asset: Asset, claims: Claim[], nowMs: number): AssetReadiness {
  const mine = claims.filter((c) => c.assetId === asset.assetId);

  const assertable: Claim[] = [];
  const blocked: { claim: Claim; status: ClaimStatus }[] = [];
  for (const claim of mine) {
    const status = claimStatus(claim, asset, nowMs);
    if (isAssertable(status)) assertable.push(claim);
    else blocked.push({ claim, status });
  }

  // UNVERIFIED FIRST, because it is the more specific answer and the more
  // important one. A discovered page has a title and a purpose the model guessed
  // from a URL — that is a hunch, not knowledge, and nothing may be built on it
  // until somebody has actually read the page. This is where "discovery is not
  // verification" stops being a principle and becomes a return value.
  if (asset.textSource === 'unverified') {
    return {
      usable: false,
      citable: false,
      assertable,
      blocked,
      reason: 'Found, but nobody has read it yet — no content has been verified.',
    };
  }

  if (asset.status !== 'active') {
    return {
      usable: false,
      citable: false,
      assertable,
      blocked,
      reason:
        asset.status === 'draft'
          ? 'Proposed but not confirmed — nobody has agreed this is right yet.'
          : 'Retired.',
    };
  }

  if (asset.sourceChangedAt) {
    // The asset itself is suspect, not merely its facts: the page it describes
    // has been rewritten, so `purpose` and `exclusions` may be wrong too. This
    // is the one case where a re-crawl takes an ACTIVE asset out of use without
    // a human deciding to, and that is deliberate.
    return {
      usable: false,
      citable: false,
      assertable,
      blocked,
      reason: 'The source page changed since this was confirmed. Re-read it before using it again.',
    };
  }

  return {
    usable: true,
    citable: assertable.length > 0,
    assertable,
    blocked,
    reason: '',
  };
}

/** Claims due for a look, soonest first. Drives the review queue. */
export function needsReview(
  claims: Claim[],
  assetById: Map<string, Asset>,
  nowMs: number,
): { claim: Claim; status: ClaimStatus }[] {
  return claims
    .map((claim) => ({ claim, status: claimStatus(claim, assetById.get(claim.assetId) ?? null, nowMs) }))
    .filter(({ status }) => status !== 'live')
    .sort((a, b) => a.claim.expiresAt.getTime() - b.claim.expiresAt.getTime());
}

// ---------------------------------------------------------------------------
// Re-crawl
// ---------------------------------------------------------------------------

/**
 * Can the server go and look at this page again by itself?
 *
 * False for a pasted asset, and the sweep must honour that rather than trying
 * and recording the inevitable failure as an error. The page did not become
 * unreachable — it was never reachable, which is why the text was pasted, and
 * reporting that as a fault every night would train everyone to ignore the
 * report.
 *
 * A pasted asset is not thereby exempt from review: its CLAIMS still expire on
 * the same TTL as everyone else's, which is what eventually puts it back in
 * front of a person. The difference is only who does the looking.
 */
export function canRefetch(asset: Pick<Asset, 'textSource' | 'sourceUrl'>): boolean {
  // `unverified` IS re-fetchable, and deliberately so: a page that failed once
  // may simply have been slow, and a discovered page has never been tried at
  // all. Only `pasted` is permanently out of reach, because it is out of reach
  // by definition.
  return asset.textSource !== 'pasted' && !!asset.sourceUrl;
}

export type CrawlVerdict = 'unchanged' | 'changed' | 'first-crawl';

export interface CrawlOutcome {
  verdict: CrawlVerdict;
  /** Claims whose supporting sentence is no longer present in the page text.
   *
   *  Stronger evidence than a changed hash: a page can be reworded harmlessly,
   *  but a quote that has vanished means the sentence we relied on is gone. */
  missingQuotes: Claim[];
}

/**
 * Compare a fresh crawl against what we recorded.
 *
 * Deliberately does NOT decide what to do about it. Writing `sourceChangedAt`,
 * demoting an asset and queueing a review are the caller's business, because
 * they are Firestore writes and this file has no business knowing about those.
 */
export function compareCrawl(asset: Asset, page: { hash: string; text: string }, claims: Claim[]): CrawlOutcome {
  const mine = claims.filter((c) => c.assetId === asset.assetId);
  const haystack = normaliseForMatch(page.text);
  const missingQuotes = mine.filter((c) => {
    const needle = normaliseForMatch(c.quote);
    return needle.length > 0 && !haystack.includes(needle);
  });

  if (!asset.sourceHash) return { verdict: 'first-crawl', missingQuotes };
  return {
    verdict: asset.sourceHash === page.hash ? 'unchanged' : 'changed',
    missingQuotes,
  };
}
