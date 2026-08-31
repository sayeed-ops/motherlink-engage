// The deep client interview — teaching the system a client well enough to be
// useful in a conversation it has not seen yet.
//
// PURE. Types, coverage arithmetic, corpus ranking and the duplicate decision.
// The fetching and the model calls live in server/interview.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY A QUESTIONNAIRE RATHER THAN A CRAWL
//
// Discovery (./discovery.ts) answers "what pages does this client have". That is
// a different question from "what could this client usefully say", and the gap
// between them is where the value is. A crawl finds a page called
// `/help/articles/4872560`; it cannot tell you that the page is the answer to
// "why did my cashout vanish mid-game", because nobody asks that question in a
// URL.
//
// So the interview runs the other way round: generate the QUESTIONS a real
// person would ask in a forum, then go looking for whether this client has
// anything that answers them. The output is indexed by conversation, which is
// how it will be queried later.
//
// THE MOST IMPORTANT ANSWER IS "NOT FOUND". A questionnaire that always finds
// something has learned nothing — it has just laundered the model's priors about
// gambling companies into a knowledge base with the client's name on it. An
// honest not-found is what makes the found ones worth trusting, and it is also
// the input to the gap board: it says exactly what this client does not publish.
// ════════════════════════════════════════════════════════════════════════════

import type { AssetKind } from './types';

// ---------------------------------------------------------------------------
// The interview
// ---------------------------------------------------------------------------

export type InterviewStatus = 'draft' | 'researching' | 'ready';

/** `projects/{projectId}/interview/current` — one per client, replaceable. */
export interface Interview {
  projectId: string;
  clientName: string;
  /** Where research is allowed to read. The same list discovery walks. */
  domains: string[];
  /**
   * What kind of business this is, in the operator's words.
   *
   * FREE TEXT, NOT AN ENUM, and that is the whole client-agnostic mechanism.
   * The categories below are generated from this sentence, so a sportsbook, a
   * crypto exchange and a payroll SaaS each get a questionnaire shaped like
   * their own industry. An enum would have meant a code change per vertical,
   * which is exactly the hard-coding this must not have.
   */
  industry: string;
  /** Generated per client, never hard-coded. */
  categories: string[];
  status: InterviewStatus;
  questionCount: number;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type QuestionStatus =
  | 'pending' // generated, not researched
  | 'answered' // research found something, with sources
  | 'not-found' // researched and nothing usable came back — see NotFoundReason
  | 'skipped'; // the operator does not want it pursued

/**
 * WHY nothing came back, and these are not the same finding at all.
 *
 * Collapsing them was a real bug: the runner has always distinguished four
 * causes and written the reason down, and the screen showed one sentence for
 * all of them. An operator looking at forty identical warnings cannot tell
 * "this client does not publish this" — a fact about the client, and the whole
 * point of the exercise — from "their site refused us forty times", which is a
 * fact about our access and has an obvious fix.
 *
 * `blocked` in particular is ACTIONABLE: those questions are answerable by
 * pasting the page in, and they should be presented as work rather than as an
 * absence.
 */
export type NotFoundReason =
  | 'no-candidate' // nothing in the corpus looked relevant. Discovery may be thin.
  | 'blocked' // the relevant pages exist and would not let us read them
  | 'not-covered' // pages were read, and they genuinely do not answer it
  | 'bad-response'; // the researcher returned something unusable

export const NOT_FOUND_LABEL: Record<NotFoundReason, string> = {
  'no-candidate': 'No relevant page found',
  blocked: 'Page blocked us',
  'not-covered': 'Not covered on the site',
  'bad-response': 'Research failed',
};

export type ReviewState =
  | 'none' // nothing to review — unanswered
  | 'pending' // answered, awaiting a human
  | 'approved' // in the library
  | 'rejected' // deliberately not wanted
  | 'later'; // interesting, not now

/** Where a question came from. Drives nothing mechanical; it is how an operator
 *  tells the generated hundred from the ones the system asked for itself. */
export type QuestionOrigin =
  | 'generated' // from the initial questionnaire
  | 'operator' // typed in by a person
  | 'gap' // the second pass: something we found that nobody asked about
  | 'opportunity'; // a live forum thread we could not match

/** `projects/{p}/interview/current/questions/{questionId}` */
export interface InterviewQuestion {
  questionId: string;
  projectId: string;
  category: string;
  /** The question, phrased as a bettor/customer would ask it in a forum. */
  question: string;
  /** Why this is worth asking. Shown to the operator, never to a model. */
  rationale: string;
  /** 1-5. Ordering for the research runs, not a judgement of the answer. */
  priority: number;
  origin: QuestionOrigin;
  status: QuestionStatus;
  review: ReviewState;
  answer: ResearchAnswer | null;
  /** Set when status is 'not-found'. Which of the four causes it was. */
  notFoundReason: NotFoundReason | null;
  /** The runner's own sentence about what happened. Always shown. */
  note: string;
  /** The pages that were read, or attempted. Shown so an operator can see
   *  whether research even looked at the right part of the site. */
  sourcesRead: string[];
  /** What the duplicate check decided, once researched. */
  dedupe: DedupeVerdict | null;
  /** Set when approval created or updated an asset. */
  assetId: string | null;
  /** For an opportunity-triggered question: the thread that provoked it. */
  provokedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * How much the source is worth.
 *
 * `official` — a page on one of the client's approved domains. The only kind
 * research can produce on its own, because the only pages this system can
 * enumerate are the ones the client publishes.
 *
 * `operator` — content a person supplied by hand, for a page the server cannot
 * read. Carries their name, exactly as a pasted asset does.
 *
 * `external` — a third-party page an operator explicitly pointed at. Reachable
 * only that way: there is no web search in this stack, so nothing can wander off
 * the approved domains looking for coverage.
 */
export type SourceKind = 'official' | 'operator' | 'external';

export interface ProposedClaim {
  claim: string;
  /** Verbatim from the source. Checked, exactly as ingestion checks. */
  quote: string;
  sourceUrl: string;
}

/** What research produced for one question. Maps onto Asset + Claim on
 *  approval — deliberately NOT a parallel knowledge store. */
export interface ResearchAnswer {
  /** Two or three sentences. What we would actually be able to say. */
  shortAnswer: string;

