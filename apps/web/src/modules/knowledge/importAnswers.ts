// Importing research that was done somewhere else.
//
// PURE. A parsed file in, a PLAN out. Nothing here writes anything: the plan is
// shown to a person, they change the rows they disagree with, and only then does
// the route apply it. That order is the whole design — see below.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THE OLD IMPORT DROPPED ANSWERS, AND WHY THIS ONE MAY KEEP THEM
//
// `interview/export` imports QUESTIONS ONLY, deliberately, and its reason is
// still right: a claim that arrived in a file would be indistinguishable from
// one this server verified, so importing claims would put unchecked assertions
// into the ledger wearing the evidence of checked ones.
//
// That argument is about CLAIMS — an assertion bound to a verbatim quote from a
// page we read. It is not an argument about everything else a research pass
// produces. "We looked, and Northwind does not publish a KYC processing time" is a
// finding about the client, it took work, and throwing it away because it is not
// quote-backed is not caution — it is losing information.
//
// So this importer keeps the finding and refuses the evidence:
//
//   kept      the answer prose, status, the URLs that were read, the note, the
//             category, rationale and priority
//   NEVER     claims. An imported answer has `claims: []` and is marked
//             `answerSource: 'imported'`, so approving it writes an asset with
//             `textSource: 'unverified'` and nothing citable.
//
// The library already has the vocabulary for exactly this distinction: an asset
// with no live claim is USABLE and not CITABLE. It can shape what a reply says;
// it cannot be the source behind a fact the reply states. That is precisely the
// standing an imported answer deserves, and it was built in phase 1 for a
// different reason.
// ════════════════════════════════════════════════════════════════════════════

import type {
  InterviewQuestion,
  NotFoundReason,
  QuestionStatus,
  ResearchAnswer,
} from './interview';

// ---------------------------------------------------------------------------
// Reading a file that was not necessarily written by us
// ---------------------------------------------------------------------------

export interface ImportedRecord {
  /** Normalised match key. Same rule the questions-only import uses. */
  key: string;
  question: string;
  category: string;
  rationale: string;
  priority: number;
  status: QuestionStatus;
  /** What the answer SAYS. The one field every shape of file has. */
  answerText: string;
  /** A full structured answer, when the file was one of our own exports. */
  structured: ResearchAnswer | null;
  sourcesRead: string[];
  notFoundReason: NotFoundReason | null;
  /** The runner's own words, plus any prose that arrived where the enum was
   *  expected. Always shown on the row. */
  note: string;
}

const NOT_FOUND_REASONS: NotFoundReason[] = ['no-candidate', 'blocked', 'not-covered', 'bad-response'];

/**
 * Status, however the file spelled it.
 *
 * A file produced outside this system says `found`; ours says `answered`. Both
 * mean the same thing and neither is wrong, so the synonym is accepted rather
 * than the record rejected. Anything unrecognised becomes `pending` — an
 * unknown status must not silently become "answered".
 */
export function readStatus(raw: unknown, hasAnswerText: boolean): QuestionStatus {
  const s = String(raw ?? '').toLowerCase().replace(/[_\s]/g, '-');
  if (s === 'answered' || s === 'found' || s === 'complete' || s === 'completed') return 'answered';
  if (s === 'not-found' || s === 'notfound' || s === 'missing' || s === 'unanswered') return 'not-found';
  if (s === 'skipped' || s === 'skip') return 'skipped';
  if (s === 'pending') return 'pending';
  return hasAnswerText ? 'answered' : 'pending';
}

/**
 * The answer text, whichever shape it arrived in.
 *
 * Ours is a structured object whose `shortAnswer` is the prose; a hand-made file
 * is likely to have the prose alone. Both are read.
 */
function readAnswer(raw: unknown): { text: string; structured: ResearchAnswer | null } {
  if (typeof raw === 'string') return { text: raw.trim(), structured: null };
  if (raw && typeof raw === 'object') {
    const obj = raw as Partial<ResearchAnswer>;
    const text = typeof obj.shortAnswer === 'string' ? obj.shortAnswer.trim() : '';
    // Only treat it as structured when it carries the parts an asset needs.
    const structured = typeof obj.assetTitle === 'string' && obj.assetTitle.trim() ? (raw as ResearchAnswer) : null;
    return { text, structured };
  }
  return { text: '', structured: null };
}

/**
 * `notFoundReason`, which in a foreign file is usually a SENTENCE.
 *
 * ⚠️ THE CAUSE IS NOT GUESSED FROM PROSE. Our four causes are different findings
 * with different consequences — `blocked` is actionable work, `not-covered` is a
 * fact about the client — and deciding between them by keyword-matching someone
 * else's sentence would manufacture exactly the confident-but-wrong signal that
 * the four-cause split was introduced to remove.
 *
 * So an exact enum value is kept, and anything else is returned as NOTE TEXT.
 * The row then reads "not found — <their sentence>", which is the truth, instead
 * of a category nobody assigned.
 */
