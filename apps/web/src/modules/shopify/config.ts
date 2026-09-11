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
import { emptyClientProfile, normaliseClientProfile, type ShopifyClientProfile } from './client';
import { modelByRef } from '@/lib/llm/catalog';

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
  /** Who the client is, in this module's own words. Its own copy rather than a
   *  read of the Reddit module's — see client.ts for why, and for the sync. */
  client: ShopifyClientProfile;
  /**
   * Which model reads a question and scores it, and which writes a reply.
   *
   * ⚠️ CHOSEN, NOT HARDCODED. Null means the platform default, exactly as on
   * Reddit — and the same catalogue ref, so the same keys on the API keys page
   * unlock the same models here. Kept on THIS module rather than read from
   * Reddit's settings: a cheap model for scoring forty questions and a strong
   * one for writing the three replies that matter is the whole reason to have
   * two picks, and that trade is per platform.
   *
   * Both must return JSON — the analysis AND the draft are parsed — so a
   * non-JSON model is refused on save and dropped here if one was stored.
   */
  analysisModel: string | null;
  draftModel: string | null;
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
    client: emptyClientProfile(),
    analysisModel: null,
    draftModel: null,
  };
}

/**
 * Why a model ref cannot be used here, or null when it can.
 *
 * Validated against the CATALOGUE, not the editor's own keys — the Reddit
 * route's rule, for its reason: a project manager may configure a model only
 * the analyst holds a key for. Whether a given run can proceed is decided at
 * run time, per caller, by resolveModelForRun.
 */
export function modelRefProblem(ref: unknown): string | null {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref !== 'string') return 'That is not a model.';
  const meta = modelByRef(ref);
  if (!meta) return `"${ref}" is not a model this build knows about.`;
  if (!meta.json) {
    return `${meta.label} cannot return structured JSON, and both the analysis and the draft are read as JSON.`;
  }
  return null;
}

/** A stored ref → itself, or null when it can no longer be used. */
const readModelRef = (ref: unknown): string | null =>
  typeof ref === 'string' && ref && modelRefProblem(ref) === null ? ref : null;

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
    client: normaliseClientProfile(input.client),
    analysisModel: readModelRef(input.analysisModel),
    draftModel: readModelRef(input.draftModel),
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
