// The three model calls the interview makes, and the parsers that disbelieve
// them.
//
// PURE — prompt strings and JSON parsing. Versioned like every other prompt in
// this codebase, because the version is stamped on the knowledge it produces.
//
// ════════════════════════════════════════════════════════════════════════════
// NOTHING HERE IS ALLOWED TO KNOW ANYTHING ABOUT BETTING
//
// The client-agnostic requirement is not satisfied by leaving gambling words out
// of the strings; it is satisfied by the CATEGORIES being generated per client
// from a free-text industry description, and by the examples below being framed
// as SHAPES of question rather than subjects. A prompt that listed "cashout,
// parlays, KYC" would produce a sportsbook questionnaire for a payroll SaaS.
//
// The one betting reference in this file is inside an example that explicitly
// labels itself as an example of a different industry, so the model can see the
// shape without inheriting the vocabulary.
// ════════════════════════════════════════════════════════════════════════════

import { ASSET_KINDS, type AssetKind } from './types';
import type { ProposedClaim, ResearchAnswer, SourceKind } from './interview';

export const QUESTIONS_PROMPT_VERSION = 'v1';
export const RESEARCH_PROMPT_VERSION = 'v1';
export const GAP_PROMPT_VERSION = 'v1';

// ---------------------------------------------------------------------------
// 1. Generating the questionnaire
// ---------------------------------------------------------------------------

export const QUESTIONS_SYSTEM = `You design a research questionnaire that will teach a system enough about ONE company to contribute genuinely useful answers in public online discussions about that company's field.

You are NOT writing a company profile. Nobody will read your questions as a description of the business. Each one is a research task: something a researcher will go and look up in the company's own published material.

THE TEST EVERY QUESTION MUST PASS
Imagine a real person in a forum, with a real problem, in this company's field. Would the answer to this question let someone reply to them usefully? If not, cut it.

BAD questions — these teach nothing usable:
- "What is <company>?"
- "When was <company> founded?"
- "What services does <company> offer?"
- "Who are <company>'s competitors?"
- "What is <company>'s mission?"

GOOD questions — these are what to produce. Note the SHAPE, not the subject:
- "If a customer asks why <specific thing they rely on> stopped working, what does the company officially say causes that?"
- "Does the company publish a tool for <a specific task customers do manually>?"
- "What exactly can a customer see in <a specific part of the product>?"
- "What does the company document about <a process customers wait on and complain about>?"
- "What educational material does the company publish about <a concept in this field people get wrong>?"
- "What <account / access / eligibility> problems does the company document, and what does it say to do about them?"
- "In which discussions would mentioning this company add nothing useful?"

CATEGORIES
First decide the categories, from THIS company's industry and product. They must be the areas where its customers actually have problems and questions. Between 8 and 16 of them. Generate them from the industry description you are given — do not reuse a list from another kind of business.

At least one category must be about when the company is NOT relevant. A system that only knows when to speak will speak everywhere.

COVERAGE
- Spread the questions across the categories roughly evenly, weighted toward the categories where customers have the most problems.
- Every question must be answerable from published material — the company's site, help centre, documentation or blog. Do not ask about internal information, revenue, strategy or anything nobody publishes.
- Ask about specific, checkable things. "What does the company say about X" is answerable. "Is the company good at X" is not.
- Vary the shape: some about features, some about documented problems, some about published data or education, some about limits and eligibility, some about when to stay quiet.

Output STRICT JSON:
{"categories":["…"],"questions":[{"category":"…","question":"…","rationale":"one line on what conversation this would let us join","priority":1-5}]}

No prose, no markdown.`;

export function buildQuestionsPrompt(input: {
  clientName: string;
  industry: string;
  domains: string[];
  count: number;
  /** Categories to keep, when regenerating only part of a questionnaire. */
  onlyCategories?: string[];
  /** Questions that already exist, so a regeneration does not repeat them. */
  existing?: string[];
}): { system: string; user: string } {
  const lines = [
    'COMPANY',
    `Name: ${input.clientName}`,
    `Industry, in the operator's words: ${input.industry}`,
    `Published on: ${input.domains.join(', ') || '(no domains given)'}`,
    '',
    `Produce approximately ${input.count} questions.`,
  ];

  if (input.onlyCategories?.length) {
    lines.push(
      '',
      'RESTRICT TO THESE CATEGORIES — return them unchanged in `categories`:',
      input.onlyCategories.join(', '),
    );
  }

  if (input.existing?.length) {
    lines.push(
      '',
      'ALREADY ASKED — do not repeat these, and do not rephrase them:',
      ...input.existing.slice(0, 120).map((q) => `- ${q}`),
    );
  }

  lines.push('', 'Output ONLY the JSON.');
  return { system: QUESTIONS_SYSTEM, user: lines.join('\n') };
}

export interface GeneratedQuestion {
  category: string;
  question: string;
  rationale: string;
  priority: number;
}

