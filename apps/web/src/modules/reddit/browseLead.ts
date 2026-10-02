// The browse lead — the short browsing session an account runs BEFORE it goes
// looking for the thread it is about to comment on.
//
// PURE. No 'server-only', no Firestore, no fetch: composed at enqueue time on
// the server and rendered read-only in the browser, the same rule approach.ts
// and warmupWalk.ts follow.
//
// A reply or a karma comment used to open on the home feed, scroll a few times
// and head straight for the search bar — every time, the same shape. It now
// opens with a real (short) browsing session, composed by the SAME walk warm-up
// uses, and only when that ends does it search out the subreddit. The approach
// plan drops its own `open_home` when a lead runs, because the lead is the
// arrival.
//
// WHAT A LEAD IS NOT:
//   - It is not a warm-up session. It advances no warm-up counter and writes no
//     warm-up run; the experience clock counts sessions run to warm an account,
//     and a reply that browsed for three minutes on the way is not one.
//   - It never joins. Which communities an account follows is a warm-up
//     decision, and posting a reply must not change it. The kind is `browse`
//     (which cannot join by construction), the join targets are emptied, and
//     any join step is stripped again here and again by the agent.
//   - It never visits the community it is about to post in. Arriving there is
//     the approach plan's job; wandering in early and then "searching" for it
//     would be the tell this exists to avoid.
//   - It can never fail the reply. The agent runs it soft: a browse that breaks
//     is logged and the approach starts from the search bar regardless.

import {
  DEFAULT_POLICY,
  MAX_STEPS,
  composeWarmupSession,
  normalizeWarmupPolicy,
  warmupBoldnessDay,
  warmupDayFor,
  WARMUP_LOOP_LABELS,
  type WarmupLoopActionType,
  type WarmupLoopPlan,
} from './warmupWalk';
import {
  communitiesForRole,
  keywordsByCommunity,
  normalizeCommunityList,
  normalizeKeywordList,
  normalizeSubredditList,
} from './subreddits';

/** Shorter than a warm-up session on purpose: this is someone glancing at
 *  Reddit before doing the thing they came for, and the account is held for the
 *  whole job. Two to five minutes, four to fourteen steps. */
export const LEAD_SESSION_LENGTH = { stepMin: 4, stepMax: 14, wallMinSec: 120, wallMaxSec: 300 };

/** Share of jobs that skip the lead and open the classic way (home feed, a few
 *  scrolls, search). Every job browsing first would be its own regularity. */
export const LEAD_SKIP_CHANCE = 0.12;

/** A warm-up session that finished this recently IS the browse. The account is
 *  already on Reddit, mid-session, so it goes straight to the search bar. */
export const RECENT_WARMUP_MS = 15 * 60_000;

/** Why there is no lead, or '' when there is one. */
export type LeadSkip = '' | 'recent-warmup' | 'chance';

export interface BrowseLead {
  plan: WarmupLoopPlan;
  skipped: LeadSkip;
  day: number;
  upvoteChance: number;
  upvoteBudget: number;
  seed: number | null;
  estimatedSec: number;
}

export interface BrowseLeadInput {
  /** The account document, as stored. Read defensively. */
  account: Record<string, unknown>;
  /** The community the comment is going to. Kept out of the lead. */
  targetSubreddit: string;
  nowMs: number;
  /** When this account's last warm-up session finished, or 0. */
  lastWarmupAtMs?: number;
  /** Pass one to reproduce a lead exactly; omit for a fresh roll. */
  seed?: number;
  /** The skip roll, 0..1. Injected so a test can decide it. */
  skipRoll?: number;
}

const NO_LEAD = (skipped: LeadSkip): BrowseLead => ({
  plan: [],
  skipped,
  day: 0,
  upvoteChance: 0,
  upvoteBudget: 0,
  seed: null,
  estimatedSec: 0,
});

const toMillis = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0;

/**
 * Compose the lead for one job.
 *
 * Built from the account's own warm-up communities, keywords and upvote curve,
 * so it browses what that account always browses and votes as boldly as its
 * age and experience allow — no more.
 */
