// The account's community list — which subreddits a warm-up may touch, and what
// each one is FOR.
//
// PURE by design — no 'server-only', no fetch — because both halves of the
// communities editor need it. `normalizeSubreddit` in rss.ts is the obvious
// home, but that file is `server-only` (it imports the proxy fetcher), which is
// why the project settings page already carries its own private copy. This is
// the isomorphic one, same convention as approach.ts and warmupWalk.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// ONE TAGGED LIST, NOT FOUR LISTS
//
//   r/budget           browse, follow, comment, post
//   r/personalfinance  browse, follow
//   r/cooking          browse, comment
//   r/hiking           browse
//
// Each warm-up component draws only the entries tagged for it, so the SAME
// machinery does generic karma farming or client-niche commenting — the
// difference is a tag, not a code path.
//
// Four parallel lists were the alternative and are worse: the same subreddit
// lands in three of them and they drift apart silently, which is the exact
// failure the EMPTY_REDDIT_CONFIG constant exists to prevent one level up.
// ════════════════════════════════════════════════════════════════════════════
//
// WHY NORMALISATION MUST MATCH THE CONFIG ROUTE EXACTLY:
// this list can be SYNCED from a project's `targetSubreddits`, which are
// normalised by app/api/projects/[projectId]/reddit/config/route.ts. If the two
// rules differed by so much as case, a synced name would never compare equal to
// its source and every sync would append a near-duplicate that dedupe could not
// see. Keep them identical: strip a leading r/ or /r/, drop anything that is not
// a legal subreddit character, lowercase.

/** What a community is used for. Roles are additive — a subreddit the account
 *  will eventually post in is usually also one it browses, follows and comments
 *  in, and that progression is the point. */
export type WarmupCommunityRole = 'browse' | 'follow' | 'comment' | 'post';

export const COMMUNITY_ROLES: readonly WarmupCommunityRole[] = ['browse', 'follow', 'comment', 'post'];

export const COMMUNITY_ROLE_LABEL: Record<WarmupCommunityRole, string> = {
  browse: 'Browse',
  follow: 'Follow',
  comment: 'Comment',
  post: 'Post',
};

export const COMMUNITY_ROLE_HELP: Record<WarmupCommunityRole, string> = {
  browse: 'The walk may open this community and scroll it.',
  follow: 'The account may join this community during a session.',
  comment: 'Karma-building comments may be placed here.',
  post: 'Submissions may eventually be made here.',
};

export interface WarmupCommunity {
  /** Bare subreddit name, normalised — no r/ prefix, lowercase. */
  name: string;
  roles: WarmupCommunityRole[];
  /** Topics expected to surface this community in Reddit search.
   *
   *  NOT just a hit-rate optimisation. The composer runs with no access to the
   *  live page, so it cannot know what a query will return — the pairing is the
   *  only way it can know that ONE search plausibly reaches TWO targets, which is
   *  what makes the multi-target join flow composable at all. Without it, a
   *  second leg would be guesswork.
   *
   *  Optional: an unpaired community falls back to the account's global keyword
   *  pool, and to a plain name search when there is no query at all. */
  keywords?: string[];
}

/** The policy cap. Deliberately the same 40 that `normalizeWarmupPolicy` applies
 *  to `subreddits`/`searchTargets` in warmupWalk.ts — storing more than the walk
 *  can hold would silently drop entries somewhere the operator cannot see. */
export const MAX_WARMUP_COMMUNITIES = 40;
export const MAX_WARMUP_KEYWORDS = 40;

/** Roles given to a community pulled in by sync-from-project.
 *
 *  Browse and follow only, deliberately. A project's target subreddits are where
 *  the account will EVENTUALLY post for that client, and joining early is the
 *  compounding asset — but commenting and posting there are consequential enough
 *  that an operator should opt in per community rather than inherit it from a
 *  bulk sync. Widening a role is one click; discovering that a sync silently
 *  authorised submissions is a bad afternoon. */
export const SYNC_DEFAULT_ROLES: WarmupCommunityRole[] = ['browse', 'follow'];

