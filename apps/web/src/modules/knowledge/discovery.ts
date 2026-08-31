// Finding the pages worth reading, on a client's own approved domains.
//
// PURE — parsers, heuristics and set arithmetic. The fetching lives in
// server/knowledge.ts. Everything here runs against saved fixtures with no
// network, which is the only way the triage rules below can be argued about.
//
// ════════════════════════════════════════════════════════════════════════════
// DISCOVERY IS NOT VERIFICATION, AND THE GAP IS THE POINT
//
// Nothing in this file reads a page. It produces CANDIDATES — a URL, whatever a
// human wrote in the link that pointed at it, and a guess at what the page is
// probably for. A candidate is a to-do item, not knowledge: no claim can come
// from it, and until the existing ingest actually reads the page there is no
// evidence behind anything it suggests.
//
// The reason to keep that line bright is that discovery is the stage most
// tempting to over-trust. It produces confident-looking rows at scale, and a
// system willing to promote "probably a cashout help page" into "the client says
// cashout can disappear" has skipped the only step that ever mattered.
//
// TWO SOURCES, FOR DIFFERENT REASONS:
//   sitemap — coverage. It is the site telling us what it has, and it is cheap:
//             one fetch can name a thousand pages.
//   links   — ANCHOR TEXT. A sitemap says /help/a/4872560; a link says "Why did
//             my cashout disappear?". That sentence was written by a person to
//             describe the page, and it is the single best signal available
//             before anything is fetched.
// ════════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** `Northwind.example`, `https://northwind.example/`, `northwind.example/help` → `northwind.example`. */
export function normaliseDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Is this URL on one of the approved domains?
 *
 * THE BOUNDARY OF THE WHOLE CRAWL. A link crawl follows what it finds, and a
 * client's footer points at Twitter, a payment processor, a licensing authority
 * and a dozen affiliates. Without this check, "discover the client's pages"
 * becomes "crawl the open web from the client's homepage", which is a different
 * and much worse product.
 *
 * Subdomains of an approved domain are in — `help.northwind.example` is the client's
 * help centre and refusing it would defeat the feature. A domain that merely
 * ENDS with an approved one is not: `notnorthwind.example` must not pass because
 * `northwind.example` was approved, hence the dot.
 */
export function hostAllowed(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return domains.some((d) => {
    const domain = normaliseDomain(d);
    return !!domain && (host === domain || host.endsWith(`.${domain}`));
  });
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRules {
  /** Sitemap URLs the site advertises. The cheapest way to find them. */
  sitemaps: string[];
  /** Disallowed path prefixes that apply to us. */
  disallow: string[];
}

/**
 * Read robots.txt for the two things we need from it.
 *
 * WE OBEY THIS EVEN THOUGH THE DOMAIN IS APPROVED. The client authorising us to
 * read their site is not the same as their web team expecting a crawler in
 * /account/ — and a 403 on a real help centre has already shown that their
 * infrastructure does not know about the arrangement. Following the file they
 * publish is how an automated reader stays welcome.
 *
 * Only `User-agent: *` groups are read. We do not publish a named agent, so a
 * group addressed to someone else is not addressed to us.
 */
export function parseRobots(text: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let inStarGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    // Sitemap is a global directive — it belongs to no group, so it is read
    // wherever it appears.
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      inStarGroup = value === '*';
      continue;
    }
    if (field === 'disallow' && inStarGroup && value) {
      disallow.push(value);
    }
  }

  return { sitemaps, disallow };
}

/** Prefix matching, with `*` treated as "anything". Deliberately simple: the
 *  cost of over-obeying a rule is one page we do not read. */
