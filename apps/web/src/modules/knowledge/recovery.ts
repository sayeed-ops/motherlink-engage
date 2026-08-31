// When the reply engine finds a conversation and the library has nothing.
//
// PURE — it decides what to ask, not how to answer it.
//
// ════════════════════════════════════════════════════════════════════════════
// "NO MATCH" IS A QUESTION, NOT A VERDICT
//
// The retrieval step can only answer "does the library contain something for
// this". It is routinely asked to stand in for a different question — "does the
// CLIENT have something for this" — and those are not the same, because the
// library is a cache of what somebody has got round to researching.
//
// Treating them as the same has a specific failure: the first time a thread
// comes up about a feature nobody wrote a question for, the system concludes the
// client is irrelevant, writes a gap record, and never revisits it. The client
// may have had a whole help centre section about it.
//
// So an unmatched opportunity becomes a research question. It goes into the same
// queue, is researched against the same approved sources, needs the same
// approval, and when it lands the opportunity can be retried. The library
// behaves like memory that can be extended, rather than like the complete truth
// about the client.
// ════════════════════════════════════════════════════════════════════════════

import { keywords } from './interview';

export interface UnmatchedOpportunity {
  /** Where it was seen, for the audit trail back to the thread. */
  threadRef: string;
  /** What the classifier decided the person is asking about. */
  concepts: string[];
  /** The thread's own words. */
  text: string;
  /** Intent label, when one was produced. Shapes the question's phrasing. */
  intent?: string;
}

export interface RecoveryQuestion {
  category: string;
  question: string;
  rationale: string;
  priority: number;
}

/**
 * Turn an unmatched thread into a research task.
 *
 * PHRASED AS A RESEARCH QUESTION ABOUT THE CLIENT, never as the thread's own
 * question. "Why did my cashout vanish" is a question for the forum; what the
 * queue needs is "what does the client document about cashout availability",
 * because that is what somebody can go and look up.
 *
 * Priority 5: a question raised by a live conversation is worth more than any
 * question generated in the abstract, because we already know somebody asked it.
 */
export function questionFromOpportunity(op: UnmatchedOpportunity): RecoveryQuestion | null {
  const subject = subjectOf(op);
  if (!subject) return null;

  return {
    category: op.intent ? capitalise(op.intent) : 'From live threads',
    question: `What does the client publish about ${subject} — features, documentation, tools or data we could point to?`,
    rationale: `A thread asked about this and the library had nothing. Seen at ${op.threadRef}.`,
    priority: 5,
  };
}

/** The concepts, if the classifier gave any; otherwise the thread's own most
 *  substantial words. A question built from nothing is not worth filing. */
function subjectOf(op: UnmatchedOpportunity): string {
  const fromConcepts = op.concepts.map((c) => c.trim()).filter(Boolean).slice(0, 3);
  if (fromConcepts.length) return fromConcepts.join(', ');

  const terms = keywords(op.text).slice(0, 4);
  return terms.length >= 2 ? terms.join(' ') : '';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Should we bother asking?
 *
 * Not every unmatched thread deserves a research task — most threads on a forum
 * are genuinely nothing to do with the client, and filing a question for each
 * would bury the queue in noise within a day. Ask when the thread is ABOUT the
 * client's field, which is what a matched intent plus real concepts indicates.
 */
export function worthRecovering(op: UnmatchedOpportunity, alreadyAsked: string[]): boolean {
  if (op.concepts.length === 0) return false;

  const subject = subjectOf(op).toLowerCase();
  if (!subject) return false;

  // Asking the same thing every time the topic comes up would produce a hundred
  // identical questions in a week. One is enough; it is in the queue.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return !alreadyAsked.some((q) => norm(q).includes(norm(subject)));
}
