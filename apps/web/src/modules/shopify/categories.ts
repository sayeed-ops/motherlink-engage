// Shopify Community categories, and the URLs that reach them.
//
// PURE (see modules/covers/sections.ts for the same posture). Everything here
// is arithmetic and string building; the fetching lives in ./reader.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// THERE IS NO "MARKETING" CATEGORY, AND THE SIX BELOW ARE NOT ITS CHILDREN
//
// The site's navigation groups six boards under a Marketing heading, which
// makes them look like subcategories. They are not. `categories.json` returns
// forty FLAT categories with no `parent_category_id` on any of them, and
// `/c/marketing` is a 404. Verified 2026-09-10.
//
// So DEFAULT_CATEGORIES is a curated starting set, not a subtree, and nothing
// in this module may assume a hierarchy exists. If Shopify later introduces a
// real parent, `parentId` on ShopifyCategory is where it would land — it is
// read from the payload and carried, never inferred.
// ════════════════════════════════════════════════════════════════════════════

/** A board, as the catalogue reports it.
 *
 *  ⚠️ `id` AND `slug` are both required and neither is optional, because a
 *  Discourse category URL is `/c/{slug}/{id}` and needs both halves. A slug
 *  alone cannot address a category, which is why this is not keyed by slug the
 *  way the Covers sections are. */
export interface ShopifyCategory {
  id: number;
  slug: string;
  name: string;
  /** Reported by the catalogue; null for a top-level board. Carried so a future
   *  hierarchy works without a migration — never inferred from the name. */
  parentId: number | null;
  /** How many topics the board holds, when the catalogue says. Null means the
   *  payload did not carry it — which is not the same as an empty board, and
   *  the screen says so in words rather than showing a 0. */
  topicCount: number | null;
}

/**
 * The six the operator asked for, as the shipped default.
 *
 * Small on purpose: ~450 topics across all six, which is few enough to read
 * exhaustively rather than sample. The four big support boards (Store Design
 * at 96k topics, Shopify Discussion at 59k, Technical Q&A at 46k, Shopify Apps
 * at 20k) are deliberately NOT here — they are selectable like any other board,
 * but defaulting to them would make the first run of a new project enormous.
 *
 * Ids and slugs read from the live catalogue on 2026-09-10. They are a starting
 * point that the operator's saved configuration replaces entirely, and the
 * catalogue is fetched live, so a renamed or renumbered board is a stale
 * default here rather than a broken module.
 */
export const DEFAULT_CATEGORIES: readonly ShopifyCategory[] = [
  { id: 288, slug: 'seo', name: 'SEO', parentId: null, topicCount: 201 },
  { id: 293, slug: 'data-analytics', name: 'Data and Analytics', parentId: null, topicCount: 91 },
  { id: 292, slug: 'email-marketing', name: 'Email Marketing', parentId: null, topicCount: 62 },
  { id: 289, slug: 'social-media', name: 'Social Media', parentId: null, topicCount: 46 },
  { id: 291, slug: 'video-marketing', name: 'Video Marketing', parentId: null, topicCount: 25 },
  { id: 284, slug: 'branding', name: 'Branding', parentId: null, topicCount: 23 },
] as const;

// ---------------------------------------------------------------------------
// Sort orders
// ---------------------------------------------------------------------------

/**
 * The orderings a board can be read in.
 *
 * All four verified live against `/c/seo/288/l/{sort}.json` on 2026-09-10 —
 * `latest` and `hot` return 30 a page, `top` returns 50, `votes` 30. They are
 * an enum rather than a free string because the value goes straight into a URL
 * path, and "whatever the browser sent" is not something to concatenate into
 * somebody else's server's path.
 */
export const SORTS = ['latest', 'hot', 'top', 'votes'] as const;
export type ShopifySort = (typeof SORTS)[number];

export const SORT_LABEL: Record<ShopifySort, string> = {
  latest: 'Latest activity',
  hot: 'Hot',
  top: 'Top',
  votes: 'Most voted',
};

