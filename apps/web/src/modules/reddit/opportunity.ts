// Brand or growth — the one place that decides.
//
// A post can be worth replying to for two unrelated reasons: the client is
// genuinely the answer (BRAND), or a useful reply builds the account's standing
// while never naming them (GROWTH). The analysis scores both independently, and
// almost every screen and route needs to ask which one a reply is.
//
// ⚠️ GROWTH ⟺ mentionRecommendation === 'no' IS STRUCTURAL, NOT INCIDENTAL.
// It is the reason a growth reply can never pitch the client: the draft route
// gates on it, and the prompt is handed the same field. Losing that equivalence
// loses the safety property, which is why this lives in one file that three
// callers import rather than as three copies that have to be kept in step.
//
// Previously copied in the reddit page, the draft route and (nearly) the sheet
// filter. A sheet that disagreed with the screen's "Brand opportunities" tab
// about what counts as a brand reply would be worse than no filter at all.

import type { RedditOpportunityAnalysis } from './types';

/** Below this, a no-mention post is not worth an account-warming reply. */
export const GROWTH_MIN = 40;

/** The fields either test reads. Kept structural so a view model with the same
 *  shape (the reddit page's `Analysis`) can be passed without a conversion. */
export interface OpportunityFacts {
  decision: RedditOpportunityAnalysis['decision'];
  mentionRecommendation: RedditOpportunityAnalysis['mentionRecommendation'];
  growthScore?: number | null;
}

/**
 * The client may be named in this reply.
 *
 * "soft" counts. The recommendation is what the draft was written under, and a
 * soft reply is one we asked to mention the client — whether the model found a
 * natural place for it is a property of that one draft, not of the opportunity.
 */
export function isBrandOpportunity(a: OpportunityFacts): boolean {
  return (
    a.decision !== 'skip' && (a.mentionRecommendation === 'yes' || a.mentionRecommendation === 'soft')
  );
}

/** A useful reply that names nobody, good enough to be worth posting. */
export function isGrowthOpportunity(a: OpportunityFacts): boolean {
  return a.mentionRecommendation === 'no' && (a.growthScore ?? 0) >= GROWTH_MIN;
}