  // --- the asset this becomes, in the existing vocabulary -----------------
  assetTitle: string;
  assetKind: AssetKind;
  /** In the words a customer would use when complaining. */
  problemsSolved: string[];
  /** Phrases in a thread that mean this is relevant. */
  conversationTriggers: string[];
  /** The veto list. The field a model is worst at and an operator best at. */
  notRelevantWhen: string[];

  claims: ProposedClaim[];
  sourceUrls: string[];
  sourceKind: SourceKind;

  /**
   * Would naming the client here add information?
   *
   * The question the variant system will ask later, answered once at research
   * time by whoever has read the source. "Northwind's documentation says X" is worth
   * saying; "Northwind also has sports betting" is not.
   */
  brandAttributionHelps: boolean;
  /** Jurisdiction, licensing or age caveats attached to using this. */
  complianceCaveats: string[];

  /** 0-1. The researcher's confidence that the sources support the answer. */
  confidence: number;
  model: string;
  promptVersion: string;
  researchedAt: Date;

  // --- provenance ---------------------------------------------------------
  /**
   * Did THIS SERVER produce this answer, or did it arrive in a file?
   *
   * ⚠️ NEVER INFERRED, and absent reads as `researched` — because every answer
   * written before imports existed genuinely was researched here, against pages
   * this server fetched, with every claim quote-checked. Exactly the convention
   * `TextSource` follows in types.ts, for exactly the same reason: the two must
   * be distinguishable in the DATA and not only on a screen.
   *
   * An imported answer carries no verified quotes — the file's author read the
   * page, we did not — so it may shape what a reply says and may never be the
   * evidence behind a stated fact. The asset it becomes is written
   * `textSource: 'unverified'` and carries no claims.
   */
  answerSource?: 'researched' | 'imported';
  /** Import only: who brought it in, when, and what the file called itself. */
  importedBy?: string;
  importedByName?: string;
  importedAt?: Date;
  importedFrom?: string;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DedupeAction = 'new' | 'update' | 'duplicate';

export interface DedupeVerdict {
  action: DedupeAction;
  /** The asset this overlaps with, for `update` and `duplicate`. */
  assetId: string | null;
  assetTitle: string;
  /** 0-100 overlap. Ordering and explanation, not a threshold in itself. */
  overlap: number;
  reason: string;
}

/**
 * Does this answer already exist in the library?
 *
 * THE QUESTIONNAIRE IS AN EXPANSION, NOT A SECOND LIBRARY. A hundred questions
 * about a sportsbook will circle the same dozen features from different angles —
 * "can I track SGM legs", "what does bet history show", "how do I follow a
 * parlay" all land on one bet-tracking page. Without this check, approving the
 * queue creates five assets for one feature, and retrieval then returns five
 * near-identical matches and burns the prompt budget on repetition.
 *
 * The overlap is computed from the SOURCE URL first and the trigger phrases
 * second. A shared source URL is near-proof: two answers citing the same page
 * are about the same thing, whatever they are titled.
 */
export function decideDedupe(
  answer: Pick<ResearchAnswer, 'sourceUrls' | 'conversationTriggers' | 'assetTitle'>,
  existing: { assetId: string; title: string; sourceUrl: string; triggers: string[] }[],
): DedupeVerdict {
  let best: DedupeVerdict = {
    action: 'new',
    assetId: null,
    assetTitle: '',
    overlap: 0,
    reason: 'Nothing in the library covers this.',
  };

  const answerUrls = new Set(answer.sourceUrls.map(canonicalUrl));
  const answerTriggers = new Set(answer.conversationTriggers.map(normalisePhrase));

  for (const asset of existing) {
    let overlap = 0;

    // Same page, same subject. Worth more than any amount of phrase similarity,
    // because two answers drawn from one document cannot be separate assets.
    if (asset.sourceUrl && answerUrls.has(canonicalUrl(asset.sourceUrl))) overlap += 60;

    const assetTriggers = new Set(asset.triggers.map(normalisePhrase));
    const shared = [...answerTriggers].filter((t) => assetTriggers.has(t)).length;
    if (assetTriggers.size > 0 && answerTriggers.size > 0) {
      overlap += Math.round((shared / Math.min(assetTriggers.size, answerTriggers.size)) * 30);
    }

    if (normalisePhrase(asset.title) === normalisePhrase(answer.assetTitle)) overlap += 20;

    overlap = Math.min(100, overlap);
    if (overlap <= best.overlap) continue;

    best =
      overlap >= 80
        ? {
            action: 'duplicate',
            assetId: asset.assetId,
            assetTitle: asset.title,
            overlap,
            reason: 'The library already has this, from the same page.',
          }
        : overlap >= 40
          ? {
              action: 'update',
              assetId: asset.assetId,
              assetTitle: asset.title,
              overlap,
              reason: 'Overlaps an existing asset — approve to add these triggers and claims to it.',
            }
          : {
              action: 'new',
              assetId: null,
              assetTitle: asset.title,
              overlap,
              reason: 'Related to something in the library, but distinct enough to stand alone.',
            };
  }

  return best;
}

function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalisePhrase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Corpus ranking
// ---------------------------------------------------------------------------

const STOP = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'client', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'say',
  'says', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'we', 'what', 'when',
  'where', 'which', 'why', 'with', 'would', 'you', 'your', 'provide', 'provides', 'official',
  'officially', 'information', 'user', 'users', 'people', 'someone', 'ask', 'asks', 'question',
]);

export function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2 && !STOP.has(t)),
    ),
  ];
}

