// What a discussion is about, and what has already been said in it.
//
// PURE — the prompt is built here and the reply is parsed here; the model call
// itself lives in server/shopifyAnalysis.ts. Same split as everything else:
// what DECIDES anything is testable without a network.
//
// ════════════════════════════════════════════════════════════════════════════
// THIS DOES NOT DECIDE WHETHER TO REPLY, AND IT WRITES NOTHING
//
// It answers: what is being asked, how is the room engaging with it, what has
// already been offered, and what is missing. That is a reading, not a verdict —
// and there is no drafting code in this module, no job kind, and nothing in the
// tree that could post to community.shopify.com.
//
// THE POINT IS AWARENESS, NOT ORIGINALITY. A reply repeating the thread's best
// answer in worse words is the failure to avoid; a reply that agrees with what
// is there and adds one concrete thing is a good outcome. So `whatIsMissing`
// and `alreadySaid` are separate fields — the first is the opening, the second
// is what you would be talking over.
// ════════════════════════════════════════════════════════════════════════════

/** Bumped when the prompt or the shape below changes. Stored beside every
 *  analysis, which is what makes "re-analyse if we want to" a rule rather than
 *  a judgement call: an analysis from an older version is stale by definition,
 *  and Covers' append-only analyses with no version is exactly how a screen
 *  ended up showing whichever opinion it happened to read last. */
export const UNDERSTAND_PROMPT_VERSION = 'shopify-understand-v1';

/** How the room is treating the question. Named states rather than a score,
 *  because "engagement 0.6" is not something anybody can act on. */
export const ENGAGEMENT_SHAPES = [
  'unanswered', // asked, nobody has replied
  'answered-well', // solved, and the thread knows it
  'competing-answers', // several views, no agreement
  'thin-answers', // replies exist but none of them actually answer it
  'discussion', // not a question — people comparing notes
  'off-topic', // drifted, or never was about the subject
] as const;
export type EngagementShape = (typeof ENGAGEMENT_SHAPES)[number];

export const ENGAGEMENT_LABEL: Record<EngagementShape, string> = {
  unanswered: 'Asked, nobody answered',
  'answered-well': 'Answered, and the thread agrees',
  'competing-answers': 'Several answers, no agreement',
  'thin-answers': 'Replies that do not answer it',
  discussion: 'People comparing notes',
  'off-topic': 'Drifted off the subject',
};

/** One thing somebody put forward as an answer. */
export interface OfferedSolution {
  /** The approach in a few words — "add structured data", not a paraphrase of
   *  the whole post. */
  approach: string;
  /** Who said it, so a reviewer can go and read it. */
  byUsername: string;
  postNumber: number;
  /** Did the room endorse it — accepted answer, or clearly agreed with. */
  endorsed: boolean;
}

export interface Understanding {
  /** The question or concern in the ASKER'S terms, one sentence. */
  concern: string;
  /** Who is asking, as far as the thread reveals — "a new merchant", "an agency
   *  running client stores". Shapes register more than content. */
  askerContext: string;
  engagement: EngagementShape;
  /** What has already been offered. Empty when nobody has answered. */
  offered: OfferedSolution[];
  /** What nobody has said that would genuinely help. THE FIELD THAT MATTERS:
   *  it is the difference between adding something and restating the thread. */
  whatIsMissing: string;
  /** The points repeated often enough that saying them again adds nothing. */
  alreadySaid: string[];
  /** Would a reply here be welcome, and why. Not a score and not permission —
   *  a sentence a person can disagree with. */
  worthJoining: string;
  /** 0-1, the model's own confidence. NOT a measurement; used for ordering and
   *  a floor, never shown as a probability. */
  confidence: number;
}

/** What a discussion yields when the model could not be believed. Deliberately
 *  inert: an unreadable answer must not look like a thin one. */
export const UNREADABLE: Understanding = {
  concern: '',
  askerContext: '',
  engagement: 'off-topic',
  offered: [],
  whatIsMissing: '',
  alreadySaid: [],
  worthJoining: '',
  confidence: 0,
};

