// The record of one attempt to comment — including the attempts that decided
// not to.
//
// PURE. No Firestore, no clock, no 'server-only'. The shape is here rather than
// in server/ because three places must agree on it: the pipeline that writes it,
// the review panel that renders it, and Phase 5's enqueue that reads it.
//
// A DRAFT IS A SCAN, NOT A COMMENT. Most scans produce no comment — skipping is
// the normal outcome by design, and a system that always finds something to say
// posts filler. If only the successes were recorded, the Comment karma tab would
// show an empty list after twenty scans and read as broken, and the operator
// would have no way to tell "the gates are working" from "nothing ran". So every
// scan writes a record, and a skip carries the stage it stopped at and why.
//
// EVERYTHING IS DENORMALISED ONTO THE RECORD. The thread is fetched once, at
// scan time, and the comment is composed against that snapshot; by review time
// the thread has moved on and re-fetching costs another billed call. So the
// record carries what the panel needs to show and what Phase 5 needs to enqueue,
// and nothing downstream has to go back to Crawlzo to render a list.

import type { GapState, PosterWant } from './gaps';
import { DEFAULT_LIMITS, type SelectLimits } from './select';

export type CommentDraftStatus =
  /** Written, waiting for a human. */
  | 'pending'
  /** A human said yes, or the account is on auto. NOT yet enqueued — Phase 5. */
  | 'approved'
  /** A human said no. Terminal, and the reason is training data. */
  | 'rejected'
  /** The scan produced no comment. Terminal, and the common case. */
  | 'skipped'
  /** Enqueued and posted by the agent. Phase 5. */
  | 'posted'
  /** Enqueued and the agent could not post it. Phase 5. */
  | 'failed';

export const COMMENT_DRAFT_STATUSES: readonly CommentDraftStatus[] = [
  'pending',
  'approved',
  'rejected',
  'skipped',
  'posted',
  'failed',
];

/** Where a scan stopped. Ordered as the pipeline runs, so a tally across many
 *  scans reads as a funnel — and a funnel that collapses at one stage is the
 *  fastest way to notice a prompt or a threshold has drifted. */
export type SkipStage =
  /** The account's own rhythm said not now. No model was called. */
  | 'timing'
  /** Nothing came back from the search. */
  | 'search'
  /** Everything failed the free listing screen. */
  | 'screen'
  /** Threads were read, and none was worth entering. */
  | 'judge'
  /** No gap: it has been said, said well, and is at the top. */
  | 'gap'
  /** The model wrote nothing usable. */
  | 'generate'
  /** Everything written failed a gate. */
  | 'gates'
  /** The critic chose none of them. */
  | 'critic'
  /** The chosen one failed a gate on the second pass. */
  | 'final-gates'
  /** The read path or a model was unavailable. Not a judgement — a fault. */
  | 'error';

export const SKIP_STAGES: readonly SkipStage[] = [
  'timing',
  'search',
  'screen',
  'judge',
  'gap',
  'generate',
  'gates',
  'critic',
  'final-gates',
  'error',
];

/** Enough of the thread to render a review without paying for another read. */
export interface DraftThread {
  redditPostId: string;
  subreddit: string;
  title: string;
  permalink: string;
  /** Absolute, because the agent navigates to it and the panel links to it. */
  threadUrl: string;
  postCreatedAtMs: number;
  score: number;
  numComments: number;
  /** When the snapshot was taken. Everything below was true at this moment and
   *  is decreasingly true afterwards. */
  fetchedAtMs: number;
}

export interface DraftGap {
  posterWant: PosterWant;
  gapState: GapState;
  angle: string;
  targetCommentId: string | null;
  confidence: number;
}

export interface DraftRoom {
  sampleSize: number;
  medianWinnerWords: number;
  min: number;
  max: number;
  target: number;
}

/** A candidate that did not make it, kept with its reasons.
 *
 *  Not debris: the fastest way to notice a prompt has drifted is that every
 *  candidate now fails the same gate, and that is invisible if only the winner
 *  is stored. */
export interface DraftRejection {
  text: string;
  failures: { gate: string; code: string; detail: string }[];
}

export interface CommentDraftRecord {
  draftId: string;
  accountId: string;
  status: CommentDraftStatus;

  /** Set on every record, including successful ones — a scan that produced a
   *  comment still records which stage it got to. */
  skipStage: SkipStage | null;
  skipReason: string;

  thread: DraftThread | null;
  /** The comment itself. Null on a skip. */
  text: string | null;
  words: number;
  gap: DraftGap | null;
  room: DraftRoom | null;
  /** Why the critic chose this one — or, on a skip, why it chose none. */
  criticReason: string;
  rejected: DraftRejection[];
  /** What the scan did, stage by stage. The same argument as the approach trace
   *  on a warm-up job: the record above is the decision, this is what actually
   *  happened on the way to it — which community was searched, how many results
   *  survived the free screen, which threads were read and why they were
   *  rejected. On a scan that produced nothing, it is the only account of it. */
  trace: string[];

  /** True when the account's auto-post switch approved it with no human. The
   *  path is the same either way; this records which one was taken. */
  autoApproved: boolean;

  createdAtMs: number;
  reviewedBy: string | null;
  reviewedByName: string;
  reviewedAtMs: number | null;
  /** A human's note on a rejection. This is the training data — "too eager",
   *  "wrong register", "that claim is not defensible" — and it is worth more
   *  than the rejection itself. */
  reviewNote: string;
}

/** Statuses a human may still act on. */
export function isReviewable(status: CommentDraftStatus): boolean {
  return status === 'pending';
}