export interface CorpusPage {
  url: string;
  /** Link text and titles seen for this page. Free, and often the only signal. */
  anchors: string[];
}

/**
 * Which pages are worth reading to answer this question.
 *
 * LEXICAL, over the URL path and the anchor text, because that is all we have
 * before spending a fetch. It only has to be roughly right: it decides which
 * three of four hundred pages get read, and the model then answers from what
 * those pages actually say — or says NOT FOUND, which is the correct outcome
 * when the ranking guessed wrong.
 */
export function rankCorpus(question: string, corpus: CorpusPage[], topN = 3): CorpusPage[] {
  const terms = keywords(question);
  if (terms.length === 0) return [];

  const scored = corpus.map((page) => {
    const haystack = `${safePath(page.url)} ${page.anchors.join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) continue;
      // A term in the URL path is a stronger signal than one in link text: a
      // path is what the site called the page, an anchor is one way somebody
      // referred to it.
      score += safePath(page.url).toLowerCase().includes(term) ? 3 : 1;
    }
    return { page, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url))
    .slice(0, topN)
    .map((s) => s.page);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface CategoryCoverage {
  category: string;
  total: number;
  answered: number;
  notFound: number;
  /** Of the not-founds, how many were us being refused rather than the client
   *  being silent. A category that is entirely blocked has been measured, not
   *  researched. */
  blocked: number;
  pending: number;
  approved: number;
}

/**
 * Where this client is understood and where it is not.
 *
 * The point of the whole phase, made countable. A category that is entirely
 * `notFound` is not a failure of the research — it is a finding about the
 * client, and one worth acting on: either they genuinely do not publish it, or
 * the pages that would answer it are behind the block that forced the manual
 * paste route to exist.
 */
export function coverage(
  questions: Pick<InterviewQuestion, 'category' | 'status' | 'review' | 'notFoundReason'>[],
): CategoryCoverage[] {
  const byCategory = new Map<string, CategoryCoverage>();

  for (const q of questions) {
    const row = byCategory.get(q.category) ?? {
      category: q.category,
      total: 0,
      answered: 0,
      notFound: 0,
      blocked: 0,
      pending: 0,
      approved: 0,
    };
    row.total++;
    if (q.status === 'answered') row.answered++;
    if (q.status === 'not-found') {
      row.notFound++;
      if (q.notFoundReason === 'blocked') row.blocked++;
    }
    if (q.status === 'pending') row.pending++;
    if (q.review === 'approved') row.approved++;
    byCategory.set(q.category, row);
  }

  // Weakest first: the list is a to-do, so the category that needs attention
  // belongs at the top rather than wherever the alphabet puts it.
  return [...byCategory.values()].sort(
    (a, b) => a.approved / (a.total || 1) - b.approved / (b.total || 1) || a.category.localeCompare(b.category),
  );
}

/** Questions to research next: pending, highest priority, stable order. */
export function nextToResearch(questions: InterviewQuestion[], limit: number): InterviewQuestion[] {
  return questions
    .filter((q) => q.status === 'pending')
    .sort((a, b) => b.priority - a.priority || a.category.localeCompare(b.category) || a.questionId.localeCompare(b.questionId))
    .slice(0, limit);
}