export function composeBrowseLead(input: BrowseLeadInput): BrowseLead {
  const { account, nowMs } = input;
  const target = input.targetSubreddit.trim().toLowerCase();

  if (input.lastWarmupAtMs && nowMs - input.lastWarmupAtMs >= 0 && nowMs - input.lastWarmupAtMs < RECENT_WARMUP_MS) {
    return NO_LEAD('recent-warmup');
  }
  if ((input.skipRoll ?? Math.random()) < LEAD_SKIP_CHANCE) return NO_LEAD('chance');

  // The same two clocks the warm-up run route reads: it can never act older
  // than it is, nor more experienced than it has earned.
  const ageDay = warmupDayFor(toMillis(account.warmupStartedAt), nowMs);
  const day = Math.max(1, Math.min(60, warmupBoldnessDay(ageDay, Number(account.warmupSessionsCompleted) || 0)));

  const communities = normalizeCommunityList(account.warmupCommunities).filter((c) => c.name !== target);
  const tagged = communitiesForRole(communities, 'browse');
  const subreddits = (tagged.length ? tagged : normalizeSubredditList(account.warmupSubreddits)).filter(
    (s) => s.toLowerCase() !== target,
  );
  const lists = {
    subreddits,
    searchTargets: subreddits,
    // Never joins — see the header.
    joinTargets: [] as string[],
    keywords: normalizeKeywordList(account.warmupKeywords),
    keywordsByCommunity: keywordsByCommunity(communities),
  };

  const policy = normalizeWarmupPolicy({
    ...(account.warmupPolicy as object | undefined),
    ...lists,
    sessionLength: LEAD_SESSION_LENGTH,
  }) ?? { ...DEFAULT_POLICY, ...lists, sessionLength: LEAD_SESSION_LENGTH };

  const session = composeWarmupSession({ day, policy, seed: input.seed, kind: 'browse' });
  const plan = session.plan.filter((s) => s.type !== 'join_subreddit');

  return {
    plan,
    skipped: '',
    day: session.day,
    upvoteChance: session.upvoteChance,
    upvoteBudget: session.upvoteBudget,
    seed: session.seed,
    estimatedSec: session.estimatedSec,
  };
}

/** What goes on the job next to the plan — enough to explain the lead later
 *  without recomposing it. */
export function browseLeadMeta(lead: BrowseLead) {
  return {
    skipped: lead.skipped,
    day: lead.day,
    upvoteChance: lead.upvoteChance,
    upvoteBudget: lead.upvoteBudget,
    seed: lead.seed,
    estimatedSec: lead.estimatedSec,
  };
}

export const LEAD_SKIP_LABEL: Record<Exclude<LeadSkip, ''>, string> = {
  'recent-warmup': 'No browse first — this account had just finished a warm-up session.',
  chance: 'No browse first this time — it opens on the home feed and goes to search.',
};

/** Defensive parse for a lead read back from a job document — the display must
 *  never crash on an old or hand-edited one. Unknown step types are dropped. */
export function normalizeBrowsePlan(raw: unknown): WarmupLoopPlan {
  if (!Array.isArray(raw)) return [];
  const out: WarmupLoopPlan = [];
  for (const entry of raw.slice(0, MAX_STEPS)) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.type !== 'string' || !(r.type in WARMUP_LOOP_LABELS)) continue;
    out.push({
      type: r.type as WarmupLoopActionType,
      params: (r.params && typeof r.params === 'object' ? r.params : {}) as WarmupLoopPlan[number]['params'],
      gapAfterSec: Number(r.gapAfterSec ?? 0),
      jitterPct: Number(r.jitterPct ?? 0),
    });
  }
  return out;
}

export function normalizeLeadSkip(raw: unknown): LeadSkip {
  const s = raw && typeof raw === 'object' ? (raw as { skipped?: unknown }).skipped : '';
  return s === 'recent-warmup' || s === 'chance' ? s : '';
}