/** Did this scan produce something postable? */
export function isDraft(record: Pick<CommentDraftRecord, 'text' | 'status'>): boolean {
  return !!record.text && record.status !== 'skipped';
}

export type ReviewAction = 'approve' | 'reject';

/**
 * The one place a status changes.
 *
 * Returns null when the transition is not allowed, and the caller turns that
 * into a refusal rather than a write. This exists because approval is a race:
 * two operators with the panel open, or an operator and the auto switch, and the
 * loser must not overwrite the winner. A conditional write against a status this
 * function has approved is safe; an unconditional `update({status})` is not.
 */
export function nextStatus(current: CommentDraftStatus, action: ReviewAction): CommentDraftStatus | null {
  if (current !== 'pending') return null;
  return action === 'approve' ? 'approved' : 'rejected';
}

/**
 * How much of the thread's useful life is left.
 *
 * A comment is composed against a snapshot and posted minutes or hours later.
 * The same age window that chose the thread governs how long the choice stays
 * true: past `maxAgeHours` the comment ranking has settled, the visible slots
 * are taken, and the gap the comment fills has almost certainly been filled by
 * someone else. Posting it then is not merely late — it is a comment written
 * about a thread that no longer exists in that shape.
 *
 * Computed at READ time rather than written by a sweep: there is no cron here,
 * and a stale flag that depends on something having run is a stale flag.
 */
export function draftFreshness(
  thread: DraftThread | null,
  nowMs: number,
  limits: SelectLimits = DEFAULT_LIMITS,
): { stale: boolean; threadAgeHours: number; snapshotAgeHours: number } {
  if (!thread) return { stale: true, threadAgeHours: 0, snapshotAgeHours: 0 };
  const threadAgeHours = Math.max(0, (nowMs - thread.postCreatedAtMs) / 3_600_000);
  const snapshotAgeHours = Math.max(0, (nowMs - thread.fetchedAtMs) / 3_600_000);
  return {
    stale: threadAgeHours > limits.maxAgeHours,
    threadAgeHours,
    snapshotAgeHours,
  };
}

/** May this record be posted right now?
 *
 *  Separate from the status check because "approved" and "postable" are
 *  different facts: an approved draft goes stale sitting in the queue, and
 *  Phase 5 must re-ask this at enqueue time rather than trusting the approval. */
export function isPostable(
  record: Pick<CommentDraftRecord, 'status' | 'text' | 'thread'>,
  nowMs: number,
  limits: SelectLimits = DEFAULT_LIMITS,
): { ok: boolean; reason: string } {
  if (record.status !== 'approved') return { ok: false, reason: `Status is ${record.status}, not approved.` };
  if (!record.text?.trim()) return { ok: false, reason: 'No comment text on this record.' };
  if (!record.thread) return { ok: false, reason: 'No thread on this record.' };
  const { stale, threadAgeHours } = draftFreshness(record.thread, nowMs, limits);
  if (stale) {
    return {
      ok: false,
      reason: `The thread is ${Math.round(threadAgeHours)}h old; the comment was written for a thread under ${limits.maxAgeHours}h.`,
    };
  }
  return { ok: true, reason: '' };
}

/** Human-readable, and deliberately honest about which of these are FAILURES
 *  (only 'error' is) and which are the system working as designed. */
export const SKIP_STAGE_LABEL: Record<SkipStage, string> = {
  timing: 'Not now — the account’s own rhythm',
  search: 'Nothing recent in those communities',
  screen: 'No post worth reading in full',
  judge: 'No thread worth entering',
  gap: 'Nothing worth adding',
  generate: 'Nothing usable was written',
  gates: 'Everything written failed a check',
  critic: 'None of them was good enough',
  'final-gates': 'The chosen one failed a check',
  error: 'Could not run',
};

/** Normalise a Firestore document into the record shape.
 *
 *  Defensive in the same way the parsers are: a field written by an older
 *  version, or missing entirely, must render rather than throw. The panel is the
 *  only window onto what this system is doing, and a panel that white-screens on
 *  one malformed row hides the other forty. */
export function normalizeDraft(id: string, raw: Record<string, unknown> | null | undefined): CommentDraftRecord | null {
  if (!raw) return null;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

  const status = COMMENT_DRAFT_STATUSES.includes(raw.status as CommentDraftStatus)
    ? (raw.status as CommentDraftStatus)
    : 'skipped';

  return {
    draftId: id,
    accountId: str(raw.accountId),
    status,
    skipStage: SKIP_STAGES.includes(raw.skipStage as SkipStage) ? (raw.skipStage as SkipStage) : null,
    skipReason: str(raw.skipReason),
    thread: (raw.thread as DraftThread) ?? null,
    text: typeof raw.text === 'string' && raw.text.trim() ? raw.text : null,
    words: num(raw.words),
    gap: (raw.gap as DraftGap) ?? null,
    room: (raw.room as DraftRoom) ?? null,
    criticReason: str(raw.criticReason),
    rejected: Array.isArray(raw.rejected) ? (raw.rejected as DraftRejection[]) : [],
    trace: Array.isArray(raw.trace) ? raw.trace.filter((t): t is string => typeof t === 'string') : [],
    autoApproved: raw.autoApproved === true,
    createdAtMs: num(raw.createdAtMs),
    reviewedBy: typeof raw.reviewedBy === 'string' ? raw.reviewedBy : null,
    reviewedByName: str(raw.reviewedByName),
    reviewedAtMs: typeof raw.reviewedAtMs === 'number' ? raw.reviewedAtMs : null,
    reviewNote: str(raw.reviewNote),
  };
}