/** One name, normalised. Returns '' when nothing legal survives. */
export function normalizeSubredditName(raw: string): string {
  return raw
    .replace(/^\/?r\//i, '')
    .replace(/[^a-z0-9_]/gi, '')
    .toLowerCase();
}

/**
 * Normalise an untrusted array of BARE subreddit names — no roles.
 *
 * Still needed alongside the tagged list: request bodies and the legacy
 * `warmupSubreddits` field carry plain names, and the walk itself consumes plain
 * names once roles have been resolved. Order preserved, deduped, capped.
 */
export function normalizeSubredditList(raw: unknown, cap = MAX_WARMUP_COMMUNITIES): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = normalizeSubredditName(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

function normalizeRoles(raw: unknown): WarmupCommunityRole[] {
  if (!Array.isArray(raw)) return [];
  const out: WarmupCommunityRole[] = [];
  for (const role of COMMUNITY_ROLES) {
    if (raw.includes(role)) out.push(role);
  }
  return out;
}

/**
 * Coerce anything (a saved list, a request body) into a safe community list.
 *
 * Entries with no legal name, or no roles at all, are DROPPED — a community
 * tagged for nothing is not a preference, it is a row the operator forgot to
 * finish, and keeping it would make "why is this never visited" a debugging
 * session. Order is preserved so the list stays as it was built; a Set alone
 * would dedupe but lose first-seen position.
 */
export function normalizeCommunityList(raw: unknown, cap = MAX_WARMUP_COMMUNITIES): WarmupCommunity[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WarmupCommunity[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string') continue;
    const name = normalizeSubredditName(e.name);
    if (!name || seen.has(name)) continue;
    const roles = normalizeRoles(e.roles);
    if (!roles.length) continue;
    const keywords = normalizeKeywordList(e.keywords, 10);
    seen.add(name);
    out.push(keywords.length ? { name, roles, keywords } : { name, roles });
    if (out.length >= cap) break;
  }
  return out;
}

/** Keywords are free text, not subreddit names — they keep spaces and case is
 *  folded only for comparison. Trimmed, deduped, capped. */
export function normalizeKeywordList(raw: unknown, cap = MAX_WARMUP_KEYWORDS): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const k = entry.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= cap) break;
  }
  return out;
}

/** keyword -> communities it is expected to surface. The shape the composer
 *  consumes, derived from the per-community pairings. */
export function keywordsByCommunity(list: WarmupCommunity[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of list) {
    if (c.keywords?.length) out[c.name] = c.keywords;
  }
  return out;
}

/** The bare names tagged for one role — what each component actually consumes. */
export function communitiesForRole(list: WarmupCommunity[], role: WarmupCommunityRole): string[] {
  return list.filter((c) => c.roles.includes(role)).map((c) => c.name);
}

/**
 * Merge synced names into an existing list.
 *
 * MERGES rather than replaces, and never narrows. One account is warmed for one
 * client today and may be warmed for another tomorrow, so a sync must not drop
 * the first client's communities. A name already present keeps whatever roles
 * the operator gave it and gains any it was missing from `roles` — syncing can
 * only ever widen what a community is for, never take a role away, because
 * silently revoking `post` from a community the operator had authorised is the
 * kind of change nobody notices until a session does less than expected.
 */
export function mergeCommunityNames(
  existing: WarmupCommunity[],
  incomingNames: string[],
  roles: WarmupCommunityRole[] = SYNC_DEFAULT_ROLES,
  cap = MAX_WARMUP_COMMUNITIES,
): { merged: WarmupCommunity[]; added: string[]; widened: string[] } {
  const merged = normalizeCommunityList(existing, cap);
  const byName = new Map(merged.map((c) => [c.name, c]));
  const grant = normalizeRoles(roles);
  const added: string[] = [];
  const widened: string[] = [];

  for (const raw of incomingNames) {
    if (typeof raw !== 'string') continue;
    const name = normalizeSubredditName(raw);
    if (!name || !grant.length) continue;

    const found = byName.get(name);
    if (found) {
      const missing = grant.filter((r) => !found.roles.includes(r));
      if (missing.length) {
        // Re-derive through COMMUNITY_ROLES so roles stay in canonical order
        // however they were accumulated.
        found.roles = normalizeRoles([...found.roles, ...missing]);
        widened.push(name);
      }
      continue;
    }

    if (merged.length >= cap) continue;
    const entry: WarmupCommunity = { name, roles: [...grant] };
    merged.push(entry);
    byName.set(name, entry);
    added.push(name);
  }

  return { merged, added, widened };
}