export function readNotFoundReason(raw: unknown): { reason: NotFoundReason | null; note: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { reason: null, note: '' };
  const normalised = s.toLowerCase().replace(/[_\s]/g, '-');
  if ((NOT_FOUND_REASONS as string[]).includes(normalised)) {
    return { reason: normalised as NotFoundReason, note: '' };
  }
  return { reason: null, note: s };
}

/**
 * The match key. Shared with the questions-only import — it imports this
 * function rather than keeping a second copy — so the two importers can never
 * disagree about whether a question is already present.
 *
 * Punctuation becomes a SPACE rather than vanishing. Deleting it silently
 * joined words: "cash-out" keyed as `cashout` while "cash out" keyed as
 * `cash out`, so the same question written two normal ways did not match itself.
 *
 * ⚠️ EXACT MATCH ONLY, AND PARAPHRASES ARE NOT COLLAPSED. "What are the rules
 * for void bets…" and "What does Northwind document about the rules for void
 * bets…" are two rows here, and that is deliberate: deciding two differently
 * worded questions are the same question is a judgement, and this is the wrong
 * place to make it silently. The judgement happens later and with more to go
 * on — `dedupeAgainstLibrary` compares ANSWERS, where a shared source URL is
 * near-proof that two questions landed on the same page.
 */
export function questionKey(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()).slice(0, max)
    : [];

/** One record from the file, normalised. Null when there is no question in it. */
export function readRecord(raw: unknown): ImportedRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const question = str(r.question, 400);
  if (question.length < 6) return null;

  const { text, structured } = readAnswer(r.answer);
  const { reason, note } = readNotFoundReason(r.notFoundReason);
  const ownNote = str(r.note, 600);

  return {
    key: questionKey(question),
    question,
    category: str(r.category, 80) || 'Imported',
    rationale: str(r.rationale, 300),
    priority: Math.max(1, Math.min(5, Math.round(Number(r.priority) || 3))),
    status: readStatus(r.status, text.length > 0),
    answerText: text,
    structured,
    sourcesRead: strings(r.sourcesRead ?? (structured?.sourceUrls as unknown), 25),
    notFoundReason: reason,
    // Their note first, then the sentence that arrived where the enum belonged.
    note: [ownNote, note].filter(Boolean).join(' — '),
  };
}

