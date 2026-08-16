// Per-account comment-karma settings.
//
// PURE, and normalising rather than validating: an account document written
// before this feature existed has none of these fields, and must read as "off,
// with sensible numbers" rather than as an error. Same posture and same storage
// argument as normalizeWarmupPolicy — a small behavioural config held as a field
// on `accounts/{id}`, so it rides the existing client subscription and needs no
// rules change (accounts are `allow write: if false`; writes are server-only and
// gated on `accounts.manage`).

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
   * How many threads one scan may read in full.
   *
   * The cost control. Search is one billed call; every thread read is another,
   * and Crawlzo bills for 404s too. Three is enough for the screen to have
   * meant something and cheap enough to run often.
   */
  maxThreadsPerScan: number;
}

export const DEFAULT_COMMENT_SETTINGS: CommentKarmaSettings = {
  enabled: false,
  autoPost: false,
  persona: { topics: [], situation: '', neverClaims: [] },
  bannedTerms: [],
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
  if (!pairs.some((p) => p.keywords.length)) {
    return {
      ok: false,
      reason:
        'Your Comment-tagged communities have no keywords, and the account has no keyword pool either. Search is the only way in — Reddit has no "what is hot here" endpoint — so add keywords on the Communities tab.',
    };
  }
  return { ok: true, reason: '' };
}
