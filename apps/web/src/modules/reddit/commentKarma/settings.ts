// Per-account comment-karma settings.
//
// PURE, and normalising rather than validating: an account document written
// before this feature existed has none of these fields, and must read as "off,
// with sensible numbers" rather than as an error. Same posture and same storage
// argument as normalizeWarmupPolicy — a small behavioural config held as a field
// on `accounts/{id}`, so it rides the existing client subscription and needs no
// rules change (accounts are `allow write: if false`; writes are server-only and
// gated on `accounts.manage`).

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
  maxThreadsPerScan: 3,
};

const LIMITS = {
  dailyCap: { min: 1, max: 20 },
  minIntervalMinutes: { min: 15, max: 1440 },
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
    maxThreadsPerScan: clamp(
      o.maxThreadsPerScan,
      LIMITS.maxThreadsPerScan,
      DEFAULT_COMMENT_SETTINGS.maxThreadsPerScan,
    ),
  };
}

/** Is this account configured well enough to scan?
 *
 *  Returns the reason, so the panel can say what is missing rather than
 *  disabling a button with no explanation. */
export function scanReadiness(
  settings: CommentKarmaSettings,
  commentCommunities: string[],
): { ok: boolean; reason: string } {
  if (!settings.enabled) return { ok: false, reason: 'Comment karma is switched off for this account.' };
  if (!commentCommunities.length) {
    return {
      ok: false,
      reason: 'No communities are tagged Comment on the Communities tab, so there is nowhere to look.',
    };
  }
  return { ok: true, reason: '' };
}
