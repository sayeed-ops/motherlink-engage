// Per-account comment-karma settings.
//
// PURE, and normalising rather than validating: an account document written
// before this feature existed has none of these fields, and must read as "off,
// with sensible numbers" rather than as an error. Same posture and same storage
// argument as normalizeWarmupPolicy — a small behavioural config held as a field
// on `accounts/{id}`, so it rides the existing client subscription and needs no
// rules change (accounts are `allow write: if false`; writes are server-only and
// gated on `accounts.manage`).

import { LISTING_FEEDS, type ListingFeed } from '../reader/discovery';
import { DEFAULT_LIMITS, type SelectLimits } from './select';
import { communitiesForRole, keywordsByCommunity, type WarmupCommunity } from '../subreddits';
import type { CommentPersona } from './generate';

export interface CommentKarmaSettings {
  /** Master switch. Default FALSE: an account does nothing until someone turns
   *  it on for that account, because the alternative is a feature that starts
   *  spending money and reputation on every account the moment it deploys. */
  enabled: boolean;

  /**
   * Approve without a human.
   *
   * Both paths ship together on purpose. The reviewed path and the automatic
   * path run the SAME pipeline and the same gates; auto only decides who says
   * yes at the end. Building review first and automation later would mean
   * writing the interesting half twice, and the second version would be the one
   * nobody tested.
   */
  autoPost: boolean;

  /** Who this account is. Fixed, not regenerated per comment. */
  persona: CommentPersona;

  /** Brands, clients and domains this account must never mention. Account-scoped
   *  karma carries no narrative — this is the wall between it and the growth
   *  pipeline. */
  bannedTerms: string[];

  /** Comments per rolling day. A SEPARATE rail from the account's posting cap:
   *  spending the posting budget on warm-up comments would silently starve the
   *  thing the account exists for. Enforced at enqueue in Phase 5. */
  dailyCap: number;
  /** Minimum gap between two comments from this account. */
  minIntervalMinutes: number;

  /** Total actions per rolling day across replies AND comments. Reads
   *  `postCountToday` without writing it — what someone reading the profile
   *  sees is total activity, and it does not care which of our two systems
   *  produced each one. */
  combinedDailyCap: number;

  /** Comments per subreddit per rolling day. Three in one small community in a
   *  day is the most visible pattern there is, to exactly the people most able
   *  to act on it. */
  maxPerSubredditPerDay: number;

  /**
   * Switches for finding out whether the machinery works.
   *
   * WHY THIS EXISTS AT ALL. Every stage of this system is built to say no, and
   * most of them are right to. The consequence is that an operator with a fresh
   * account cannot tell "the gates are working" apart from "something is
   * broken", because both look like a list of skips. These switches force the
   * pipeline past its own judgement so the parts after it can be exercised.
   *
   * WHAT THEY CANNOT DO. They reach JUDGEMENT_REJECTS — predictions about
   * whether a comment will be seen — and nothing else. They cannot reach
   * SAFETY_REJECTS, they cannot silence the mechanical validators, and they
   * cannot silence the conflict gate. Relaxing those would not find more
   * candidates, it would find ways to get an account banned, and there is a
   * test asserting they stay unreachable.
   *
   * A draft produced with any of these on is marked `relaxed` and CANNOT be
   * auto-approved. A human has to look at it, because that is the entire
   * purpose of having written it.
   */
  relax: CommentRelaxations;

  /**
   * What counts as a thread worth entering.
   *
   * EVERY ONE OF THESE IS A PRIOR, not a measurement — they were written down
   * by someone who had never seen an outcome, and select.ts says so in as many
   * words. They live here rather than as constants because the operator is the
   * one watching scans get refused, and a threshold nobody can move is a
   * threshold nobody can test.
   *
   * They also differ enormously by room: 60 existing comments is a crowd in
   * r/frugal and the first ninety seconds in r/AskReddit. Per-community values
   * are the obvious next step; this is per-account.
   */
  limits: SelectLimits;

  /**
   * How posts are found.
   *
   * `feed` reads the community's own rising/hot feed — what a person opening
   * that subreddit would actually see, including the thread taking off right
   * now for reasons nobody predicted. Free (Reddit RSS, no key), but it can
   * only screen on age, so more of the paid reads turn out to be rejects.
   *
   * `search` asks Crawlzo for the community's keywords. One billed call, but it
   * returns full metadata, so the free screen throws most candidates away
   * before anything else is paid for. Better when you want the account kept to
   * specific topics; blind to everything nobody thought to type in.
   */
  discovery: 'feed' | 'search';

  /** Which feeds `feed` mode may read. One is picked per scan. */
  feeds: ListingFeed[];

  /**
   * Derive the age window from each community's own pace.
   *
   * One window cannot serve r/AskReddit (25 posts under twenty minutes old) and
   * r/budget (median post age seventy-five hours). The feed is fetched free on
   * every scan and its median age IS the community's pace, so the window can be
   * measured rather than configured — the same move as copying comment length
   * from the thread instead of choosing it.
   *
   * The account's `maxAgeHours` still caps the top of the derived window,
   * because the enqueue re-checks staleness against it.
   */
  adaptWindow: boolean;