export function parseQuestions(raw: unknown): { categories: string[]; questions: GeneratedQuestion[] } {
  const empty = { categories: [] as string[], questions: [] as GeneratedQuestion[] };
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as Record<string, unknown>;

  const categories = Array.isArray(o.categories)
    ? o.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : [];

  const questions = Array.isArray(o.questions)
    ? (o.questions as unknown[])
        .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
        .map((q) => ({
          category: typeof q.category === 'string' && q.category.trim() ? q.category.trim() : 'General',
          question: typeof q.question === 'string' ? q.question.trim() : '',
          rationale: typeof q.rationale === 'string' ? q.rationale.trim().slice(0, 300) : '',
          priority:
            typeof q.priority === 'number' && Number.isFinite(q.priority)
              ? Math.max(1, Math.min(5, Math.round(q.priority)))
              : 3,
        }))
        .filter((q) => q.question.length > 10)
    : [];

  // A model asked for a hundred questions repeats itself somewhere in the
  // eighties. Deduplicating here rather than at review time means the operator
  // never sees the same research task twice.
  const seen = new Set<string>();
  const unique = questions.filter((q) => {
    const key = q.question.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { categories, questions: unique };
}

// ---------------------------------------------------------------------------
// 2. Researching one question
// ---------------------------------------------------------------------------

export const RESEARCH_SYSTEM = `You answer ONE research question about a company, using ONLY the source pages given to you in this message.

You have no other knowledge of this company. Anything you believe about it that is not in these pages is not evidence and must not appear in your answer. This is the entire job: the pages, and nothing else.

IF THE PAGES DO NOT ANSWER THE QUESTION, SAY SO. Return {"found": false} with a short note on what was missing. This is a correct, valuable answer — it tells us the company does not publish this, which is something we need to know. It is far better than a plausible-sounding answer nobody can stand behind. Do not stretch a loosely related page into an answer.

WHEN YOU DO ANSWER

- shortAnswer: two or three sentences. What we would actually be able to tell someone.
- assetTitle: a short internal name for the thing this is about.
- assetKind: one of ${ASSET_KINDS.join(' | ')}.
- problemsSolved: the problems this addresses, in the words a CUSTOMER would use when complaining about them — not the words the page uses to sell it.
- conversationTriggers: phrases that, appearing in a discussion, mean this is relevant. Specific beats broad.
- notRelevantWhen: discussions where this would NOT be relevant even though a trigger word might appear. Think about this properly; it is what stops the company answering questions it has no business answering.
- claims: individual facts a reply could state. EACH ONE carries a quote copied EXACTLY from one of the source pages, and the URL of the page it came from. No ellipsis, no tidying, no joining two sentences. If you cannot copy a supporting sentence exactly, do not make the claim. Zero claims is a valid answer for a page that describes something without asserting anything checkable.
- brandAttributionHelps: true only if NAMING the company adds information to a reply — a documented mechanism, a published figure, a specific behaviour. False when the useful part of the answer is general knowledge that happens to appear on their page.
- complianceCaveats: anything about jurisdiction, licensing, eligibility or age that a reply built on this would have to respect. Empty if none.
- confidence: 0.0-1.0, how well the sources actually support the answer.

Output STRICT JSON, either {"found": false, "note": "…"} or {"found": true, …the fields above}. No prose, no markdown.`;

export interface ResearchSource {
  url: string;
  title: string;
  text: string;
}

export function buildResearchPrompt(input: {
  clientName: string;
  question: string;
  category: string;
  sources: ResearchSource[];
}): { system: string; user: string } {
  const blocks = input.sources.map(
    (s, i) => `--- SOURCE ${i + 1} ---\nURL: ${s.url}\nTitle: ${s.title || '(none)'}\n\n${s.text}`,
  );

  return {
    system: RESEARCH_SYSTEM,
    user: [
      `COMPANY: ${input.clientName}`,
      `CATEGORY: ${input.category}`,
      '',
      'QUESTION',
      input.question,
      '',
      `SOURCE PAGES (${input.sources.length})`,
      '',
      ...blocks,
      '',
      'Answer the question from these pages only. Output ONLY the JSON.',
    ].join('\n'),
  };
}

export interface ParsedResearch {
  found: boolean;
  note: string;
  answer: Omit<ResearchAnswer, 'model' | 'promptVersion' | 'researchedAt'> | null;
  /** Claims dropped because their quote is not in any source page. */
  rejected: { claim: ProposedClaim; reason: string }[];
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, max)
    : [];

/**
 * Parse a research response and throw away every claim it cannot support.
 *
 * THE SAME RULE AS INGESTION, APPLIED ACROSS SEVERAL PAGES. A quote must appear
 * verbatim in one of the sources that were actually supplied. A claim whose
 * quote is nowhere is dropped before a human sees it — not flagged, dropped,
 * because a reviewer shown twelve claims approves twelve claims.
 *
 * `normalise` is passed in rather than imported so this file stays free of the
 * extract module, which keeps the prompt layer importable anywhere.
 */
export function parseResearch(
  raw: unknown,
  sources: ResearchSource[],
  normalise: (s: string) => string,
): ParsedResearch {
  const miss = (note: string): ParsedResearch => ({ found: false, note, answer: null, rejected: [] });

  if (!raw || typeof raw !== 'object') return miss('The researcher did not return a usable answer.');
  const o = raw as Record<string, unknown>;

  if (o.found !== true) {
    return miss(typeof o.note === 'string' && o.note.trim() ? o.note.trim() : 'Not covered by the sources found.');
  }

  const shortAnswer = typeof o.shortAnswer === 'string' ? o.shortAnswer.trim() : '';
  const assetTitle = typeof o.assetTitle === 'string' ? o.assetTitle.trim() : '';
  if (!shortAnswer || !assetTitle) return miss('The answer came back incomplete.');

  const haystacks = sources.map((s) => ({ url: s.url, text: normalise(s.text) }));

  const claims: ProposedClaim[] = [];
  const rejected: { claim: ProposedClaim; reason: string }[] = [];

  const rawClaims = Array.isArray(o.claims) ? (o.claims as unknown[]) : [];
  for (const item of rawClaims.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const claim: ProposedClaim = {
      claim: typeof c.claim === 'string' ? c.claim.trim() : '',
      quote: typeof c.quote === 'string' ? c.quote.trim() : '',
      sourceUrl: typeof c.sourceUrl === 'string' ? c.sourceUrl.trim() : '',
    };
    if (!claim.claim) continue;

    if (!claim.quote) {
      rejected.push({ claim, reason: 'No supporting quote.' });
      continue;
    }
    const needle = normalise(claim.quote);
    if (needle.length < 25) {
      rejected.push({ claim, reason: 'The quote is too short to support anything.' });
      continue;
    }
    const hit = haystacks.find((h) => h.text.includes(needle));
    if (!hit) {
      rejected.push({ claim, reason: 'That sentence is not on any of the pages we read.' });
      continue;
    }
    // Trust the page it was actually found on over the URL the model attached.
    claims.push({ ...claim, sourceUrl: hit.url });
  }

  const confidence =
    typeof o.confidence === 'number' && Number.isFinite(o.confidence)
      ? Math.max(0, Math.min(1, o.confidence))
      : 0.5;

  return {
    found: true,
    note: '',
    rejected,
    answer: {
      shortAnswer,
      assetTitle,
      assetKind: (ASSET_KINDS as readonly string[]).includes(o.assetKind as string)
        ? (o.assetKind as AssetKind)
        : 'guide',
      problemsSolved: strings(o.problemsSolved, 6),
      conversationTriggers: strings(o.conversationTriggers, 8),
      notRelevantWhen: strings(o.notRelevantWhen, 5),
      claims,
      sourceUrls: [...new Set(sources.map((s) => s.url))],
      sourceKind: 'official' as SourceKind,
      brandAttributionHelps: o.brandAttributionHelps === true,
      complianceCaveats: strings(o.complianceCaveats, 5),
      confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. The gap pass — what nobody thought to ask
// ---------------------------------------------------------------------------

export const GAP_SYSTEM = `You are looking at what a research pass FOUND about a company, and your job is to notice what nobody thought to ask about.

You are given: the categories the questionnaire covered, and a list of pages that were seen on the company's site — their URLs and how they were linked.

Find the things the questionnaire missed. Specifically:
- a product, tool, feature or published resource that appears in the page list but that no category covers;
- a documented behaviour or process the questions did not reach;
- an area where the company clearly publishes material that nobody asked about.

For each, write a research question in the same style as the originals: something a real customer would ask in a discussion, answerable from published material.

This matters because the most valuable thing a company has is often the thing nobody knew to ask about — a questionnaire written before anyone looked at the site can only cover what was expected.

Return at most 20. Return an empty list if the questionnaire genuinely covered everything — that is a real answer and a good one.

Output STRICT JSON: {"questions":[{"category":"…","question":"…","rationale":"what the questionnaire missed and why it matters","priority":1-5}]}. Categories may be existing ones or new. No prose.`;

export function buildGapPrompt(input: {
  clientName: string;
  categories: string[];
  askedSamples: string[];
  pages: { url: string; anchors: string[] }[];
}): { system: string; user: string } {
  return {
    system: GAP_SYSTEM,
    user: [
      `COMPANY: ${input.clientName}`,
      '',
      'CATEGORIES THE QUESTIONNAIRE COVERED',
      input.categories.join(', ') || '(none)',
      '',
      'A SAMPLE OF WHAT WAS ASKED',
      ...input.askedSamples.slice(0, 40).map((q) => `- ${q}`),
      '',
      `PAGES SEEN ON THE SITE (${input.pages.length})`,
      ...input.pages
        .slice(0, 150)
        .map((p) => `- ${p.url}${p.anchors.length ? ` — linked as "${p.anchors[0]}"` : ''}`),
      '',
      'What did the questionnaire miss? Output ONLY the JSON.',
    ].join('\n'),
  };
}

/** The gap pass returns the same shape as generation, minus the categories. */
export function parseGapQuestions(raw: unknown): GeneratedQuestion[] {
  return parseQuestions(raw).questions;
}
