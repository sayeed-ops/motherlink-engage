// What the client can credibly speak to, on THIS platform.
//
// PURE — validation, the JSON import, the copy plan and the matcher. The store
// is server/shopifyKnowledge.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// ITS OWN LIST, FILLED THREE WAYS — AND A COPY THAT ONLY EVER ADDS
//
// This module used to read the project-level `sources` Reddit fills: "one
// client, one knowledge base". The operator did not want that, for the reason
// the client profile is already a copy — a merchant forum is not a subreddit,
// and what is worth citing in one is not always worth citing in the other. So
// Shopify keeps `projects/{id}/shopifySources`, filled by hand, by pasted JSON,
// or by copying from Reddit.
//
// ⚠️ THE COPY ADDS WHAT IS MISSING AND NEVER REPLACES. The client profile's sync
// replaces because it is ONE record, and a half-merged record cannot say where
// each value came from. Knowledge is a LIST: replacing it would delete every
// source somebody added here for Shopify alone, to make room for a copy of
// Reddit's. So a source already held — by the Reddit id it was copied from, by
// URL, or by title — is left exactly as it is, edits and all.
// ════════════════════════════════════════════════════════════════════════════

export type SourceType = 'url' | 'pasted_text';
export type SourceOrigin = 'manual' | 'json' | 'reddit';

export const ORIGIN_LABEL: Record<SourceOrigin, string> = {
  manual: 'Added here',
  json: 'Imported from JSON',
  reddit: 'Copied from Reddit',
};

/** What a person, a JSON row or a Reddit source supplies. */
export interface SourceInput {
  type: SourceType;
  title: string;
  url: string | null;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
  relatedProblems: string[];
}

export interface ShopifySource extends SourceInput {
  sourceId: string;
  origin: SourceOrigin;
  /** The Reddit source this was copied from. KEPT after an edit, so copying
   *  again does not bring the unedited original back beside the edited one. */
  copiedFromSourceId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** Set when a copied or imported source is changed here. A copy nobody can
   *  tell was edited is a copy nobody can trust to match its origin. */
  editedAtMs: number | null;
}

/** The fields a prompt needs. `matchSources` and the prompts take this. */
export interface PromptSource {
  sourceId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
}

export const MAX_SOURCES_PER_IMPORT = 100;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const list = (v: unknown, maxItems = 20, maxLen = 300): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => text(x, maxLen)).filter(Boolean))].slice(0, maxItems)
    : [];

export type NormaliseResult = { ok: true; source: SourceInput } | { ok: false; reason: string };

/**
 * Whatever arrived → a source, or the reason it is not one.
 *
 * A title is the only required field — it is what a person recognises the
 * source by, and the matcher reads it. A URL, when given, must be http(s): a
 * `javascript:` link rendered on the knowledge screen is the obvious reason.
 */
export function normaliseSource(raw: unknown): NormaliseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const r = raw as Record<string, unknown>;

  const title = text(r.title, 200);
  if (!title) return { ok: false, reason: 'no title' };

  const url = text(r.url, 1000) || null;
  if (url && !/^https?:\/\//i.test(url)) return { ok: false, reason: 'the URL must start with http:// or https://' };

  return {
    ok: true,
    source: {
      // Absent reads as a link when there is one: the Reddit importer defaulted
      // to 'url' too, and a row with a URL and no type is plainly a link.
      type: r.type === 'pasted_text' ? 'pasted_text' : 'url',
      title,
      url,
      summary: text(r.summary, 3000),
      keyPoints: list(r.keyPoints),
      answerAngles: list(r.answerAngles),
      relatedProblems: list(r.relatedProblems),
    },
  };
}

export class SourcesJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesJsonError';
  }
}

export interface ParsedSources {
  rows: SourceInput[];
  /** Rows that were not sources, with why — a paste of twelve where two lack a
   *  title should import ten and say so, not refuse all twelve. */
  rejected: { index: number; reason: string }[];
}

/** Pasted JSON → sources. An array or a single object; fenced or not. */
export function parseSourcesJson(input: string): ParsedSources {
  let raw: unknown;
  try {
    raw = JSON.parse(input.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch {
    throw new SourcesJsonError('That is not valid JSON.');
  }

  // Models sometimes wrap the array: {"sources":[…]}. Read it rather than
  // refuse it — the intent is not in doubt.
  const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).sources);
  const items = Array.isArray(raw) ? raw : wrapped ? ((raw as Record<string, unknown>).sources as unknown[]) : [raw];

  if (items.length > MAX_SOURCES_PER_IMPORT) {
    throw new SourcesJsonError(`That is ${items.length} sources; import at most ${MAX_SOURCES_PER_IMPORT} at a time.`);
  }

  const rows: SourceInput[] = [];
  const rejected: { index: number; reason: string }[] = [];
  items.forEach((item, index) => {
    const res = normaliseSource(item);
    if (res.ok) rows.push(res.source);
    else rejected.push({ index, reason: res.reason });
  });
  return { rows, rejected };
}