export function readImportFile(raw: unknown): ImportedRecord[] {
  const questions = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map(readRecord).filter((r): r is ImportedRecord => r !== null);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type ImportDecision =
  /** Not here yet, and the file has no answer for it. */
  | 'add'
  /** Not here yet, and the file answers it. */
  | 'add-answered'
  /** Here, unanswered. Take the imported answer. */
  | 'fill'
  /** Here WITH an answer. Overwrite it with the imported one. */
  | 'replace'
  /** Here with an answer. Keep ours. */
  | 'keep'
  /** Nothing to do. */
  | 'skip';

export const DECISION_LABEL: Record<ImportDecision, string> = {
  add: 'Add question',
  'add-answered': 'Add with answer',
  fill: 'Take answer',
  replace: 'Replace ours',
  keep: 'Keep ours',
  skip: 'Skip',
};

export interface ExistingSummary {
  questionId: string;
  status: QuestionStatus;
  review: InterviewQuestion['review'];
  answerText: string;
  sourcesRead: string[];
  /** How many live claims the current answer carries. The number that decides
   *  whether replacing it loses verified evidence. */
  claimCount: number;
  answerSource: 'researched' | 'imported';
}

export interface ImportRow {
  key: string;
  question: string;
  incoming: ImportedRecord;
  existing: ExistingSummary | null;
  decision: ImportDecision;
  /** Every decision a person may pick for this row. */
  choices: ImportDecision[];
  /** Why the plan proposes what it proposes. Shown on the row. */
  reason: string;
  /** Replacing this would discard quote-checked claims. */
  losesEvidence: boolean;
}

export interface ImportPlan {
  rows: ImportRow[];
  counts: Record<ImportDecision, number>;
  /** Records in the file that carried no usable question. */
  unreadable: number;
}

const hasFinding = (r: ImportedRecord): boolean =>
  r.answerText.length > 0 || r.status === 'not-found' || r.status === 'answered';

/**
 * What importing this file would do, row by row.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE DEFAULT NEVER OVERWRITES AN EXISTING ANSWER
 *
 * A conflict defaults to `keep`, and the row shows both texts so a person can
 * choose. That is not indecision: our answer was researched against pages this
 * server read, with quotes checked, and the imported one was not. Replacing it
 * silently would be a downgrade dressed as an import — and `losesEvidence` marks
 * the rows where it would also destroy claims that are in the ledger.
 *
 * Everything that ADDS information — a question we do not have, an answer where
 * we have none — defaults to yes, because that is the whole point of the file.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function planAnswerImport(
  existing: readonly InterviewQuestion[],
  incoming: readonly ImportedRecord[],
): ImportPlan {
  const byKey = new Map(existing.map((q) => [questionKey(q.question), q]));
  const seen = new Set<string>();
  const rows: ImportRow[] = [];

  for (const record of incoming) {
    // A file can ask the same thing twice — the questionnaire generator itself
    // produces near-duplicates across categories. The first one wins; the rest
    // are shown as skipped rather than quietly dropped.
    if (seen.has(record.key)) {
      rows.push({
        key: record.key,
        question: record.question,
        incoming: record,
        existing: null,
        decision: 'skip',
        choices: ['skip'],
        reason: 'The same question appears earlier in this file.',
        losesEvidence: false,
      });
      continue;
    }
    seen.add(record.key);

    const match = byKey.get(record.key);
    rows.push(match ? againstExisting(record, match) : asNew(record));
  }

  const counts = rows.reduce(
    (acc, row) => ({ ...acc, [row.decision]: acc[row.decision] + 1 }),
    { add: 0, 'add-answered': 0, fill: 0, replace: 0, keep: 0, skip: 0 } as Record<ImportDecision, number>,
  );

  return { rows, counts, unreadable: 0 };
}

function asNew(record: ImportedRecord): ImportRow {
  const answered = hasFinding(record);
  return {
    key: record.key,
    question: record.question,
    incoming: record,
    existing: null,
    decision: answered ? 'add-answered' : 'add',
    choices: answered ? ['add-answered', 'add', 'skip'] : ['add', 'skip'],
    reason: answered
      ? 'New question, and the file answers it.'
      : 'New question, with no answer in the file.',
    losesEvidence: false,
  };
}

function againstExisting(record: ImportedRecord, match: InterviewQuestion): ImportRow {
  const existing: ExistingSummary = {
    questionId: match.questionId,
    status: match.status,
    review: match.review,
    answerText: match.answer?.shortAnswer ?? '',
    sourcesRead: match.sourcesRead ?? [],
    claimCount: match.answer?.claims.length ?? 0,
    answerSource: match.answer?.answerSource ?? 'researched',
  };

  const base = { key: record.key, question: record.question, incoming: record, existing };

  if (!hasFinding(record)) {
    return {
      ...base,
      decision: 'skip',
      choices: ['skip'],
      reason: 'Already here, and the file adds nothing to it.',
      losesEvidence: false,
    };
  }

  const ours = existing.answerText.trim();
  const theirs = record.answerText.trim();

  if (ours && theirs && ours === theirs && sameSources(existing.sourcesRead, record.sourcesRead)) {
    return {
      ...base,
      decision: 'skip',
      choices: ['skip'],
      reason: 'Identical to the answer already here.',
      losesEvidence: false,
    };
  }

  if (!ours && match.status !== 'answered') {
    return {
      ...base,
      decision: 'fill',
      choices: ['fill', 'skip'],
      reason: 'Here but unanswered — the file answers it.',
      losesEvidence: false,
    };
  }

  const losesEvidence = existing.claimCount > 0;
  return {
    ...base,
    decision: 'keep',
    choices: ['keep', 'replace', 'skip'],
    reason: losesEvidence
      ? `Both answered, and ours carries ${existing.claimCount} quote-checked claim${existing.claimCount === 1 ? '' : 's'}. Replacing it discards them.`
      : 'Both answered, and the answers differ. Compare before replacing.',
    losesEvidence,
  };
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort().join('|');
  const y = [...b].sort().join('|');
  return x === y;
}

// ---------------------------------------------------------------------------
// Turning an imported record into an answer
// ---------------------------------------------------------------------------

export interface ImportActor {
  uid: string;
  name: string;
  fileLabel: string;
  nowMs: number;
}

/**
 * The `ResearchAnswer` an imported record becomes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS FILLED IN, AND WHAT IS LEFT EMPTY ON PURPOSE
 *
 * `claims: []` — always, even when the file has a `claims` array. A claim is an
 * assertion bound to a quote this server checked against a page it read. Nothing
 * in a file can meet that definition, and a claim that arrived by import would
 * be indistinguishable in the ledger from one that was verified.
 *
 * `confidence: 0` — not measured. A number we did not compute must not be
 * invented, and 0 sorts it below everything that was actually scored.
 *
 * `conversationTriggers` — SHORT PHRASES FROM the question, never the question
 * itself. An asset with no triggers can never be retrieved, so this cannot be
 * left empty; but retrieval requires every token of a trigger to be present, so
 * a trigger that is a whole sentence can never fire either.
 *
 * ⚠️ THE FIRST VERSION STORED THE QUESTION WHOLE, and every imported asset was
 * therefore unretrievable. A live run found it the only way it could be found:
 * a forum post asking about deposit bonuses matched nothing in a library holding
 * several assets about deposit bonuses. See `triggerPhrases`.
 *
 * `problemsSolved` / `notRelevantWhen` — EMPTY. A model proposes these from the
 * source text and a person confirms them; neither happened here. `notRelevantWhen`
 * in particular is the only field that can veto a match, and inventing one would
 * be worse than having none.
 *
 * `assetTitle` — the question, trimmed. A placeholder a person edits in review,
 * not a claim to have named the thing well.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function importedAnswer(record: ImportedRecord, actor: ImportActor): ResearchAnswer {
  const structured = record.structured;

  return {
    shortAnswer: record.answerText,
    assetTitle: structured?.assetTitle ?? titleFrom(record.question),
    assetKind: structured?.assetKind ?? 'help',
    problemsSolved: structured?.problemsSolved ?? [],
    conversationTriggers: structured?.conversationTriggers?.length
      ? structured.conversationTriggers
      : triggerPhrases(record.question),
    notRelevantWhen: structured?.notRelevantWhen ?? [],
    // Never from the file. See the header.
    claims: [],
    sourceUrls: record.sourcesRead,
    // A person supplied this text by hand, in a file. That is what `operator`
    // means; `official` would claim we read the client's page ourselves.
    sourceKind: 'operator',
    // Whether naming the client helps is a judgement about a reply, made by
    // whoever read the source. Nobody made it here, so the answer is no until a
    // person says otherwise in review.
    brandAttributionHelps: false,
    complianceCaveats: structured?.complianceCaveats ?? [],
    confidence: 0,
    model: '',
    promptVersion: 'imported',
    researchedAt: new Date(actor.nowMs),
    answerSource: 'imported',
    importedBy: actor.uid,
    importedByName: actor.name,
    importedAt: new Date(actor.nowMs),
    importedFrom: actor.fileLabel,
  };
}

/**
 * Words that carry no subject — question scaffolding and forum filler.
 *
 * Deliberately not a general stop-word list: this exists to strip the shape of
 * an interview question ("what does the client document about…") so that what
 * remains is what the question is ABOUT.
 */
const SCAFFOLDING = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'anyone', 'are', 'as', 'at', 'be', 'been', 'being',
  'by', 'can', 'client', 'do', 'does', 'doing', 'document', 'documents', 'for', 'from', 'get',
  'give', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'know', 'let',
  'like', 'long', 'many', 'may', 'me', 'much', 'my', 'need', 'of', 'on', 'or', 'our', 'out',
  'over', 'say', 'says', 'should', 'so', 'some', 'such', 'take', 'tell', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'up', 'use', 'user',
  'users', 'want', 'was', 'we', 'well', 'what', 'when', 'where', 'whether', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Short trigger phrases from one question.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ADJACENT PAIRS, BECAUSE A PAIR IS SPECIFIC AND A WORD IS NOT
 *
 * Retrieval requires every token of a trigger to appear in the thread. A single
 * word — "bonus", "account" — therefore fires on almost any post and drags the
 * whole library into every prompt. A whole sentence fires on none.
 *
 * A pair of adjacent content words is the level that behaves: "deposit bonus",
 * "wagering requirement", "cash out" are specific enough to mean something and
 * short enough to actually occur in forum prose. The pairs come from the
 * question's own word order, so they are phrases somebody wrote rather than
 * combinations we invented.
 *
 * The client's own name is dropped: a trigger containing it would only fire on
 * posts that already name them, which is the one case that needs no help.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function triggerPhrases(question: string, clientName = ''): string[] {
  const client = new Set(
    clientName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SCAFFOLDING.has(w) && !client.has(w));

  const pairs: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const pair = `${words[i]} ${words[i + 1]}`;
    if (!pairs.includes(pair)) pairs.push(pair);
  }

  // A question with one content word in it still deserves a trigger.
  if (pairs.length === 0 && words.length === 1) return words;

  // Eight is enough to cover a question from several angles without turning one
  // asset into a net that catches the whole board.
  return pairs.slice(0, 8);
}

function titleFrom(question: string): string {
  const cleaned = question
    .replace(/^(what|how|when|where|why|which|does|do|can|is|are|has|have)\b\s*/i, '')
    .replace(/\?+\s*$/, '')
    .trim();
  const title = cleaned || question;
  return (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 90);
}

/** Which decisions actually write something. The route applies only these. */
export const WRITING_DECISIONS: readonly ImportDecision[] = ['add', 'add-answered', 'fill', 'replace'] as const;

export function isWriting(decision: ImportDecision): boolean {
  return (WRITING_DECISIONS as readonly string[]).includes(decision);
}
