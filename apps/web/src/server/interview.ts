import 'server-only';

// The deep client interview — persistence and the research runner.
//
// Everything that decides anything is pure and lives in
// modules/knowledge/interview.ts and interviewPrompts.ts. This file fetches
// pages, calls models and writes documents.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT "RESEARCH" CAN ACTUALLY REACH, STATED PLAINLY
//
// There is no web search in this stack. Nothing here can ask a search engine
// "what does this company publish about withdrawals" — it can only read URLs it
// already knows, which means the client's own approved domains as enumerated by
// discovery, plus pages an operator points at or pastes by hand.
//
// That is a real limit and it is deliberately visible rather than papered over:
// a question whose answer lives on a page nobody has enumerated comes back
// NOT FOUND, which is honest, instead of being answered from the model's priors
// about companies of this kind, which would be worthless and confident.
//
// THE SEAM FOR FIXING IT is `SourceFinder` below. Adding a search provider later
// is one implementation of that interface, not a rewrite — the same shape the
// ForumReader port uses for Reddit and Covers.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue, type DocumentData, type Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { fetchPage, KnowledgeFetchError } from './knowledge';
import { listDiscoveries } from './discovery';
import {
  importedAnswer,
  isWriting,
  type ImportActor,
  type ImportDecision,
  type ImportRow,
} from '@/modules/knowledge/importAnswers';
import { normaliseForMatch } from '@/modules/knowledge/extract';
import { forPrompt } from '@/modules/knowledge/extract';
import {
  rankCorpus,
  type CorpusPage,
  type Interview,
  type InterviewQuestion,
  type NotFoundReason,
  type QuestionOrigin,
  type QuestionStatus,
  type ResearchAnswer,
  type ReviewState,
} from '@/modules/knowledge/interview';
import {
  buildResearchPrompt,
  parseResearch,
  RESEARCH_PROMPT_VERSION,
  type GeneratedQuestion,
  type ResearchSource,
} from '@/modules/knowledge/interviewPrompts';

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const interviewRef = (projectId: string) =>
  adminDb().collection('projects').doc(projectId).collection('interview').doc('current');

const questionsRef = (projectId: string) => interviewRef(projectId).collection('questions');

const ts = (v: unknown): Date | null =>
  v && typeof (v as Timestamp).toDate === 'function' ? (v as Timestamp).toDate() : null;

// ---------------------------------------------------------------------------
// The interview document
// ---------------------------------------------------------------------------

export async function getInterview(projectId: string): Promise<Interview | null> {
  const doc = await interviewRef(projectId).get();
  if (!doc.exists) return null;
  const d = doc.data() as DocumentData;
  return {
    projectId,
    clientName: String(d.clientName ?? ''),
    domains: Array.isArray(d.domains) ? d.domains : [],
    industry: String(d.industry ?? ''),
    categories: Array.isArray(d.categories) ? d.categories : [],
    status: d.status ?? 'draft',
    questionCount: Number(d.questionCount ?? 0),
    createdBy: String(d.createdBy ?? ''),
    createdByName: String(d.createdByName ?? ''),
    createdAt: ts(d.createdAt) ?? new Date(0),
    updatedAt: ts(d.updatedAt) ?? new Date(0),
  };
}

