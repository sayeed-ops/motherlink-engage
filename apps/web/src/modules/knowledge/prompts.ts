// Turning one crawled page into a proposed asset and its claims.
//
// PURE — prompt strings and a parser. Centralised and VERSIONED for the same
// reason modules/reddit/prompts.ts is: the version is stamped on every asset, so
// when a later prompt starts producing better exclusions it is possible to tell
// which assets predate it rather than guessing.
//
// ════════════════════════════════════════════════════════════════════════════
// THE QUOTE RULE IS THE WHOLE DESIGN
//
// A model reading a product page will write you a beautiful list of things the
// product does, and some of them will not be on the page. Asking it to be
// careful does not fix this; asking it to quote does, because a quote is
// checkable and we check it (see parseProposal). Any claim whose supporting
// sentence is not present in the page text is DROPPED before a human ever sees
// it — not flagged, dropped, because a reviewer shown twelve claims will approve
// twelve claims.
//
// This is also why the prompt asks for the quote verbatim and forbids ellipsis:
// a quote we have to fuzzy-match is a quote we cannot verify.
// ════════════════════════════════════════════════════════════════════════════

import { normaliseForMatch } from './extract';
import { ASSET_KINDS, type AssetKind, type AssetProposal, type ClaimProposal } from './types';

export const INGEST_PROMPT_VERSION = 'v1';

export const INGEST_SYSTEM = `You read ONE page from a company's own website and describe what it gives the company the right to talk about.

You are building an internal reference, not marketing copy. Nothing you write is published. Someone will read your output and decide whether the company may cite this page in a public forum reply, so accuracy matters far more than enthusiasm.

WHAT YOU PRODUCE

1. ONE asset — the single thing this page is about. If the page covers several things, describe the main one; do not invent a composite.
2. Its CLAIMS — individual facts from this page that a reply could state.

FIELD RULES

- title: a short internal name. "Cashout availability", not "Everything you need to know about cashout".
- kind: one of ${ASSET_KINDS.join(' | ')}.
- purpose: one or two sentences. What it is and who it helps.
- problems: the problems this genuinely solves, in the words a customer would use when complaining about them — not the words the page uses to sell it. 2-6 items.
- triggers: short phrases that, appearing in a discussion, mean this page is relevant. 3-8 items. Specific beats broad: "cashout disappeared" is useful, "betting" is not.
- exclusions: discussions where this page would NOT be relevant even though a trigger word might appear. 1-5 items. THINK ABOUT THIS ONE PROPERLY — it is the field that stops the company answering questions it has no business answering. If a trigger word has an unrelated everyday meaning, say so here.

CLAIM RULES

- Each claim is ONE fact, stated plainly, as a reply would state it.
- Each claim carries a quote: the sentence from the page that supports it, copied EXACTLY. No ellipsis, no tidying, no joining two sentences. If you cannot copy a supporting sentence exactly, do not make the claim.
- Only facts THIS page states. Not what you know about the company from elsewhere, not industry general knowledge, not reasonable inference.
- No marketing claims. "Fast withdrawals" is not a fact. "Withdrawals are processed within 24 hours" is, if the page says so.
- No claim about anything outside this page's subject.
- 0-8 claims. ZERO IS A CORRECT ANSWER for a page that describes something without asserting anything checkable — a landing page usually has none.

Output STRICT JSON only, matching the schema in the user message. No prose, no markdown, no commentary.`;

export function buildIngestPrompt(page: { url: string; title: string; text: string }): {
  system: string;
  user: string;
} {
  const user = [
    'PAGE',
    `URL: ${page.url}`,
    `Title: ${page.title || '(none)'}`,
    '',
    'CONTENT',
    page.text,
    '',
    'SCHEMA',
    JSON.stringify(
      {
        title: 'string',
        kind: ASSET_KINDS.join('|'),
        purpose: 'string',
        problems: ['string'],
        triggers: ['string'],
        exclusions: ['string'],
        claims: [{ text: 'string', quote: 'string (verbatim from CONTENT)' }],
      },
      null,
      2,
    ),
    '',
    'Describe this page now. Output ONLY the JSON.',
  ].join('\n');

  return { system: INGEST_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// Parsing and verification
// ---------------------------------------------------------------------------

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, max)
    : [];

function asKind(v: unknown): AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(v as string) ? (v as AssetKind) : 'guide';
}

export interface VerifiedProposal {
  proposal: AssetProposal;
  /** Claims the model offered whose quote is not on the page. Reported so the
   *  operator can see the model over-reaching, but NEVER offered for approval. */
  rejected: { claim: ClaimProposal; reason: string }[];
}

/**
 * Parse the model's JSON and throw away anything unsupportable.
 *
 * Returns null only when the response is not an asset at all. A proposal with
 * every claim rejected is still a valid proposal — the asset may be perfectly
 * real and simply assert nothing checkable, which is the normal shape of a
 * landing page.
 */
export function parseProposal(raw: unknown, pageText: string): VerifiedProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const purpose = typeof o.purpose === 'string' ? o.purpose.trim() : '';
  if (!title || !purpose) return null;

  const rawClaims: ClaimProposal[] = Array.isArray(o.claims)
    ? (o.claims as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          text: typeof c.text === 'string' ? c.text.trim() : '',
          quote: typeof c.quote === 'string' ? c.quote.trim() : '',
        }))
        .filter((c) => c.text.length > 0)
        .slice(0, 8)
    : [];

  const haystack = normaliseForMatch(pageText);
  const claims: ClaimProposal[] = [];
  const rejected: { claim: ClaimProposal; reason: string }[] = [];

  for (const claim of rawClaims) {
    if (!claim.quote) {
      rejected.push({ claim, reason: 'No supporting quote was given.' });
      continue;
    }
    // A quote shorter than this matches by accident. "Cashout" appears on a
    // cashout page a dozen times and supports nothing.
    if (normaliseForMatch(claim.quote).length < 25) {
      rejected.push({ claim, reason: 'The quote is too short to support anything.' });
      continue;
    }
    if (!haystack.includes(normaliseForMatch(claim.quote))) {
      rejected.push({ claim, reason: 'That sentence is not on the page.' });
      continue;
    }
    claims.push(claim);
  }

  return {
    proposal: {
      title,
      kind: asKind(o.kind),
      purpose,
      problems: strings(o.problems, 6),
      triggers: strings(o.triggers, 8),
      exclusions: strings(o.exclusions, 5),
      claims,
    },
    rejected,
  };
}