  /**
   * How many threads one scan may read in full.
   *
   * The cost control. Search is one billed call; every thread read is another,
   * and Crawlzo bills for 404s too. Three is enough for the screen to have
   * meant something and cheap enough to run often.
   */
  maxThreadsPerScan: number;
}

/** Testing switches. Every one of them makes the system worse at its job — that
 *  is what they are for. */
export interface CommentRelaxations {
  /** Write a comment even when the thread has nothing missing. Produces filler
   *  BY DEFINITION — the design's whole argument is that filler is what gets an
   *  account spotted — so it exists to prove generation works, not to post. */
  ignoreGap: boolean;
  /** Enter threads the scorer predicts will not be seen: crowded, unbeatable,
   *  outside the age window, not rising, score hidden. */
  ignoreOpportunity: boolean;
  /** Ignore the account's own rhythm — cadence, repeated openings, uniform
   *  lengths. Useful on a fresh account with no history to speak of. */
  ignoreBotTell: boolean;
  /** Take a candidate even when the critic chose none of them. */
  ignoreCritic: boolean;
}

export const NO_RELAXATIONS: CommentRelaxations = {
  ignoreGap: false,
  ignoreOpportunity: false,
  ignoreBotTell: false,
  ignoreCritic: false,
};

/** Is anything switched off? Drives the warning in the panel and the refusal to
 *  auto-approve. */
export function anyRelaxed(relax: CommentRelaxations): boolean {
  return Object.values(relax).some(Boolean);
}

export const DEFAULT_COMMENT_SETTINGS: CommentKarmaSettings = {
  enabled: false,
  autoPost: false,
  persona: { topics: [], situation: '', neverClaims: [] },
  bannedTerms: [],
  // Rising first: it is the only ordering that finds a thread while there is
  // still room at the top, which is the whole premise of the selection model.
  discovery: 'feed',
  feeds: ['rising', 'hot'],
  adaptWindow: true,
  relax: { ...NO_RELAXATIONS },
  limits: { ...DEFAULT_LIMITS },
  dailyCap: 3,
  minIntervalMinutes: 90,
  combinedDailyCap: 6,
  maxPerSubredditPerDay: 1,
  maxThreadsPerScan: 3,
};

const LIMITS = {
  dailyCap: { min: 1, max: 20 },
  minIntervalMinutes: { min: 15, max: 1440 },
  combinedDailyCap: { min: 1, max: 30 },
  maxPerSubredditPerDay: { min: 1, max: 5 },
  maxThreadsPerScan: { min: 1, max: 8 },
};

function clamp(value: unknown, { min, max }: { min: number; max: number }, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function strings(value: unknown, max: number, maxLen = 60): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.trim().slice(0, maxLen);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Bounds on the bounds.
 *
 *  Wide, because these are the operator's to explore — the whole point is to
 *  find out where they should sit — but not unbounded: a maxAgeHours of 500
 *  would have the account commenting on week-old threads nobody will ever read
 *  again, which is not a setting anyone means to choose. */
const LIMIT_BOUNDS: Record<keyof SelectLimits, { min: number; max: number }> = {
  minAgeMinutes: { min: 0, max: 720 },
  maxAgeHours: { min: 1, max: 72 },
  maxComments: { min: 1, max: 2000 },
  maxTopCommentScore: { min: 1, max: 100_000 },
  minUpvoteRatio: { min: 0, max: 1 },
  visibleCommentScore: { min: 1, max: 5000 },
};

function normalizeRelaxations(raw: unknown): CommentRelaxations {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ignoreGap: o.ignoreGap === true,
    ignoreOpportunity: o.ignoreOpportunity === true,
    ignoreBotTell: o.ignoreBotTell === true,
    ignoreCritic: o.ignoreCritic === true,
  };
}

function normalizeLimits(raw: unknown): SelectLimits {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_BOUNDS) as (keyof SelectLimits)[]) {
    const bounds = LIMIT_BOUNDS[key];
    // "0,55" — a browser in a comma-decimal locale hands the value back exactly
    // as the user typed it, and Number() makes NaN of it. Silently keeping the
    // old value there is the worst outcome: the field shows the new number, the
    // scan uses the old one, and nothing says so.
    const raw = o[key];
    const n = Number(typeof raw === 'string' ? raw.replace(',', '.') : raw);
    if (!Number.isFinite(n)) continue;
    // The ratio is the one that is not a whole number, and rounding it would
    // quietly turn 0.75 into 1.
    const value = key === 'minUpvoteRatio' ? n : Math.round(n);
    out[key] = Math.min(bounds.max, Math.max(bounds.min, value));
  }
  return out;
}

/** Unknown values dropped; an empty list falls back to the default rather than
 *  leaving a mode with nothing to read. */
function normalizeFeeds(raw: unknown): ListingFeed[] {
  const list = Array.isArray(raw) ? LISTING_FEEDS.filter((f) => raw.includes(f)) : [];
  return list.length ? list : [...DEFAULT_COMMENT_SETTINGS.feeds];
}