export const SYSTEM_PROMPT = [
  'You read a forum discussion and report what is happening in it.',
  '',
  'You are NOT writing a reply and NOT deciding whether to post one. You are',
  'telling a colleague what this thread is about and what has already been said,',
  'so they can judge whether they have anything to add.',
  '',
  'Rules:',
  '- Report the thread, not your own knowledge of the subject. If nobody',
  '  mentioned a solution, it does not go in `offered` however obvious it is.',
  '- `alreadySaid` is what would be REPETITION. Be generous with it: the most',
  '  common failure is a reply restating the thread in worse words.',
  '- `whatIsMissing` must be specific and grounded in this thread. "More detail"',
  '  is not an answer. If the thread is genuinely well answered, say so plainly',
  '  and leave it near-empty rather than inventing a gap.',
  '- Quote usernames and post numbers exactly as given.',
  '- `confidence` is your own, and a short or ambiguous thread should lower it.',
  '',
  'Reply with JSON only, no prose, in exactly this shape:',
  '{',
  '  "concern": "one sentence, in the asker\'s terms",',
  '  "askerContext": "who appears to be asking",',
  `  "engagement": ${ENGAGEMENT_SHAPES.map((s) => `"${s}"`).join(' | ')},`,
  '  "offered": [{"approach":"…","byUsername":"…","postNumber":1,"endorsed":false}],',
  '  "whatIsMissing": "specific, or empty if nothing is",',
  '  "alreadySaid": ["point already made", "…"],',
  '  "worthJoining": "one sentence",',
  '  "confidence": 0.0',
  '}',
].join('\n');

export function buildUnderstandPrompt(renderedDiscussion: string): string {
  return `Read this discussion and report what is happening in it.\n\n${renderedDiscussion}`;
}

const str = (v: unknown, max = 400): string => String(v ?? '').trim().slice(0, max);

/**
 * The model's reply → an Understanding, or UNREADABLE.
 *
 * ⚠️ A FIELD WE CANNOT BELIEVE MAKES THE WHOLE READING UNREADABLE rather than
 * being defaulted. A `concern` that came back empty is not a discussion with no
 * concern — it is a reply we did not understand, and treating those the same
 * way is how a broken prompt looks like a quiet forum.
 */
export function parseUnderstanding(content: string): Understanding {
  let raw: unknown;
  try {
    // Models fence JSON even when told not to.
    raw = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch {
    return UNREADABLE;
  }

  const r = raw as Record<string, unknown>;
  const concern = str(r.concern);
  if (!concern) return UNREADABLE;

  const engagement = (ENGAGEMENT_SHAPES as readonly string[]).includes(String(r.engagement))
    ? (r.engagement as EngagementShape)
    : 'discussion';

  const offered: OfferedSolution[] = Array.isArray(r.offered)
    ? r.offered
        .map((o) => {
          const s = (o ?? {}) as Record<string, unknown>;
          const approach = str(s.approach, 200);
          if (!approach) return null;
          const n = Number(s.postNumber);
          return {
            approach,
            byUsername: str(s.byUsername, 60) || 'unknown',
            postNumber: Number.isInteger(n) && n > 0 ? n : 0,
            endorsed: s.endorsed === true,
          };
        })
        .filter((o): o is OfferedSolution => o !== null)
        .slice(0, 12)
    : [];

  const confidence = Number(r.confidence);

  return {
    concern,
    askerContext: str(r.askerContext, 200),
    engagement,
    offered,
    whatIsMissing: str(r.whatIsMissing, 600),
    alreadySaid: Array.isArray(r.alreadySaid)
      ? r.alreadySaid.map((s) => str(s, 200)).filter(Boolean).slice(0, 12)
      : [],
    worthJoining: str(r.worthJoining, 400),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
  };
}

export const isUnreadable = (u: Understanding): boolean => u.confidence === 0 && !u.concern;

/**
 * Would a reply here be repeating the thread?
 *
 * Free, and deliberately arithmetic rather than a second model call. A thread
 * the room has already answered well, with nothing identified as missing, is
 * one to learn from rather than join — and that judgement does not need to be
 * bought twice.
 */
export function wouldRepeat(u: Understanding): boolean {
  return u.engagement === 'answered-well' && u.whatIsMissing.length === 0;
}
