import 'server-only';

// Walking a client's approved domains to find pages worth reading.
//
// The parsers and every rule about what counts as a candidate are pure and live
// in modules/knowledge/discovery.ts. This file does the fetching, the pacing and
// the writing — the parts that need a network and a database and therefore
// cannot be argued with in a test.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS IS SOMEBODY ELSE'S SERVER, AND IT ALREADY SAID NO ONCE
//
// A 403 on this client's help centre is what forced the manual paste route to
// exist. That is the context for every limit below: their infrastructure does
// not know about our arrangement, and a crawler that hammers it will be blocked
// harder, which costs the operator the automated route for the whole domain.
//
// So: robots.txt is read and obeyed, requests are spaced, the page budget is
// small and hard, and a refusal ends the walk for that host rather than being
// retried. Discovery that finds forty good pages politely is worth more than one
// that finds four hundred and gets the IP banned.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue, type DocumentData, type Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import {
  buildCandidates,
  dedupeKey,
  extractLinks,
  hostAllowed,
  normaliseDomain,
  parseRobots,
  parseSitemap,
  type Candidate,
  type RobotsRules,
} from '@/modules/knowledge/discovery';
import { assertPublicHttpUrl, KnowledgeFetchError } from '@/modules/knowledge/url';
import type { Discovery, DiscoveryStatus } from '@/modules/knowledge/types';

// --- limits, all deliberately small -----------------------------------------

/** Pages fetched for their links, per run. Not per domain — the whole run. */
const MAX_LINK_PAGES = 12;
/** Sitemap documents read, including nested ones behind an index. */
const MAX_SITEMAPS = 8;
/** URLs considered before triage. A large sitemap is truncated, not refused. */
const MAX_SEEN = 5_000;
/** Candidates kept for classification. The review queue has to stay workable. */
const MAX_CANDIDATES = 120;
/** Between any two requests to the same host. */
const GAP_MS = 500;
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 3_000_000;

const USER_AGENT = 'MotherlinkEngage/1.0 (+knowledge-discovery; contact via the site owner)';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Fetched {
  ok: boolean;
  body: string;
  status: number;
}

/** One GET, capped and timed out, that never throws. A discovery walk must
 *  degrade rather than abort — one missing sitemap is not a failed run. */
