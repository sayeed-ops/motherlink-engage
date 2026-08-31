// What happened after a person posted it by hand.
//
// PURE. No I/O, no clock — `nowMs` arrives as an argument, as everywhere else in
// this module.
//
// ════════════════════════════════════════════════════════════════════════════
// EVERY FIELD DEFAULTS TO UNKNOWN, AND UNKNOWN IS NOT ZERO
//
// This is the reader module's honest-`unknown` convention applied to outcomes,
// and it matters more here than anywhere else, because these numbers are what
// phase 7 fits knobs against. A reply nobody has checked on has `replies: null`,
// not `replies: 0`. A reply whose thread nobody has re-read has
// `moderation: 'unknown'`, not `'survived'`.
//
// The failure this prevents is specific and expensive: a campaign of twenty
// hand-posted replies, of which twelve were never followed up, would report
// "average 0.4 replies, 100% survived moderation" — a confident measurement of
// nothing, and the number a client would be shown. With nulls it reports
// "8 measured, 12 not checked", which is the truth and is also a prompt to go
// and look.
// ════════════════════════════════════════════════════════════════════════════

import type { VariantKind } from './variants';

/**
 * Did the forum keep it?
 *
 * `unknown` — nobody has looked. THE DEFAULT.
 * `survived` — the thread was re-read and the reply is still there.
 * `removed` — a moderator took it down.
 * `deleted` — we took it down ourselves. Different from `removed`, and the
 *   difference is the entire signal: one is the forum rejecting us and the other
 *   is us changing our mind.
 */
export type ModerationOutcome = 'unknown' | 'survived' | 'removed' | 'deleted';

export const MODERATION_LABEL: Record<ModerationOutcome, string> = {
  unknown: 'Not checked yet',
  survived: 'Still up',
  removed: 'Removed by a moderator',
  deleted: 'We removed it',
};

/** Whether the account itself took damage. A ban ends the pilot — see
 *  COVERS-PLAN § Open risks, "one account is one point of failure". */
export type AccountConsequence = 'unknown' | 'none' | 'warned' | 'suspended' | 'banned';

export const CONSEQUENCE_LABEL: Record<AccountConsequence, string> = {
  unknown: 'Not checked yet',
  none: 'Nothing happened',
  warned: 'The account was warned',
  suspended: 'The account was suspended',
  banned: 'The account was banned',
};

/** `projects/{projectId}/outcomes/{outcomeId}` with `platform: 'covers'`. */
export interface CoversOutcome {
  outcomeId: string;
  projectId: string;
  platform: 'covers';
  /** The draft this came from. */
  draftId: string;
  itemId: string;
  section: string;
  /** Which of the three actually went out. */
  variant: VariantKind;

  /** ⚠️ POSTED BY HAND, ALWAYS, IN PHASE 5. There is no agent path to Covers and
   *  no job kind, so there is no `postedByAccountId` here to fill in. Phase 6
   *  adds the agent path and the field with it. */
  postedByHand: true;
  postedAtMs: number;
  /** The URL of the reply, if the person kept it. Null is fine and common. */
  permalink: string | null;
  /** Covers' own post id for our reply, once somebody has found it. It is what
   *  makes a later automated re-read possible without a person in the loop. */
  externalPostId: string | null;
  /** The exact text that went out. Not the draft's — a person may have changed
   *  it in their browser after approving, and what we measure has to be what was
   *  actually posted. */
  postedText: string;

  // --- measured, and null until somebody looks ---------------------------
  /** Direct replies to our post. Null means nobody has counted. */
  replies: number | null;
  /** Did anyone quote us? Covers threads argue by quoting, so this is the
   *  cheapest available signal that a reply was read rather than scrolled past. */
  quoted: boolean | null;
  /** Posts added to the thread after ours. Thread activity, not our effect —
   *  named `threadPostsAfter` rather than `impact` for that reason. */
  threadPostsAfter: number | null;

  moderation: ModerationOutcome;
  consequence: AccountConsequence;