function normalizePersona(raw: unknown): CommentPersona {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    topics: strings(o.topics, 12, 40),
    situation: typeof o.situation === 'string' ? o.situation.trim().slice(0, 600) : '',
    neverClaims: strings(o.neverClaims, 12, 60),
  };
}

/** Read whatever is on the account document as settings. Never throws. */
export function normalizeCommentSettings(raw: unknown): CommentKarmaSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    // `=== true` rather than `!== false`: absent means OFF for both switches.
    // The opposite of the canUseSharedKeys convention, and deliberately so —
    // that one is a permission being removed, this one is spending being
    // started, and an absent field must never start spending.
    enabled: o.enabled === true,
    autoPost: o.autoPost === true,
    discovery: o.discovery === 'search' ? 'search' : 'feed',
    feeds: normalizeFeeds(o.feeds),
    // Absent means ON, unlike the two spending switches — an account saved
    // before this existed gets the behaviour that works for it, and the setting
    // starts nothing and costs nothing.
    adaptWindow: o.adaptWindow !== false,
    // Absent means OFF for every one of these, like the spending switches and
    // for the same reason: a relaxation nobody chose must never be in force.
    relax: normalizeRelaxations(o.relax),
    limits: normalizeLimits(o.limits),
    persona: normalizePersona(o.persona),
    bannedTerms: strings(o.bannedTerms, 25, 60),
    dailyCap: clamp(o.dailyCap, LIMITS.dailyCap, DEFAULT_COMMENT_SETTINGS.dailyCap),
    minIntervalMinutes: clamp(
      o.minIntervalMinutes,
      LIMITS.minIntervalMinutes,
      DEFAULT_COMMENT_SETTINGS.minIntervalMinutes,
    ),
    combinedDailyCap: clamp(
      o.combinedDailyCap,
      LIMITS.combinedDailyCap,
      DEFAULT_COMMENT_SETTINGS.combinedDailyCap,
    ),
    maxPerSubredditPerDay: clamp(
      o.maxPerSubredditPerDay,
      LIMITS.maxPerSubredditPerDay,
      DEFAULT_COMMENT_SETTINGS.maxPerSubredditPerDay,
    ),
    maxThreadsPerScan: clamp(
      o.maxThreadsPerScan,
      LIMITS.maxThreadsPerScan,
      DEFAULT_COMMENT_SETTINGS.maxThreadsPerScan,
    ),
  };
}

/** One community and the keywords a scan may search it for. */
export interface CommunityKeywords {
  subreddit: string;
  keywords: string[];
}

/**
 * Where a scan may look, and what it may search for.
 *
 * PER-COMMUNITY KEYWORDS FIRST, THE ACCOUNT'S POOL AS THE FALLBACK — the same
 * rule the browsing walk already follows, and stated in the community model
 * itself: "an unpaired community falls back to the account's global keyword
 * pool". Comment karma originally demanded per-community keywords and refused
 * without them, which made an account with ten perfectly good global keywords
 * look like a broken feature.
 *
 * A pairing is still better than the pool. It is the only way the system can
 * know that one query plausibly reaches one community, so a global keyword can
 * genuinely surface nothing — that is a wasted search, not a wasted comment,
 * and the screen rejects the results for free.
 *
 * ONE IMPLEMENTATION, TWO CALL SITES: the panel decides whether the button is
 * usable from this, and the server scans from it. They cannot disagree.
 */
export function commentPairs(
  communities: WarmupCommunity[],
  accountKeywords: string[],
): CommunityKeywords[] {
  const byCommunity = keywordsByCommunity(communities);
  return communitiesForRole(communities, 'comment').map((subreddit) => ({
    subreddit,
    keywords: byCommunity[subreddit]?.length ? byCommunity[subreddit] : accountKeywords,
  }));
}

/** Is this account configured well enough to scan?
 *
 *  Returns the reason, so the panel can say what is missing rather than
 *  disabling a button with no explanation — and says WHICH of the two things is
 *  missing, because "nowhere to look" and "nothing to search for" have
 *  different fixes on different tabs. */
export function scanReadiness(
  settings: CommentKarmaSettings,
  pairs: CommunityKeywords[],
): { ok: boolean; reason: string } {
  if (!settings.enabled) return { ok: false, reason: 'Comment karma is switched off for this account.' };
  if (!pairs.length) {
    return {
      ok: false,
      reason: 'No communities are tagged Comment on the Communities tab, so there is nowhere to look.',
    };
  }
  // Feed mode needs no keywords — that is the point of it. Demanding them here
  // would keep the old constraint alive under a new name.
  if (settings.discovery === 'feed') return { ok: true, reason: '' };
  if (!pairs.some((p) => p.keywords.length)) {
    return {
      ok: false,
      reason:
        'Your Comment-tagged communities have no keywords, and the account has no keyword pool either. Search is the only way in — Reddit has no "what is hot here" endpoint — so add keywords on the Communities tab.',
    };
  }
  return { ok: true, reason: '' };
}
