// HTML in, readable text and a stable hash out.
//
// PURE — it is handed a string and returns a value. The fetching lives in
// server/knowledge.ts; keeping the parse out of it is what lets a crawl be
// tested against saved fixtures with no network and no clock.
//
// ════════════════════════════════════════════════════════════════════════════
// NO PARSER DEPENDENCY, AND THAT IS A DECISION
//
// cheerio or jsdom would parse this properly. Neither is in the tree, and the
// job here does not justify adding one: we need the visible prose of a help
// article, not a DOM. A regex stripper is wrong on pathological markup and right
// on the documentation pages this actually reads.
//
// The failure mode is understood and bounded: if the extraction is poor, a human
// sees a poor proposal in the review queue and rejects it. Nothing reaches a
// reply without a person agreeing to it, which is exactly why the draft step
// exists. Revisit if the client's site turns out to be a JavaScript shell — that
// is a different problem (no text in the HTML at all) and a parser would not
// solve it either.
// ════════════════════════════════════════════════════════════════════════════

import type { CrawledPage } from './types';

/** Elements whose contents are never prose. Removed with their content. */
const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Tags that imply a line break when they close. Without this the whole page
 *  collapses into one sentence and every quote match spans two headings. */
const BLOCK_END = /<\/(p|div|li|ul|ol|h[1-6]|section|article|tr|td|th|blockquote|pre|br)\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  pound: '£',
  euro: '€',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** The document title, or '' when the page has none. */
export function extractTitle(html: string): string {
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tag) {
    const t = collapse(decodeEntities(stripTags(tag[1])));
    if (t) return t;
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 ? collapse(decodeEntities(stripTags(h1[1]))) : '';
}

/** Visible prose, one block per line, whitespace collapsed within each. */
export function extractText(html: string): string {
  const withoutHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  const withoutBlocks = withoutHead.replace(DROP_BLOCKS, ' ');
  const broken = withoutBlocks.replace(BLOCK_END, '\n');
  const text = decodeEntities(stripTags(broken));

  return text
    .split('\n')
    .map((line) => collapse(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

function stripTags(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The one normalisation used whenever a quote is matched against page text.
 *
 * ONE COPY, TWO CALLERS, AND THAT IS LOAD-BEARING. Ingestion accepts a claim
 * because its quote was found on the page; the re-crawl later decides the claim
 * has gone stale because its quote was NOT found. If those two used different
 * rules, every asset would go stale on its first check and the freshness loop
 * would read as broken.
 *
 * It survives the harmless differences — a re-flowed paragraph, a curly quote
 * swapped for a straight one, a doubled space. It must NOT survive a reworded
 * sentence, so nothing here drops or reorders words.
 */
export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A stable content hash — FNV-1a, 32-bit, hex.
 *
 * Not a cryptographic hash and does not need to be: it answers "did this page
 * change", where the adversary is a CMS, not an attacker. Chosen over
 * node:crypto so this file stays importable from the browser, which is what
 * keeps the whole module pure. Collisions would report a changed page as
 * unchanged; at 32 bits over one project's page count that risk is far smaller
 * than the risk of a human forgetting to look.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range without BigInt.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Everything a crawl produces, from raw HTML. */
export function crawlFromHtml(url: string, html: string, fetchedAtMs: number): CrawledPage {
  const text = extractText(html);
  return {
    url,
    title: extractTitle(html),
    text,
    hash: contentHash(text),
    fetchedAtMs,
  };
}

/**
 * Text a person pasted out of their own browser.
 *
 * Accepts either form without asking which it is, because the operator should
 * not have to know: "View source" gives HTML, selecting the article and copying
 * gives prose, and both are legitimate ways to answer a 403.
 *
 * The HTML test is deliberately conservative — a closing tag, not merely an
 * angle bracket — so prose that happens to contain "5 < 10" is not mangled
 * through the tag stripper.
 *
 * WHAT THIS DOES NOT DO: judge whether the text is really from that URL. It
 * cannot, and nothing downstream pretends otherwise — the asset is stamped
 * `pasted` and carries the name of whoever vouched for it. See TextSource.
 */
export function normalisePasted(input: string): string {
  const looksLikeHtml = /<\/(p|div|li|h[1-6]|section|article|body|span|td)\s*>/i.test(input);
  if (looksLikeHtml) return extractText(input);

  return input
    .split(/\r?\n/)
    .map((line) => collapse(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * How much of the page to hand a model.
 *
 * Ingestion reads help articles, which are short. A 200k-character marketing
 * page is not a help article and truncating it costs nothing we want; paying to
 * send it would. Cut on a line boundary so a quote is never half-present — a
 * claim whose supporting sentence was severed mid-way would fail its own quote
 * check later and look like a bug.
 */
export const MAX_PROMPT_CHARS = 12_000;

export function forPrompt(text: string, max = MAX_PROMPT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max * 0.5 ? cut : max);
}