  /** Free text from the person who checked. */
  notes: string;
  /** When somebody last looked. Null means never — see the header. */
  measuredAtMs: number | null;
  measuredBy: string | null;

  createdBy: string;
  createdAt: Date;
}

/** A new outcome, at the moment of posting. Everything measurable is null,
 *  because at this moment nothing has been measured. */
export function newOutcome(input: {
  draftId: string;
  itemId: string;
  section: string;
  variant: VariantKind;
  postedText: string;
  permalink: string | null;
  postedAtMs: number;
}): Omit<CoversOutcome, 'outcomeId' | 'projectId' | 'createdBy' | 'createdAt'> {
  return {
    platform: 'covers',
    draftId: input.draftId,
    itemId: input.itemId,
    section: input.section,
    variant: input.variant,
    postedByHand: true,
    postedAtMs: input.postedAtMs,
    permalink: input.permalink,
    externalPostId: null,
    postedText: input.postedText,
    replies: null,
    quoted: null,
    threadPostsAfter: null,
    moderation: 'unknown',
    consequence: 'unknown',
    notes: '',
    measuredAtMs: null,
    measuredBy: null,
  };
}

/** Has anyone looked at this one yet? */
export function isMeasured(o: Pick<CoversOutcome, 'measuredAtMs'>): boolean {
  return o.measuredAtMs !== null;
}

/**
 * When a reply is worth checking on.
 *
 * The Reddit path measures at ~1h / 1d / 3d. Covers is slower — the live
 * harvest measured a median of ~143 hours between threads on General
 * Discussion — so the same schedule would ask a person to look at a reply three
 * times before anybody had read it. One day and one week, and phase 7 can fit a
 * real schedule once there are outcomes to fit against.
 */
export const CHECK_AFTER_MS = [24 * 3600_000, 7 * 24 * 3600_000] as const;

export function dueForCheck(o: Pick<CoversOutcome, 'postedAtMs' | 'measuredAtMs'>, nowMs: number): boolean {
  const age = nowMs - o.postedAtMs;
  if (age < CHECK_AFTER_MS[0]) return false;
  if (o.measuredAtMs === null) return true;
  // Measured once and now past the second window.
  return age >= CHECK_AFTER_MS[1] && o.measuredAtMs - o.postedAtMs < CHECK_AFTER_MS[1];
}

// ---------------------------------------------------------------------------
// The campaign summary
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  posted: number;
  /** ⚠️ THE DENOMINATOR FOR EVERY AVERAGE BELOW. Reported first and always,
   *  because "0.4 replies on average" over 8 of 20 checked is a different claim
   *  from the same number over 20 of 20. */
  measured: number;
  notChecked: number;
  /** Null when nothing has been measured. Not zero. */
  meanReplies: number | null;
  quotedCount: number | null;
  survived: number;
  removed: number;
  moderationUnknown: number;
  /** Any consequence worse than `none`. The number that stops a pilot. */
  consequences: number;
  byVariant: Record<string, number>;
}

export function summariseCampaign(outcomes: readonly CoversOutcome[]): CampaignSummary {
  const measured = outcomes.filter(isMeasured);
  const withReplies = measured.filter((o) => o.replies !== null);

  const byVariant: Record<string, number> = {};
  for (const o of outcomes) byVariant[o.variant] = (byVariant[o.variant] ?? 0) + 1;

  return {
    posted: outcomes.length,
    measured: measured.length,
    notChecked: outcomes.length - measured.length,
    meanReplies: withReplies.length
      ? Math.round((withReplies.reduce((a, o) => a + (o.replies ?? 0), 0) / withReplies.length) * 10) / 10
      : null,
    quotedCount: measured.length ? measured.filter((o) => o.quoted === true).length : null,
    survived: outcomes.filter((o) => o.moderation === 'survived').length,
    removed: outcomes.filter((o) => o.moderation === 'removed').length,
    moderationUnknown: outcomes.filter((o) => o.moderation === 'unknown').length,
    consequences: outcomes.filter((o) => o.consequence !== 'unknown' && o.consequence !== 'none').length,
    byVariant,
  };
}
