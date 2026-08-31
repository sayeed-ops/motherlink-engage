// Which parts of Covers we may read, and what each is FOR.
//
// PURE. Same shape as modules/reddit/subreddits.ts, and deliberately so: one
// tagged list, roles per entry, never four parallel lists. The same machinery
// then does watching or replying depending on a tag rather than a code path.
//
// ════════════════════════════════════════════════════════════════════════════
// THE ROLES ARE THE FORUM'S OWN RULES, WRITTEN DOWN
//
// Covers permits commercial posts in Website Promotions and treats them as
// bannable elsewhere. That is not a preference to encode in a prompt; it is a
// property of each section, and it decides which reply variants are even
// eligible before a model is called.
//
//   watch    — read it, learn the register, never post
//   reply    — a useful reply is welcome; naming a sportsbook is not
//   promote  — commercial content is what the section is for
//
// `promote` is held by exactly one section, and that is the whole point of the
// list. A future editor adding it to a sports forum should have to type it
// deliberately, next to this comment.
// ════════════════════════════════════════════════════════════════════════════

export type SectionRole = 'watch' | 'reply' | 'promote';

export const SECTION_ROLES: readonly SectionRole[] = ['watch', 'reply', 'promote'] as const;

export const SECTION_ROLE_LABEL: Record<SectionRole, string> = {
  watch: 'Watch only',
  reply: 'Reply, no promotion',
  promote: 'Promotion permitted',
};

export interface CoversSection {
  /** The path segment, e.g. `nfl-betting-21`. The id in every URL. */
  slug: string;
  name: string;
  roles: SectionRole[];
  /** Sport or subject, for entity extraction and the event clock. */
  sport: string | null;
}

/**
 * The sections seen on covers.com/forum on 2026-08-30.
 *
 * A STARTING LIST, NOT A FIXED ONE. It is data, and a project overrides it in
 * its own config — the same way `targetSubreddits` overrides the Reddit list.
 * What it provides is a sane default with the roles already set correctly, so
 * nobody has to derive the promotion rule from the forum guidelines on day one.
 */
export const DEFAULT_SECTIONS: readonly CoversSection[] = [
  { slug: 'nfl-betting-21', name: 'NFL Betting', roles: ['watch', 'reply'], sport: 'nfl' },
  { slug: 'nba-betting-22', name: 'NBA Betting', roles: ['watch', 'reply'], sport: 'nba' },
  { slug: 'mlb-betting-27', name: 'MLB Betting', roles: ['watch', 'reply'], sport: 'mlb' },
  { slug: 'nhl-betting-23', name: 'NHL Betting', roles: ['watch', 'reply'], sport: 'nhl' },
  { slug: 'college-football-33', name: 'NCAAF Betting', roles: ['watch', 'reply'], sport: 'ncaaf' },
  { slug: 'college-basketball-40', name: 'NCAAB Betting', roles: ['watch', 'reply'], sport: 'ncaab' },
  { slug: 'soccer-36', name: 'Soccer Betting', roles: ['watch', 'reply'], sport: 'soccer' },
  { slug: 'tennis-38', name: 'Tennis Betting', roles: ['watch'], sport: 'tennis' },
  // ⚠️ VERIFIED AGAINST THE LIVE FORUM INDEX 2026-08-31, not copied from a
  // screenshot. `general-discussion-25` was wrong and 302s; `tennis-37` answers
  // 200 but is not the slug the index links to. A wrong slug does not fail
  // loudly — it redirects or serves something else — so these are checked
  // against /forum rather than trusted.
  { slug: 'general-discussion-35', name: 'General Discussion', roles: ['watch'], sport: null },
] as const;

/** Normalise however an operator typed it: a full URL, a leading slash, or the
 *  slug on its own. Must match the parser's `section`, or a configured section
 *  would never compare equal to a scraped one. */
export function normaliseSection(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const fromUrl = /\/forum\/([a-z0-9-]+)/.exec(trimmed)?.[1];
  return (fromUrl ?? trimmed.replace(/^\/+|\/+$/g, '')).replace(/[^a-z0-9-]/g, '');
}

export function sectionsForRole(sections: readonly CoversSection[], role: SectionRole): CoversSection[] {
  return sections.filter((s) => s.roles.includes(role));
}

/**
 * May a reply that names the client be posted in this section?
 *
 * The answer the variant eligibility mask needs, and it is deliberately a
 * function of the SECTION rather than of the reply. An unknown section — one
 * scraped but not configured — returns false: a section nobody has classified
 * is not a section anyone has said we may advertise in.
 */
export function promotionPermitted(sections: readonly CoversSection[], slug: string): boolean {
  const section = sections.find((s) => s.slug === normaliseSection(slug));
  return section?.roles.includes('promote') ?? false;
}

/** The URL of one page of a section listing. Page 1 has no suffix. */
export function sectionUrl(slug: string, page = 1, base = 'https://www.covers.com'): string {
  const s = normaliseSection(slug);
  return page > 1 ? `${base}/forum/${s}/${page}` : `${base}/forum/${s}`;
}
