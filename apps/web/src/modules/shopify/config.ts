// The Shopify Community module's per-project settings.
//
// PURE, including the validation — same posture as modules/covers/config.ts. A
// settings object arriving from a browser is INPUT, and the route hands it
// straight here rather than trusting any of it. Two of these fields end up in a
// URL path on somebody else's server and one is a request budget, so none of
// them are taken on faith.

import {
  DEFAULT_CATEGORIES,
  normaliseId,
  normaliseSlug,
  normaliseSort,
  type ShopifyCategory,
  type ShopifySort,
} from './categories';
import { DEFAULT_LIMITS, type ScreenLimits } from './topics';

export interface ShopifyModuleConfig {
  /** The boards this project reads. Replaces the shipped defaults entirely once
   *  saved — the operator may select ANY of the forty the catalogue lists, so
   *  this is never validated against the marketing six. */
  categories: ShopifyCategory[];
  /** Which ordering a fetch reads a board in. */
  sort: ShopifySort;
  /** Listing pages per board per fetch. A page is 30 topics (50 on `top`). */
  pagesPerCategory: number;
  /** The free screen's thresholds, so an operator can widen a slow board
   *  without a deploy — this is exactly the knob whose absence made 95% of a
   *  Covers corpus invisible with no way to say so. */
  limits: ScreenLimits;
}

/** Ceilings the reader also enforces. Duplicated deliberately: a settings
 *  screen that accepts 500 and then reads 20 is lying to the person using it. */
export const MAX_PAGES_PER_CATEGORY = 20;
export const MAX_CATEGORIES = 40;
/** Days. A year is already generous for a board whose slowest category turns
 *  over in months; beyond it the window stops meaning anything. */
export const MAX_QUIET_DAYS = 365;

export function defaultShopifyConfig(): ShopifyModuleConfig {
  return {
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    sort: 'latest',
    pagesPerCategory: 2,
    limits: { ...DEFAULT_LIMITS },
  };
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(lo, Math.min(hi, v));
};

/**
 * Whatever arrived → a config that cannot break the reader.
 *
 * A category missing an id or a slug is DROPPED rather than repaired. Both
 * halves are needed to address a Discourse board (`/c/{slug}/{id}`), and a row
 * we cannot build a URL for is not a board anyone can read — inventing a slug
 * from the name would produce a plausible URL pointing at the wrong place, or
 * at nothing, and the failure would look like an empty board rather than a bad
 * setting.
 */
export function normaliseShopifyConfig(raw: unknown): ShopifyModuleConfig {
  const input = (raw ?? {}) as Partial<ShopifyModuleConfig>;
  const fallback = defaultShopifyConfig();

  const categories = Array.isArray(input.categories)
    ? input.categories
        .map(normaliseCategory)
        .filter((c): c is ShopifyCategory => c !== null)
        // One row per id. The same board twice has no defined answer to "how
        // many pages of it do we read".
        .filter((c, i, all) => all.findIndex((o) => o.id === c.id) === i)
        .slice(0, MAX_CATEGORIES)
    : fallback.categories;

  return {
    // An empty selection is honoured, not silently refilled with the defaults.
    // Deselecting every board is a thing an operator may mean, and a fetch that
    // reads six boards they just unticked is worse than one that reads none.
    categories,
    sort: normaliseSort(input.sort),
    pagesPerCategory: clamp(input.pagesPerCategory, 1, MAX_PAGES_PER_CATEGORY, fallback.pagesPerCategory),
    limits: normaliseLimits(input.limits),
  };
}

function normaliseCategory(raw: unknown): ShopifyCategory | null {
  const r = (raw ?? {}) as Partial<ShopifyCategory>;
  const id = normaliseId(r.id);
  const slug = normaliseSlug(r.slug);
  if (id === null || !slug) return null;

  return {
    id,
    slug,
    name: String(r.name ?? '').trim().slice(0, 120) || slug,
    parentId: normaliseId(r.parentId),
    topicCount: typeof r.topicCount === 'number' && Number.isFinite(r.topicCount) ? Math.max(0, Math.round(r.topicCount)) : null,
  };
}

export function normaliseLimits(raw: unknown): ScreenLimits {
  const input = (raw ?? {}) as Partial<ScreenLimits>;
  return {
    quietAfterDays: clamp(input.quietAfterDays, 1, MAX_QUIET_DAYS, DEFAULT_LIMITS.quietAfterDays),
    ignoredBelowViews: clamp(input.ignoredBelowViews, 0, 100_000, DEFAULT_LIMITS.ignoredBelowViews),
    // Absent reads as the default rather than as false: `skipAnswered: false`
    // widens what a run considers, and a missing field must not quietly do that.
    skipAnswered: typeof input.skipAnswered === 'boolean' ? input.skipAnswered : DEFAULT_LIMITS.skipAnswered,
  };
}

/** Requests one fetch will make, before it makes them. Shown next to the button
 *  so the cost of a wide selection is visible in advance rather than in a bill —
 *  one request per page per board, paced a second apart. */
export function estimateRequests(config: ShopifyModuleConfig): number {
  return config.categories.length * config.pagesPerCategory;
}
