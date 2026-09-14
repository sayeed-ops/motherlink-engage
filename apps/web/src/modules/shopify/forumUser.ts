// A Shopify Community user's public standing, read from `/u/{username}.json`.
//
// PURE — the fetch is reader.fetchForumUser.
//
// Why this matters for posting: Discourse limits what a new account may do by
// TRUST LEVEL. At 0 ("new user") links, images and replies-per-topic are capped,
// and a reply that breaks a cap is refused at submit. The level is public, so
// the app can show it beside the account and say what it implies — rather than
// discovering it as a failed job.
//
// Fields confirmed present on the live site 2026-09-13: trust_level, created_at,
// badge_count, time_read, recent_time_read.

export interface ForumStats {
  trustLevel: number | null;
  badgeCount: number | null;
  /** Seconds spent reading, all time — Discourse's own measure of participation. */
  timeReadSec: number | null;
  joinedAtMs: number | null;
  fetchedAtMs: number;
}

export const TRUST_LEVEL_LABEL: Record<number, string> = {
  0: 'New user',
  1: 'Basic',
  2: 'Member',
  3: 'Regular',
  4: 'Leader',
};

/** What a trust level means for posting, in one line. */
export function trustLevelNote(level: number | null): string {
  if (level === null) return 'Trust level not read yet.';
  if (level === 0) return 'New user — links and replies are capped by the forum; brand replies with links will likely be refused.';
  if (level === 1) return 'Basic — most new-user caps lifted; keep links sparing.';
  return 'Established — the forum’s new-account caps no longer apply.';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class ForumUserNotFound extends Error {}

export function parseForumUser(raw: unknown, nowMs: number): ForumStats {
  const user = (raw as { user?: Record<string, unknown> } | null)?.user;
  if (!user || typeof user !== 'object') throw new ForumUserNotFound('The community did not return that user.');
  const created = typeof user.created_at === 'string' ? Date.parse(user.created_at) : NaN;
  return {
    trustLevel: num(user.trust_level),
    badgeCount: num(user.badge_count),
    timeReadSec: num(user.time_read),
    joinedAtMs: Number.isFinite(created) ? created : null,
    fetchedAtMs: nowMs,
  };
}