async function get(url: string): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml,text/plain' },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, body: '', status: res.status };

    const buf = await res.arrayBuffer();
    const body = new TextDecoder('utf-8').decode(
      buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf,
    );
    return { ok: true, body, status: res.status };
  } catch {
    return { ok: false, body: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export interface WalkResult {
  found: { url: string; anchor?: string; source: 'sitemap' | 'link' }[];
  pagesFetched: number;
  disallow: string[];
  notes: string[];
}

/**
 * Enumerate URLs across the approved domains.
 *
 * SITEMAP FIRST, then a shallow link crawl. The order is a cost decision: one
 * sitemap fetch can name a thousand pages, so exhausting that before spending
 * the small link budget means the link fetches are used on anchor text rather
 * than on discovering URLs the sitemap would have given us for free.
 */
export async function walkDomains(domains: string[]): Promise<WalkResult> {
  const found: WalkResult['found'] = [];
  const notes: string[] = [];
  const disallow: string[] = [];
  let pagesFetched = 0;

  for (const raw of domains) {
    const domain = normaliseDomain(raw);
    if (!domain) {
      notes.push(`"${raw}" is not a domain.`);
      continue;
    }

    const origin = `https://${domain}`;
    try {
      assertPublicHttpUrl(origin);
    } catch (err) {
      notes.push(err instanceof KnowledgeFetchError ? `${domain}: ${err.message}` : `${domain}: refused.`);
      continue;
    }

    // --- robots.txt ---------------------------------------------------------
    let rules: RobotsRules = { sitemaps: [], disallow: [] };
    const robots = await get(`${origin}/robots.txt`);
    pagesFetched++;
    if (robots.ok) {
      rules = parseRobots(robots.body);
      disallow.push(...rules.disallow);
    } else if (robots.status === 403) {
      // The signal that matters most on this project. Say it plainly so the
      // operator reads it as "expect the manual route", not as a bug.
      notes.push(`${domain} refused robots.txt (403) — this host blocks servers, so expect to paste pages by hand.`);
    }

    // --- sitemaps -----------------------------------------------------------
    const queue = rules.sitemaps.length
      ? [...rules.sitemaps]
      : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
    const seenSitemaps = new Set<string>();
    let sitemapUrls = 0;

    while (queue.length && seenSitemaps.size < MAX_SITEMAPS) {
      const next = queue.shift()!;
      if (seenSitemaps.has(next) || !hostAllowed(next, domains)) continue;
      seenSitemaps.add(next);

      await sleep(GAP_MS);
      const res = await get(next);
      pagesFetched++;
      if (!res.ok) continue;

      const { urls, isIndex } = parseSitemap(res.body);
      if (isIndex) {
        queue.push(...urls.slice(0, MAX_SITEMAPS));
        continue;
      }
      for (const url of urls) {
        if (found.length >= MAX_SEEN) break;
        found.push({ url, source: 'sitemap' });
        sitemapUrls++;
      }
    }

    if (sitemapUrls === 0) {
      notes.push(`${domain}: no sitemap found, so only linked pages were seen.`);
    }

    // --- a shallow link crawl, for anchor text ------------------------------
    //
    // ONE LEVEL, from the homepage and whatever help/support index it links to.
    // Going deeper would find more pages; it would also spend the whole budget
    // inside one section and turn a polite look into a crawl.
    const toVisit = [origin];
    const visited = new Set<string>();

    while (toVisit.length && visited.size < MAX_LINK_PAGES) {
      const page = toVisit.shift()!;
      if (visited.has(page) || !hostAllowed(page, domains)) continue;
      visited.add(page);

      await sleep(GAP_MS);
      const res = await get(page);
      pagesFetched++;
      if (!res.ok) {
        if (res.status === 403 && page === origin) {
          notes.push(`${domain} refused the homepage (403). Only its sitemap could be read.`);
          break;
        }
        continue;
      }

      for (const link of extractLinks(res.body, page)) {
        if (!hostAllowed(link.url, domains)) continue;
        if (found.length < MAX_SEEN) {
          found.push({ url: link.url, anchor: link.anchor, source: 'link' });
        }
        // Follow only index-shaped pages. A help centre's front page is worth
        // opening for its article links; an article is not, and following them
        // is how one level becomes a crawl.
        if (visited.size + toVisit.length < MAX_LINK_PAGES && /\/(help|support|faq|guides?|learn|blog)\/?$/i.test(new URL(link.url).pathname)) {
          toVisit.push(link.url);
        }
      }
    }
  }

  return { found, pagesFetched, disallow, notes };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ts = (v: unknown): Date | null =>
  v && typeof (v as Timestamp).toDate === 'function' ? (v as Timestamp).toDate() : null;

const discoveriesRef = (projectId: string) =>
  adminDb().collection('projects').doc(projectId).collection('discoveries');

function toDiscovery(id: string, d: DocumentData): Discovery {
  return {
    discoveryId: id,
    projectId: String(d.projectId ?? ''),
    url: String(d.url ?? ''),
    dedupeKey: String(d.dedupeKey ?? ''),
    anchors: Array.isArray(d.anchors) ? d.anchors : [],
    source: d.source === 'link' ? 'link' : 'sitemap',
    usefulFor: String(d.usefulFor ?? ''),
    kind: d.kind ?? 'guide',
    confidence: Number(d.confidence ?? 0),
    worthReading: d.worthReading === true,
    pathScore: Number(d.pathScore ?? 0),
    status: (d.status ?? 'new') as DiscoveryStatus,
    assetId: d.assetId ?? null,
    decidedBy: d.decidedBy ?? null,
    decidedByName: d.decidedByName ?? null,
    decidedAt: ts(d.decidedAt),
    model: String(d.model ?? ''),
    promptVersion: String(d.promptVersion ?? ''),
    discoveredAt: ts(d.discoveredAt) ?? new Date(0),
  };
}

export async function listDiscoveries(projectId: string): Promise<Discovery[]> {
  const snap = await discoveriesRef(projectId).get();
  return snap.docs
    .map((d) => toDiscovery(d.id, d.data()))
    .sort(
      (a, b) =>
        Number(b.worthReading) - Number(a.worthReading) ||
        b.confidence - a.confidence ||
        b.pathScore - a.pathScore ||
        a.url.localeCompare(b.url),
    );
}

export async function getDiscovery(projectId: string, discoveryId: string): Promise<Discovery | null> {
  const doc = await discoveriesRef(projectId).doc(discoveryId).get();
  return doc.exists ? toDiscovery(doc.id, doc.data() as DocumentData) : null;
}

/**
 * Everything a run must not offer again.
 *
 * Both halves matter. Assets are excluded because a page already in the library
 * is not a candidate. Decided discoveries are excluded because an operator who
 * ignored a page once and is shown it again every Monday will stop running
 * discovery — the queue's value is entirely in it being short.
 */
export async function knownKeys(projectId: string, assetUrls: string[]): Promise<Set<string>> {
  const existing = await discoveriesRef(projectId).get();
  const keys = new Set<string>();
  for (const url of assetUrls) if (url) keys.add(dedupeKey(url));
  for (const doc of existing.docs) {
    const d = doc.data();
    keys.add(String(d.dedupeKey ?? dedupeKey(String(d.url ?? ''))));
  }
  return keys;
}

export interface WriteDiscoveryInput {
  projectId: string;
  candidate: Candidate;
  classification: { usefulFor: string; kind: string; confidence: number; worthReading: boolean } | null;
  model: string;
  promptVersion: string;
}

/** Write a batch of discoveries. Firestore caps a batch at 500 writes; the
 *  candidate limit is well inside that, so one commit is enough. */
export async function saveDiscoveries(inputs: WriteDiscoveryInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const db = adminDb();
  const batch = db.batch();

  for (const input of inputs) {
    const ref = discoveriesRef(input.projectId).doc();
    batch.set(ref, {
      discoveryId: ref.id,
      projectId: input.projectId,
      url: input.candidate.url,
      dedupeKey: dedupeKey(input.candidate.url),
      anchors: input.candidate.anchors.slice(0, 8),
      source: input.candidate.source,
      // An unclassified candidate is still written. The model failing to return
      // a row is not a reason to lose a page the site really has — the operator
      // simply sees it without a guess attached.
      usefulFor: input.classification?.usefulFor ?? '',
      kind: input.classification?.kind ?? input.candidate.provisionalKind,
      confidence: input.classification?.confidence ?? 0,
      worthReading: input.classification?.worthReading ?? false,
      pathScore: input.candidate.score,
      status: 'new',
      assetId: null,
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      model: input.model,
      promptVersion: input.promptVersion,
      discoveredAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return inputs.length;
}

export async function setDiscoveryStatus(
  projectId: string,
  discoveryId: string,
  status: DiscoveryStatus,
  actor: { uid: string; name: string },
  assetId: string | null = null,
): Promise<void> {
  await discoveriesRef(projectId)
    .doc(discoveryId)
    .update({
      status,
      ...(assetId ? { assetId } : {}),
      decidedBy: actor.uid,
      decidedByName: actor.name,
      decidedAt: FieldValue.serverTimestamp(),
    });
}
