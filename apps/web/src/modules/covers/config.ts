// The Covers module's per-project settings.
//
// PURE, including the validation. A settings object arriving from a browser is
// input, not configuration, and the route hands it straight to
// `normaliseCoversConfig` rather than trusting any of it — the same posture
// `modules/reddit/subreddits.ts` takes about a typed subreddit list.

import { DEFAULT_SECTIONS, SECTION_ROLES, normaliseSection, type CoversSection, type SectionRole } from './sections';

export interface CoversModuleConfig {
  /** The sections this client reads, with their roles. Overrides the shipped
   *  defaults entirely once saved — see DEFAULT_SECTIONS. */
  sections: CoversSection[];
  /**
   * How much one harvest may spend, in requests.
   *
   * Both are caps rather than targets, and they are here rather than hardcoded
   * in the reader because the bill is a client's, not the platform's: one
   * section page plus one request per thread read, each 1.2s apart.
   */
  pagesPerSection: number;
  maxThreadsPerScan: number;
}

/** Ceilings the reader also enforces. Duplicated deliberately: a settings screen
 *  that lets someone type 500 and then silently reads 25 is lying to them. */
export const MAX_PAGES_PER_SECTION = 5;
export const MAX_THREADS_PER_SCAN = 25;

export function defaultCoversConfig(): CoversModuleConfig {
  return {
    sections: DEFAULT_SECTIONS.map((s) => ({ ...s, roles: [...s.roles] })),
    pagesPerSection: 1,
    maxThreadsPerScan: 10,
  };
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(lo, Math.min(hi, v));
};

/**
 * Whatever arrived → a config that cannot break the reader.
 *
 * A section with no valid role is DROPPED rather than defaulted to `watch`.
 * Roles decide whether a reply may name the client, and inventing one on a
 * malformed row is exactly the kind of quiet default that ends with a promotion
 * in a section that bans them.
 */
export function normaliseCoversConfig(raw: unknown): CoversModuleConfig {
  const input = (raw ?? {}) as Partial<CoversModuleConfig>;
  const fallback = defaultCoversConfig();

  const sections = Array.isArray(input.sections)
    ? input.sections
        .map((s) => normaliseOne(s))
        .filter((s): s is CoversSection => s !== null)
        // One row per slug: the same section twice with different roles has no
        // defined answer to "may we promote here".
        .filter((s, i, all) => all.findIndex((o) => o.slug === s.slug) === i)
    : fallback.sections;

  return {
    sections,
    pagesPerSection: clamp(input.pagesPerSection, 1, MAX_PAGES_PER_SECTION, fallback.pagesPerSection),
    maxThreadsPerScan: clamp(input.maxThreadsPerScan, 0, MAX_THREADS_PER_SCAN, fallback.maxThreadsPerScan),
  };
}

function normaliseOne(raw: unknown): CoversSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<CoversSection>;

  const slug = typeof s.slug === 'string' ? normaliseSection(s.slug) : '';
  if (!slug) return null;

  const roles = Array.isArray(s.roles)
    ? (s.roles.filter((r) => SECTION_ROLES.includes(r as SectionRole)) as SectionRole[])
    : [];
  if (roles.length === 0) return null;

  const known = DEFAULT_SECTIONS.find((d) => d.slug === slug);

  return {
    slug,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 80) : (known?.name ?? slug),
    roles: [...new Set(roles)],
    // A sport we have no lexicon for is still recorded; entities.ts answers
    // "we do not know this league" from the sport, and cannot do that if the
    // sport was blanked on the way in.
    sport: typeof s.sport === 'string' && s.sport.trim() ? s.sport.trim().toLowerCase() : (known?.sport ?? null),
  };
}

/** The sport recorded for a section, or null when nobody has classified it.
 *  Never inferred from the slug: `general-discussion-25` looks like no sport and
 *  `soccer-36` looks like one, and a rule that reads slugs would be wrong the
 *  first time a section is renamed. */
export function sportForSection(config: CoversModuleConfig, slug: string): string | null {
  return config.sections.find((s) => s.slug === normaliseSection(slug))?.sport ?? null;
}