export async function saveInterview(
  projectId: string,
  input: { clientName: string; domains: string[]; industry: string; categories: string[] },
  actor: { uid: string; name: string },
): Promise<void> {
  await interviewRef(projectId).set(
    {
      projectId,
      clientName: input.clientName,
      domains: input.domains,
      industry: input.industry,
      categories: input.categories,
      status: 'draft',
      createdBy: actor.uid,
      createdByName: actor.name,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function setInterviewCounts(projectId: string, questionCount: number, categories?: string[]): Promise<void> {
  await interviewRef(projectId).set(
    {
      questionCount,
      ...(categories ? { categories } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function toQuestion(id: string, d: DocumentData): InterviewQuestion {
  return {
    questionId: id,
    projectId: String(d.projectId ?? ''),
    category: String(d.category ?? 'General'),
    question: String(d.question ?? ''),
    rationale: String(d.rationale ?? ''),
    priority: Number(d.priority ?? 3),
    origin: (d.origin ?? 'generated') as QuestionOrigin,
    status: (d.status ?? 'pending') as QuestionStatus,
    review: (d.review ?? 'none') as ReviewState,
    answer: d.answer ? toAnswer(d.answer as DocumentData) : null,
    notFoundReason: (d.notFoundReason ?? null) as NotFoundReason | null,
    note: String(d.note ?? ''),
    sourcesRead: Array.isArray(d.sourcesRead) ? d.sourcesRead : [],
    dedupe: d.dedupe ?? null,
    assetId: d.assetId ?? null,
    provokedBy: d.provokedBy ?? null,
    createdAt: ts(d.createdAt) ?? new Date(0),
    updatedAt: ts(d.updatedAt) ?? new Date(0),
  };
}

function toAnswer(d: DocumentData): ResearchAnswer {
  return {
    shortAnswer: String(d.shortAnswer ?? ''),
    assetTitle: String(d.assetTitle ?? ''),
    assetKind: d.assetKind ?? 'guide',
    problemsSolved: Array.isArray(d.problemsSolved) ? d.problemsSolved : [],
    conversationTriggers: Array.isArray(d.conversationTriggers) ? d.conversationTriggers : [],
    notRelevantWhen: Array.isArray(d.notRelevantWhen) ? d.notRelevantWhen : [],
    claims: Array.isArray(d.claims) ? d.claims : [],
    sourceUrls: Array.isArray(d.sourceUrls) ? d.sourceUrls : [],
    sourceKind: d.sourceKind ?? 'official',
    brandAttributionHelps: d.brandAttributionHelps === true,
    complianceCaveats: Array.isArray(d.complianceCaveats) ? d.complianceCaveats : [],
    confidence: Number(d.confidence ?? 0),
    model: String(d.model ?? ''),
    promptVersion: String(d.promptVersion ?? ''),
    researchedAt: ts(d.researchedAt) ?? new Date(0),
  };
}

export async function listQuestions(projectId: string): Promise<InterviewQuestion[]> {
  const snap = await questionsRef(projectId).get();
  return snap.docs.map((d) => toQuestion(d.id, d.data()));
}

export async function getQuestion(projectId: string, questionId: string): Promise<InterviewQuestion | null> {
  const doc = await questionsRef(projectId).doc(questionId).get();
  return doc.exists ? toQuestion(doc.id, doc.data() as DocumentData) : null;
}

/** Add questions. Firestore batches cap at 500 writes, and a hundred questions
 *  is comfortably inside one commit. */
export async function addQuestions(
  projectId: string,
  questions: GeneratedQuestion[],
  origin: QuestionOrigin,
  provokedBy: string | null = null,
): Promise<number> {
  if (questions.length === 0) return 0;
  const batch = adminDb().batch();

  for (const q of questions) {
    const ref = questionsRef(projectId).doc();
    batch.set(ref, {
      questionId: ref.id,
      projectId,
      category: q.category,
      question: q.question,
      rationale: q.rationale,
      priority: q.priority,
      origin,
      status: 'pending',
      review: 'none',
      answer: null,
      dedupe: null,
      assetId: null,
      provokedBy,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return questions.length;
}

/**
 * Apply an answered-knowledge import.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE PLAN IS RECOMPUTED HERE. THE BROWSER SENDS CHOICES, NOT INSTRUCTIONS.
 *
 * The caller says which decision it wants per question — never what to write and
 * never which document to write it to. This runs against a freshly computed
 * plan and accepts a decision only if that row OFFERS it, so a caller cannot ask
 * to `replace` a row the plan calls a `fill`, and cannot name a questionId at
 * all.
 *
 * It also closes the window between planning and applying: if somebody
 * researched one of these questions in the meantime, its row is no longer a
 * `fill`, and the imported answer will not quietly overwrite the new one.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function applyAnswerImport(
  projectId: string,
  rows: readonly ImportRow[],
  chosen: Record<string, ImportDecision>,
  actor: ImportActor,
): Promise<{ added: number; answered: number; replaced: number; skipped: number }> {
  const result = { added: 0, answered: 0, replaced: 0, skipped: 0 };
  const batch = adminDb().batch();

  for (const row of rows) {
    const decision = chosen[row.key] ?? row.decision;

    // Not on offer for this row — including anything the caller invented.
    if (!row.choices.includes(decision) || !isWriting(decision)) {
      result.skipped++;
      continue;
    }

    const record = row.incoming;
    const carriesAnswer = decision !== 'add';
    const answer = carriesAnswer && record.answerText ? importedAnswer(record, actor) : null;
    const status: QuestionStatus = carriesAnswer ? record.status : 'pending';
    // An imported answer is a PROPOSAL. It joins the review queue exactly as a
    // researched one does, and nothing reaches the library until a person
    // presses approve.
    const review: ReviewState = answer ? 'pending' : 'none';

    if (decision === 'add' || decision === 'add-answered') {
      const ref = questionsRef(projectId).doc();
      batch.set(ref, {
        questionId: ref.id,
        projectId,
        category: record.category,
        question: record.question,
        rationale: record.rationale,
        priority: record.priority,
        // `operator` — a person brought this in. NOT `generated`: regenerating
        // the questionnaire deletes the generated set, and imported work must
        // not disappear with it.
        origin: 'operator' as QuestionOrigin,
        status,
        review,
        answer,
        notFoundReason: record.notFoundReason,
        note: record.note,
        sourcesRead: record.sourcesRead,
        dedupe: null,
        assetId: null,
        provokedBy: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      result.added++;
      if (answer || status === 'not-found') result.answered++;
      continue;
    }

    // fill / replace — an existing question, whose id comes from the row this
    // server just computed and never from the request body.
    if (!row.existing) {
      result.skipped++;
      continue;
    }

    batch.set(
      questionsRef(projectId).doc(row.existing.questionId),
      {
        status,
        review,
        answer,
        notFoundReason: record.notFoundReason,
        note: record.note,
        sourcesRead: record.sourcesRead,
        category: record.category,
        // The dedupe verdict belonged to the answer that was here. Left
        // attached to a different answer it would point review at an overlap
        // nobody computed for it.
        dedupe: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (decision === 'replace') result.replaced++;
    else result.answered++;
  }

  await batch.commit();
  return result;
}

/** Remove every generated question. Operator-added, gap and opportunity
 *  questions survive — regenerating the questionnaire must not silently discard
 *  work a person did by hand. */
export async function clearGeneratedQuestions(projectId: string): Promise<number> {
  const snap = await questionsRef(projectId).where('origin', '==', 'generated').get();
  if (snap.empty) return 0;

  let removed = 0;
  // Chunked: a regeneration on a large questionnaire can exceed one batch.
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = adminDb().batch();
    for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
    removed += Math.min(400, snap.docs.length - i);
  }
  return removed;
}

export async function recordAnswer(
  projectId: string,
  questionId: string,
  update: {
    status: QuestionStatus;
    review: ReviewState;
    answer: ResearchAnswer | null;
    dedupe: unknown;
    note?: string;
    notFoundReason?: NotFoundReason | null;
    sourcesRead?: string[];
  },
): Promise<void> {
  await questionsRef(projectId)
    .doc(questionId)
    .set(
      {
        status: update.status,
        review: update.review,
        answer: update.answer,
        dedupe: update.dedupe ?? null,
        note: update.note ?? '',
        notFoundReason: update.notFoundReason ?? null,
        sourcesRead: update.sourcesRead ?? [],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

export async function setQuestionReview(
  projectId: string,
  questionId: string,
  review: ReviewState,
  assetId: string | null,
  actor: { uid: string; name: string },
): Promise<void> {
  await questionsRef(projectId)
    .doc(questionId)
    .set(
      {
        review,
        ...(assetId ? { assetId } : {}),
        reviewedBy: actor.uid,
        reviewedByName: actor.name,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

export async function updateAnswerFields(
  projectId: string,
  questionId: string,
  patch: Partial<ResearchAnswer>,
): Promise<void> {
  const entries = Object.entries(patch).map(([k, v]) => [`answer.${k}`, v]);
  await questionsRef(projectId)
    .doc(questionId)
    .update({ ...Object.fromEntries(entries), updatedAt: FieldValue.serverTimestamp() });
}

export async function deleteQuestion(projectId: string, questionId: string): Promise<void> {
  await questionsRef(projectId).doc(questionId).delete();
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Where research is allowed to look.
 *
 * The seam a search provider would plug into. Today there is exactly one
 * implementation — the pages discovery already enumerated on the approved
 * domains — and it is honest about being a closed corpus rather than the web.
 */
export interface SourceFinder {
  /** Candidate pages for one question, best first. */
  find(question: string, topN: number): Promise<CorpusPage[]>;
}

export async function corpusFromDiscoveries(projectId: string): Promise<CorpusPage[]> {
  const discoveries = await listDiscoveries(projectId);
  return discoveries
    // An ignored page is one a person looked at and did not want. Research must
    // not quietly read it anyway.
    .filter((d) => d.status !== 'ignored')
    .map((d) => ({ url: d.url, anchors: [...d.anchors, d.usefulFor].filter(Boolean) }));
}

export function discoveryFinder(corpus: CorpusPage[]): SourceFinder {
  return {
    async find(question: string, topN: number) {
      return rankCorpus(question, corpus, topN);
    },
  };
}

// ---------------------------------------------------------------------------
// The research runner
// ---------------------------------------------------------------------------

export interface AskModel {
  (input: { system: string; user: string; temperature: number; maxTokens: number; json: boolean }): Promise<{
    content: string;
    model: string;
  }>;
}

export interface ResearchDeps {
  finder: SourceFinder;
  ask: AskModel;
  /** Pages already read this run, so twenty questions about cashout cost one
   *  fetch rather than twenty. The single biggest saving in the whole feature. */
  cache: Map<string, ResearchSource | null>;
  nowMs: number;
}

export interface ResearchOutcome {
  questionId: string;
  status: QuestionStatus;
  /** Which of the four not-found causes, when status is 'not-found'. */
  reason: NotFoundReason | null;
  note: string;
  answer: ResearchAnswer | null;
  sourcesRead: string[];
  /** Claims the model could not support. Recorded, never offered. */
  rejected: number;
}

/** How many pages one question may read. Three is enough to answer most things
 *  and cheap enough to run a hundred times. */
const SOURCES_PER_QUESTION = 3;

/**
 * Research one question against the corpus.
 *
 * Returns `not-found` rather than throwing when there is nothing to read or
 * nothing that answers it. A questionnaire is a survey, and a survey where one
 * unanswerable item aborts the run is useless.
 */
export async function researchQuestion(
  clientName: string,
  question: InterviewQuestion,
  deps: ResearchDeps,
): Promise<ResearchOutcome> {
  const base = { questionId: question.questionId, sourcesRead: [] as string[], rejected: 0 };
  let blockedPages = 0;

  const candidates = await deps.finder.find(question.question, SOURCES_PER_QUESTION);
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'not-found',
      reason: 'no-candidate',
      note: 'No page found so far looked relevant. Discovery may not have reached that part of the site.',
      answer: null,
    };
  }

  const sources: ResearchSource[] = [];
  for (const candidate of candidates) {
    const cached = deps.cache.get(candidate.url);
    if (cached !== undefined) {
      if (cached) sources.push(cached);
      continue;
    }

    try {
      const page = await fetchPage(candidate.url, deps.nowMs);
      const source: ResearchSource = {
        url: page.url,
        title: page.title,
        // Each source is truncated on its own so one long page cannot crowd the
        // other two out of the prompt entirely.
        text: forPrompt(page.text, 6000),
      };
      deps.cache.set(candidate.url, source);
      sources.push(source);
    } catch (err) {
      // A blocked page is not a failed question. It is recorded as unreadable
      // and the remaining sources are still used — and if none are readable the
      // note says so, which is the operator's cue to paste one in.
      deps.cache.set(candidate.url, null);
      if (!(err instanceof KnowledgeFetchError)) throw err;
      blockedPages++;
    }
  }

  if (sources.length === 0) {
    return {
      ...base,
      status: 'not-found',
      reason: 'blocked',
      // Named, because this is the actionable one: the pages exist and a person
      // can read them in a browser. Listing them turns a dead end into a task.
      note: `${blockedPages} relevant page${blockedPages === 1 ? '' : 's'} refused us. Paste one in to answer this by hand.`,
      answer: null,
      sourcesRead: candidates.map((c) => c.url),
    };
  }

  const { system, user } = buildResearchPrompt({
    clientName,
    question: question.question,
    category: question.category,
    sources,
  });

  const result = await deps.ask({ system, user, temperature: 0, maxTokens: 1600, json: true });

  let raw: unknown;
  try {
    raw = JSON.parse(result.content);
  } catch {
    return {
      ...base,
      status: 'not-found',
      reason: 'bad-response',
      note: 'The researcher did not return usable JSON. Re-running this question usually fixes it.',
      answer: null,
      sourcesRead: sources.map((s) => s.url),
    };
  }

  const parsed = parseResearch(raw, sources, normaliseForMatch);

  if (!parsed.found || !parsed.answer) {
    return {
      ...base,
      status: 'not-found',
      reason: 'not-covered',
      // The valuable one: pages WERE read and genuinely do not answer this. That
      // is a finding about the client, not about our access.
      note: parsed.note,
      answer: null,
      sourcesRead: sources.map((s) => s.url),
    };
  }

  return {
    questionId: question.questionId,
    status: 'answered',
    reason: null,
    note: '',
    sourcesRead: sources.map((s) => s.url),
    rejected: parsed.rejected.length,
    answer: {
      ...parsed.answer,
      model: result.model,
      promptVersion: RESEARCH_PROMPT_VERSION,
      researchedAt: new Date(deps.nowMs),
    },
  };
}
