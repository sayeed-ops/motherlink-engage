// Which assets, if any, this conversation is actually about.
//
// PURE, and lexical on purpose. There is no embedding store in this stack and
// adding one to answer "does the client know anything about cashout" would be a
// vector database standing between a question and an answer that a phrase list
// gets right. The model still makes the judgement call afterwards — this stage
// only decides which five assets it gets to see, and being approximately right
// about that is enough.
//
// ════════════════════════════════════════════════════════════════════════════
// THE POINT OF THIS FILE IS THE VETO, NOT THE RANKING
//
// Ranking assets by keyword overlap is easy and half-useful. The half that
// matters is `exclusions`: a matcher that can only say yes will, given a large
// enough library and a hopeful enough prompt, find something relevant in every
// thread on the forum. That is precisely the failure mode this whole design
// exists to avoid, and it is why an exclusion hit removes an asset outright
// rather than subtracting from its score. A score can be outrun by enough weak
// matches. A veto cannot.
// ════════════════════════════════════════════════════════════════════════════

import type { Asset } from './types';

/** What the thread is about, extracted upstream. Free text: a phrase per
 *  concept, in the words the thread used, not ours. */
export interface RetrievalQuery {
  /** The intent classifier's concepts — "cashout", "market suspension". */
  concepts: string[];
  /** The thread's own text — title plus the post being answered. Weakest
   *  signal, but it is what catches the phrasing nobody thought to list. */
  text: string;
}

export interface AssetMatch {
  asset: Asset;
  /** 0..100. Comparable within one query only; it is not a probability. */
  score: number;
  /** Which of the asset's own phrases fired. Shown in review as "why this". */
  matched: { triggers: string[]; problems: string[] };
}

export interface RetrievalResult {
  matches: AssetMatch[];
  /** Assets a veto removed, with the exclusion that did it. Kept because "we
   *  found it and rejected it" is a different answer from "we found nothing",
   *  and only one of them means the library has a gap. */
  vetoed: { asset: Asset; exclusion: string }[];
}

/** How many assets reach the prompt. Five is a working default: enough for a
 *  genuine choice, few enough that the model reads them all rather than
 *  skimming. */
export const DEFAULT_TOP_N = 5;

/**
 * Below this, a match is noise.
 *
 * The floor is set to mean exactly one thing: AT LEAST ONE CURATED PHRASE
 * MATCHED SOMETHING THE THREAD IS ACTUALLY ABOUT. A trigger anywhere clears it
 * (40 or 22), and so does a problem matched against an extracted concept (18) —
 * a problem statement is somebody's considered description of what this asset
 * addresses, so one of them landing is real evidence.
 *
 * What must NOT clear it is incidental overlap: the asset's title happening to
 * share a word (6), or one problem phrase turning up loose in the thread text
 * (10). Even together those two fall short, which is deliberate — the weights
 * and this number are one decision, and changing either alone breaks it.
 */
export const MIN_SCORE = 18;

// --- weights ---------------------------------------------------------------
// Ordered by how deliberate the signal is. A trigger phrase is somebody stating
// "this asset is for threads that say this"; a title word is an accident of
// naming.
const W_TRIGGER_IN_CONCEPT = 40;
const W_TRIGGER_IN_TEXT = 22;
const W_PROBLEM_IN_CONCEPT = 18;
const W_PROBLEM_IN_TEXT = 10;
const W_TITLE = 6;

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'my', 'no', 'not', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'what', 'when', 'why', 'with', 'you', 'your',
]);

export function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Does `phrase` appear in `haystackTokens`?
 *
 * ALL tokens of the phrase must be present. "line movement" must not match a
 * thread that merely says "movement", because the whole value of a curated
 * trigger list is that it is more specific than a bag of words. Order is not
 * required — forum prose reorders everything.
 */
function phraseHits(phrase: string, haystack: Set<string>): boolean {
  const tokens = tokenise(phrase);
  if (tokens.length === 0) return false;
  return tokens.every((t) => haystack.has(t));
}

/**
 * Retrieve the assets this thread might be about.
 *
 * `usableAssetIds` is how freshness reaches this file without it importing the
 * clock: the caller has already worked out which assets are currently fit to
 * offer, and anything not in that set is never considered. Passing `null` means
 * "no freshness filter", which is what the library browser wants and what a
 * scan must never use.
 */
export function retrieve(
  query: RetrievalQuery,
  assets: Asset[],
  opts: { topN?: number; usableAssetIds?: Set<string> | null } = {},
): RetrievalResult {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const usable = opts.usableAssetIds;

  const conceptTokens = new Set(query.concepts.flatMap(tokenise));
  const textTokens = new Set(tokenise(query.text));
  // A concept is also part of the text as far as matching is concerned; keeping
  // them separate only changes which weight applies.
  const anyTokens = new Set([...conceptTokens, ...textTokens]);

  const matches: AssetMatch[] = [];
  const vetoed: { asset: Asset; exclusion: string }[] = [];

  for (const asset of assets) {
    if (usable && !usable.has(asset.assetId)) continue;

    // THE VETO, FIRST. Before any scoring, because an excluded asset is not a
    // low-scoring match — it is a wrong one, and it must not be able to reach
    // the prompt by scoring well on everything else.
    const exclusion = asset.exclusions.find((e) => phraseHits(e, anyTokens));
    if (exclusion) {
      vetoed.push({ asset, exclusion });
      continue;
    }

    let score = 0;
    const matchedTriggers: string[] = [];
    const matchedProblems: string[] = [];

    for (const trigger of asset.triggers) {
      if (phraseHits(trigger, conceptTokens)) {
        score += W_TRIGGER_IN_CONCEPT;
        matchedTriggers.push(trigger);
      } else if (phraseHits(trigger, textTokens)) {
        score += W_TRIGGER_IN_TEXT;
        matchedTriggers.push(trigger);
      }
    }

    for (const problem of asset.problems) {
      if (phraseHits(problem, conceptTokens)) {
        score += W_PROBLEM_IN_CONCEPT;
        matchedProblems.push(problem);
      } else if (phraseHits(problem, textTokens)) {
        score += W_PROBLEM_IN_TEXT;
        matchedProblems.push(problem);
      }
    }

    if (phraseHits(asset.title, anyTokens)) score += W_TITLE;

    if (score >= MIN_SCORE) {
      matches.push({
        asset,
        score: Math.min(100, score),
        matched: { triggers: matchedTriggers, problems: matchedProblems },
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.asset.title.localeCompare(b.asset.title));
  return { matches: matches.slice(0, topN), vetoed };
}

/**
 * Did we find anything worth showing a model?
 *
 * Named rather than inlined as `matches.length > 0` because the answer is a
 * decision the pipeline branches on twice — whether to generate the
 * brand-mentioned variant, and whether to write a gap record — and those two
 * must never disagree about what "no match" meant.
 */
export function hasMatch(result: RetrievalResult): boolean {
  return result.matches.length > 0;
}