export function isDisallowed(pathname: string, rules: string[]): boolean {
  return rules.some((rule) => {
    if (rule === '/') return true;
    const [head] = rule.split('*');
    return head.length > 0 && pathname.startsWith(head);
  });
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

/** URLs from a `<urlset>`, or nested sitemap URLs from a `<sitemapindex>`.
 *
 *  Both live in the same `<loc>` tag, so the caller is told which it read
 *  rather than having to guess from the contents. */
export function parseSitemap(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const value = decodeXml(m[1].trim());
    if (value) urls.push(value);
  }
  return { urls, isIndex };
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface FoundLink {
  url: string;
  /** What the link said. Empty when the anchor was an image or an icon. */
  anchor: string;
}

/** Every `<a href>` in a document, resolved against the page it came from. */
export function extractLinks(html: string, baseUrl: string): FoundLink[] {
  const out: FoundLink[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;

    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const anchor = m[5]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    out.push({ url: resolved, anchor: anchor.slice(0, 200) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/** Path fragments that mark a page as worth a look on a gambling operator's
 *  site. Ordered by how reliably they indicate real explanatory content. */
const PROMISING: { pattern: RegExp; kind: string; weight: number }[] = [
  { pattern: /\/(help|support|faq|answers?)(\/|$)/, kind: 'help', weight: 40 },
  { pattern: /\/(guide|guides|how-to|howto|learn|academy|education|explained)(\/|$)/, kind: 'guide', weight: 34 },
  { pattern: /\/(blog|news|insights|article|articles)(\/|$)/, kind: 'guide', weight: 22 },
  { pattern: /\/(terms|policy|policies|rules|legal|responsible)(\/|$)/, kind: 'policy', weight: 26 },
  { pattern: /\/(payment|payments|banking|deposit|withdraw|withdrawal|payout)(\/|$)/, kind: 'policy', weight: 30 },
  { pattern: /\/(sports|sportsbook|betting|casino|odds|markets)(\/|$)/, kind: 'feature', weight: 18 },
  { pattern: /\/(feature|features|product|tools?)(\/|$)/, kind: 'feature', weight: 24 },
  { pattern: /\/(promotion|promotions|bonus|offers)(\/|$)/, kind: 'policy', weight: 16 },
  { pattern: /\/(stats|statistics|data|report|reports|research)(\/|$)/, kind: 'data', weight: 28 },
];

/**
 * Paths that are never an asset, whatever else is true of them.
 *
 * These are dropped BEFORE anything is scored or shown, because the alternative
 * is a review queue whose first page is a login form, a shopping basket and
 * forty paginated tag archives. An operator who has to skip forty rows to find
 * one good one stops using the queue, and then discovery has cost more than it
 * saved.
 */
const NEVER: RegExp[] = [
  /\/(login|signin|sign-in|register|signup|sign-up|logout)(\/|$)/,
  /\/(cart|checkout|basket|account|profile|dashboard|settings|preferences)(\/|$)/,
  /\/(search|tag|tags|author|category|categories|archive)(\/|$)/,
  /\/page\/\d+(\/|$)/,
  /\/(feed|rss|atom)(\/|$)/,
  /\/(wp-admin|wp-content|wp-includes|cdn-cgi|_next|static|assets)(\/|$)/,
  /\.(xml|json|css|js|png|jpe?g|gif|svg|webp|ico|zip|mp4|woff2?)($|\?)/i,
];

export interface Triage {
  keep: boolean;
  /** Why it was dropped. Empty when kept — nothing needs to justify a keep. */
  reason: string;
  /** A first guess, refined later by the classifier. */
  provisionalKind: string;
  /** 0..100, from the path alone. Ordering only; it is not a judgement. */
  score: number;
}

/**
 * Decide from the URL alone whether a page is worth considering.
 *
 * FREE, and that is its whole job. A sitemap can name ten thousand URLs; sending
 * all of them to a model to be classified would cost more than the feature is
 * worth and would bury the operator either way. This cuts the list to the ones
 * whose shape suggests explanatory content, and everything after it is allowed
 * to be expensive.
 */
export function triageUrl(rawUrl: string): Triage {
  let path: string;
  try {
    const u = new URL(rawUrl);
    path = u.pathname.toLowerCase();
  } catch {
    return { keep: false, reason: 'Not a URL.', provisionalKind: 'guide', score: 0 };
  }

  if (NEVER.some((re) => re.test(path))) {
    return { keep: false, reason: 'Not a content page.', provisionalKind: 'guide', score: 0 };
  }

  // The homepage. Real, but it describes everything and therefore nothing, and
  // it is never the page a specific question should cite.
  if (path === '/' || path === '') {
    return { keep: false, reason: 'The homepage is too general to be an asset.', provisionalKind: 'guide', score: 0 };
  }

  let score = 0;
  let kind = 'guide';
  for (const { pattern, kind: k, weight } of PROMISING) {
    if (pattern.test(path)) {
      score += weight;
      if (weight >= 24) kind = k;
    }
  }

  // THE SECTION MATCH IS THE GATE, and the depth bonus below is only a
  // tie-breaker among pages that already passed it. Adding depth first was a
  // real bug: every URL on the site has segments, so every URL scored above
  // zero, and "nothing here suggests useful content" could never fire. The
  // review queue would have been the sitemap.
  if (score === 0) {
    return { keep: false, reason: 'Nothing in the path suggests useful content.', provisionalKind: kind, score: 0 };
  }

  // Depth is weak evidence of specificity: /help/articles/cashout says more than
  // /help. Capped so a deeply nested breadcrumb cannot outscore a better section.
  const depth = path.split('/').filter(Boolean).length;
  score += Math.min(depth * 3, 12);

  return { keep: true, reason: '', provisionalKind: kind, score: Math.min(100, score) };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

const TRACKING = /^(utm_|gclid|fbclid|msclkid|ref|referrer|source)/i;

/** Two-letter language prefixes. Kept as a set rather than a regex over any two
 *  letters, so `/ru/` (Russian) is folded and `/nl/` in `/nl/help` is too, while
 *  a genuine two-letter path segment that is not a language is left alone. */
const LOCALES = new Set([
  'en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'pl', 'ru', 'tr', 'ja', 'ko', 'zh',
  'sv', 'no', 'da', 'fi', 'cs', 'hu', 'ro', 'el', 'uk', 'vi', 'th', 'id', 'hi',
  'ar', 'fa', 'he', 'bg', 'hr', 'sr', 'sk', 'sl', 'et', 'lv', 'lt',
]);

/**
 * The key two URLs share when they are the same page.
 *
 * FOLDS LOCALES, and that is the one that earns this function. A gambling
 * operator's help centre exists in thirty languages, so a sitemap returns thirty
 * copies of every article. Without folding, the review queue is thirty times
 * longer and 97% of it is unreadable to the operator — and each duplicate would
 * be ingested separately, thirty times the model spend for one asset.
 */
export function dedupeKey(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length > 0 && LOCALES.has(segments[0])) segments.shift();

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return `${host}/${segments.join('/')}${params ? `?${params}` : ''}`;
}

/** Does this URL look like the English (or unprefixed) copy? Preferred when
 *  several locales collapse to one key, because it is the one an operator can
 *  read and the one the model classifies best. */
export function preferredLocale(rawUrl: string): boolean {
  try {
    const first = new URL(rawUrl).pathname.split('/').filter(Boolean)[0];
    return !first || !LOCALES.has(first) || first === 'en';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface Candidate {
  url: string;
  /** Anchor texts seen pointing at this page, deduplicated. The best free
   *  description available before anything is fetched. */
  anchors: string[];
  source: 'sitemap' | 'link';
  provisionalKind: string;
  score: number;
}

/**
 * Fold everything found into one candidate per real page.
 *
 * Merges the two sources rather than preferring one: the sitemap contributes
 * coverage and the links contribute anchor text, and a page found both ways
 * should keep the anchor. `known` is every URL already in the library or already
 * dismissed — dropping them here rather than at display time means they never
 * reach the classifier, so a second discovery run over an unchanged site is
 * almost free.
 */
export function buildCandidates(
  found: { url: string; anchor?: string; source: 'sitemap' | 'link' }[],
  opts: { domains: string[]; known: Set<string>; disallow?: string[]; limit?: number },
): Candidate[] {
  const byKey = new Map<string, Candidate>();

  for (const item of found) {
    if (!hostAllowed(item.url, opts.domains)) continue;

    if (opts.disallow?.length) {
      try {
        if (isDisallowed(new URL(item.url).pathname, opts.disallow)) continue;
      } catch {
        continue;
      }
    }

    const triage = triageUrl(item.url);
    if (!triage.keep) continue;

    const key = dedupeKey(item.url);
    if (opts.known.has(key)) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        url: item.url,
        anchors: item.anchor ? [item.anchor] : [],
        source: item.source,
        provisionalKind: triage.provisionalKind,
        score: triage.score,
      });
      continue;
    }

    // Same page, seen again. Keep the readable URL, gather the anchor, and let
    // a link sighting upgrade a sitemap-only row — an anchor is worth more than
    // the fact that a sitemap listed it.
    if (item.anchor && !existing.anchors.includes(item.anchor)) {
      existing.anchors.push(item.anchor);
    }
    if (item.source === 'link') existing.source = 'link';
    if (!preferredLocale(existing.url) && preferredLocale(item.url)) existing.url = item.url;
  }

  const all = [...byKey.values()].sort(
    (a, b) => b.score - a.score || b.anchors.length - a.anchors.length || a.url.localeCompare(b.url),
  );
  return opts.limit ? all.slice(0, opts.limit) : all;
}
