// Guessing what a page is for, from its URL and the words people used to link
// to it.
//
// PURE — a prompt builder and a parser.
//
// ════════════════════════════════════════════════════════════════════════════
// THE MODEL IS NOT SHOWN THE PAGE, AND THE PROMPT SAYS SO REPEATEDLY
//
// Classification happens before anything is fetched. That is the whole economy
// of discovery: one call sorts fifty candidates, where fetching fifty pages
// would cost fifty requests and fifty completions to produce the same queue.
//
// The consequence is that every output here is a GUESS from a URL and some
// anchor text, and the prompt is written to make the model say so — it is asked
// for what the page "appears" to be for, given a confidence, and told plainly
// that inventing facts about the page is the failure mode. A classifier that
// starts asserting what a page contains has quietly become a source of claims,
// which is the one thing discovery must never be.
//
// The `usefulFor` line exists to be read by a person deciding whether to spend a
// real ingest on this page. It is a recommendation to look, never evidence.
// ════════════════════════════════════════════════════════════════════════════

import { ASSET_KINDS, type AssetKind } from './types';

export const CLASSIFY_PROMPT_VERSION = 'v1';

export const CLASSIFY_SYSTEM = `You are sorting pages from one company's website so a human can decide which are worth reading properly.

YOU HAVE NOT SEEN THESE PAGES. You are given a URL and, sometimes, the text of links that pointed at it. Everything you produce is an inference from those two things and must be phrased as one.

For each candidate, decide:

- usefulFor: one short line on what a page at this URL, described this way, would probably help answer. Write it as the QUESTION a customer might ask, not as a claim about the page. Good: "why a cashout offer disappeared". Bad: "explains that cashout disappears when markets suspend" — you do not know that.
- kind: one of ${ASSET_KINDS.join(' | ')}.
- confidence: 0-100. How sure are you that this page is what it looks like? A URL with clear anchor text is high. A bare numeric URL with no anchor is low, however promising the path looks.
- worthReading: true if a person building a support-and-education knowledge base for this company should spend a page read on it. false for pages that are real but useless for that: careers, investor relations, app-store landing pages, affiliate sign-ups, duplicated category listings, pages that are obviously just navigation.

RULES

- NEVER state what the page says. You do not know. Describe what it is probably FOR.
- Do not invent a topic that neither the URL nor the anchors support. If a URL is opaque and there is no anchor text, say so through a low confidence and a vague usefulFor — that is the correct answer, not a failure.
- Legal and policy pages are worth reading. Terms, payout rules and responsible-gambling pages answer real questions.
- Marketing landing pages with no substance are not worth reading, even when the URL looks important.

Output STRICT JSON: {"results":[{"url":"…","usefulFor":"…","kind":"…","confidence":0,"worthReading":true}]}. One entry per candidate, same URLs, no extras, no prose.`;

export interface ClassifyInput {
  url: string;
  anchors: string[];
}

export function buildClassifyPrompt(candidates: ClassifyInput[]): { system: string; user: string } {
  const lines = candidates.map((c, i) => {
    const anchors = c.anchors.length ? c.anchors.slice(0, 4).join(' | ') : '(no link text seen)';
    return `${i + 1}. ${c.url}\n   linked as: ${anchors}`;
  });

  return {
    system: CLASSIFY_SYSTEM,
    user: [
      `CANDIDATES (${candidates.length})`,
      '',
      ...lines,
      '',
      'Classify every one of them. Output ONLY the JSON.',
    ].join('\n'),
  };
}

export interface Classification {
  url: string;
  usefulFor: string;
  kind: AssetKind;
  confidence: number;
  worthReading: boolean;
}

/**
 * Parse the batch response, keyed by URL.
 *
 * KEYED RATHER THAN POSITIONAL, deliberately. A model asked for fifty results
 * sometimes returns forty-nine, and a positional read would then attach every
 * later classification to the wrong page — silently, and in a way that looks
 * fine on screen. Anything it fails to return simply has no classification, and
 * the caller shows the candidate without one.
 */
export function parseClassifications(raw: unknown): Map<string, Classification> {
  const out = new Map<string, Classification>();
  if (!raw || typeof raw !== 'object') return out;

  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return out;

  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    if (!url) continue;

    const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? Math.max(0, Math.min(100, Math.round(o.confidence)))
      : 0;

    out.set(url, {
      url,
      usefulFor: typeof o.usefulFor === 'string' ? o.usefulFor.trim().slice(0, 300) : '',
      kind: (ASSET_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as AssetKind) : 'guide',
      confidence,
      // Absent means NOT worth reading. The default has to fall on the side that
      // costs nothing: an unread good page is a missed opportunity, a queue full
      // of junk is a feature nobody opens twice.
      worthReading: o.worthReading === true,
    });
  }
  return out;
}