/** Comparable forms of a URL and a title. `https://www.x.example/a/` and
 *  `http://x.example/a#top` are one page. */
export function sourceKeys(s: { url: string | null; title: string }): { url: string | null; title: string } {
  const url = s.url
    ? s.url
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/#.*$/, '')
        .replace(/\/+$/, '')
    : null;
  return { url: url || null, title: s.title.trim().toLowerCase().replace(/\s+/g, ' ') };
}

/** Is this already held? By URL first — two titles for one page are one
 *  source — then by title. */
function findHeld(
  candidate: { url: string | null; title: string },
  held: readonly { url: string | null; title: string }[],
): boolean {
  const k = sourceKeys(candidate);
  return held.some((h) => {
    const hk = sourceKeys(h);
    return (k.url !== null && hk.url === k.url) || hk.title === k.title;
  });
}

export interface ImportPlan {
  toAdd: SourceInput[];
  /** Titles skipped because they are already held (or appear twice in the
   *  paste). Reported, so "imported 4 of 6" has its reason beside it. */
  duplicates: string[];
}

/** Which pasted sources are new. Also dedups within the paste itself. */
export function planImport(incoming: readonly SourceInput[], existing: readonly SourceInput[]): ImportPlan {
  const seen: SourceInput[] = [...existing];
  const toAdd: SourceInput[] = [];
  const duplicates: string[] = [];
  for (const s of incoming) {
    if (findHeld(s, seen)) {
      duplicates.push(s.title);
      continue;
    }
    toAdd.push(s);
    seen.push(s);
  }
  return { toAdd, duplicates };
}

export interface RedditSourceLike {
  sourceId: string;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  summary?: unknown;
  keyPoints?: unknown;
  answerAngles?: unknown;
  relatedProblems?: unknown;
}

export interface CopyPlan {
  toAdd: (SourceInput & { copiedFromSourceId: string })[];
  /** Reddit sources this project already holds a copy of — untouched. */
  alreadyHeld: number;
  /** Reddit rows that are not valid sources (no title). */
  unusable: number;
}

/**
 * Which of Reddit's sources to copy.
 *
 * Held means: copied from that exact Reddit source before (the id survives an
 * edit here), or the same URL, or the same title. Anything held is left alone.
 */
export function planCopyFromReddit(reddit: readonly RedditSourceLike[], existing: readonly ShopifySource[]): CopyPlan {
  const copiedIds = new Set(existing.map((s) => s.copiedFromSourceId).filter(Boolean));
  const seen: SourceInput[] = [...existing];
  const toAdd: CopyPlan['toAdd'] = [];
  let alreadyHeld = 0;
  let unusable = 0;

  for (const r of reddit) {
    const res = normaliseSource(r);
    if (!res.ok) {
      unusable++;
      continue;
    }
    if (copiedIds.has(r.sourceId) || findHeld(res.source, seen)) {
      alreadyHeld++;
      continue;
    }
    toAdd.push({ ...res.source, copiedFromSourceId: r.sourceId });
    seen.push(res.source);
  }
  return { toAdd, alreadyHeld, unusable };
}

export const toPromptSource = (s: ShopifySource): PromptSource => ({
  sourceId: s.sourceId,
  title: s.title,
  summary: s.summary,
  keyPoints: s.keyPoints,
  answerAngles: s.answerAngles,
});

/**
 * Which sources speak to a question.
 *
 * ⚠️ FREE, AND DELIBERATELY NOT A MODEL CALL. The analysis is handed a
 * shortlist rather than the whole list, and the BRAND GATE is decided here,
 * before anything is spent. Moved from server/shopifyDrafts.ts unchanged when
 * matching moved from draft time to analysis time: a row now knows whether
 * Brand is possible the moment it is analysed, rather than on a 400.
 *
 * Terms come from the fields a person wrote to say when a source applies — the
 * title, key points and answer angles — never the summary, which is prose and
 * matches everything.
 */
export function matchSources(sources: readonly PromptSource[], haystack: string, limit = 6): PromptSource[] {
  const hay = ` ${haystack.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

  const scored = sources.map((s) => {
    const terms = [s.title, ...s.keyPoints, ...s.answerAngles]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t));

    const unique = [...new Set(terms)];
    const hits = unique.filter((t) => hay.includes(` ${t} `)).length;
    // Normalised, or a source with fifty key points wins every thread by
    // volume rather than by fit.
    return { source: s, score: unique.length ? hits / Math.sqrt(unique.length) : 0, hits };
  });

  return scored
    .filter((s) => s.hits >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.source);
}

const STOPWORDS = new Set([
  'this','that','with','from','your','have','they','what','when','which','their','there','about','would',
  'could','should','other','than','then','them','were','been','being','into','more','most','some','such',
  'only','also','very','just','like','over','after','before','because','while','where','both','each',
  'shopify','store','stores','product','products','page','pages','customer','customers','help','need',
]);