/** What each ordering is actually useful for. Shown next to the control,
 *  because "hot" and "top" are not self-explanatory and picking the wrong one
 *  quietly changes which conversations a run ever sees. */
export const SORT_HELP: Record<ShopifySort, string> = {
  latest: 'Most recently replied to. What is alive right now.',
  hot: "Discourse's own blend of recency and activity.",
  top: 'Most engagement over a period. Good boards to learn from, often too old to answer.',
  votes: 'Ranked by votes where the board allows them. Sparse on most boards.',
};

export function isSort(v: unknown): v is ShopifySort {
  return typeof v === 'string' && (SORTS as readonly string[]).includes(v);
}

/** Whatever arrived → a sort the reader can use. */
export function normaliseSort(v: unknown): ShopifySort {
  return isSort(v) ? v : 'latest';
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export const SHOPIFY_COMMUNITY_BASE = 'https://community.shopify.com';

/** A slug that is safe to put in a path. Discourse slugs are lowercase
 *  alphanumerics and hyphens; anything else is somebody else's idea. */
export function normaliseSlug(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** A positive integer id, or null. Ids reach us from a browser as much as from
 *  the catalogue, so they are validated rather than cast. */
export function normaliseId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The JSON listing for one board in one ordering.
 *
 * `page` is zero-based, matching Discourse. The catalogue's own
 * `more_topics_url` is the authoritative way to page and the reader prefers it;
 * this exists for the first request and as a fallback when that field is
 * absent.
 */
export function categoryListUrl(
  category: Pick<ShopifyCategory, 'id' | 'slug'>,
  sort: ShopifySort,
  page = 0,
): string {
  const slug = normaliseSlug(category.slug) || 'c';
  const id = normaliseId(category.id);
  if (id === null) throw new Error('A category id is required to build a listing URL.');
  const q = page > 0 ? `?page=${Math.min(page, 50)}` : '';
  return `${SHOPIFY_COMMUNITY_BASE}/c/${slug}/${id}/l/${sort}.json${q}`;
}

/** The JSON for one topic, with its posts. */
export function topicUrl(id: number, slug: string): string {
  const n = normaliseId(id);
  if (n === null) throw new Error('A topic id is required to build a topic URL.');
  return `${SHOPIFY_COMMUNITY_BASE}/t/${normaliseSlug(slug) || 'topic'}/${n}.json`;
}

/** Where a person goes to read it themselves. The same path without `.json` —
 *  every queue row links here so a decision can be checked against the real
 *  page rather than against our copy of it. */
export function topicWebUrl(id: number, slug: string): string {
  const n = normaliseId(id);
  if (n === null) throw new Error('A topic id is required to build a topic URL.');
  return `${SHOPIFY_COMMUNITY_BASE}/t/${normaliseSlug(slug) || 'topic'}/${n}`;
}

export const categoryWebUrl = (category: Pick<ShopifyCategory, 'id' | 'slug'>): string =>
  `${SHOPIFY_COMMUNITY_BASE}/c/${normaliseSlug(category.slug) || 'c'}/${normaliseId(category.id) ?? 0}`;

// ---------------------------------------------------------------------------
// Catalogue parsing
// ---------------------------------------------------------------------------

/**
 * `/categories.json` → our shape.
 *
 * Defensive because this is somebody else's payload: a row missing an id or a
 * slug cannot be addressed and is DROPPED rather than defaulted, for the same
 * reason a Covers section with no valid role is dropped. A category we cannot
 * build a URL for is not a category we can offer in a picker.
 */
export function parseCategoryList(raw: unknown): ShopifyCategory[] {
  const rows = (raw as { category_list?: { categories?: unknown[] } })?.category_list?.categories;
  if (!Array.isArray(rows)) return [];

  const out: ShopifyCategory[] = [];
  const seen = new Set<number>();

  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const id = normaliseId(r.id);
    const slug = normaliseSlug(r.slug);
    if (id === null || !slug || seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      slug,
      name: String(r.name ?? '').trim() || slug,
      parentId: normaliseId(r.parent_category_id),
      topicCount: typeof r.topic_count === 'number' ? r.topic_count : null,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
