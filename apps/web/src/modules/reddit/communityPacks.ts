import { MAX_WARMUP_COMMUNITIES, normalizeKeywordList, normalizeSubredditName } from './subreddits';

// Community packs: a named set of subreddits, each with the searches that bring
// it up, that can be added to many accounts' warm-up lists in one go.
//
// Packs live in Firestore (`communityPacks`), not in code. Applying one goes
// through the same path as the community finder, so every subreddit waits for
// its check on the account's first visit.

export interface PackCommunity {
  name: string;
  keywords: string[];
  /** Allow comments here (still subject to the visit check). */
  comment: boolean;
}

export interface CommunityPack {
  id: string;
  name: string;
  communities: PackCommunity[];
}

/** How many of a community's keywords each account gets. */
export const KEYWORDS_PER_ACCOUNT = 3;

export function normalizePackCommunities(raw: unknown): PackCommunity[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PackCommunity[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? normalizeSubredditName(e.name) : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, keywords: normalizeKeywordList(e.keywords, 6), comment: e.comment === true });
    if (out.length >= MAX_WARMUP_COMMUNITIES) break;
  }
  return out;
}

export function normalizePack(id: string, raw: unknown): CommunityPack | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : '';
  if (!name) return null;
  return { id, name, communities: normalizePackCommunities(o.communities) };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * One account's copy of the pack, so accounts on the same pack do not look
 * alike: each gets a random few of every community's keywords, and the order is
 * shuffled within thirds, so the pack's first communities still come early.
 */
export function variantForAccount(communities: PackCommunity[], rand: () => number = Math.random): PackCommunity[] {
  const third = Math.max(1, Math.ceil(communities.length / 3));
  const out: PackCommunity[] = [];
  for (let i = 0; i < communities.length; i += third) out.push(...shuffle(communities.slice(i, i + third), rand));
  return out.map((c) => ({ ...c, keywords: shuffle(c.keywords, rand).slice(0, KEYWORDS_PER_ACCOUNT) }));
}
