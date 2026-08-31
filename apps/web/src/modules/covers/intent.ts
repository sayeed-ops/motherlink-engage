// What is this person actually asking, and what is it about?
//
// PURE — prompt in one function, parse in another, no network. The call itself
// lives in the server layer, the same split every other model step here uses.
//
// ════════════════════════════════════════════════════════════════════════════
// THE QUESTION THIS ASKS IS NOT "COULD WE MENTION THE CLIENT HERE"
//
// A classifier asked that produces spam, reliably, because there is always an
// angle. The one worth paying for asks what the PROBLEM is, and leaves whether
// we can help to a separate stage that can answer no.
//
// It is also the first call that costs money in this funnel. Everything free —
// the section's role, the thread's age, our own footprint, the jurisdiction —
// has already run in screen.ts and policy.ts, so nothing reaching here was going
// to be rejected on facts we already held.
// ════════════════════════════════════════════════════════════════════════════

/**
 * What kind of post this is.
 *
 * Intent rather than keywords is what makes the matcher replicable: the same
 * seven categories describe a sportsbook forum, a crypto board and a payroll
 * subreddit, so a second platform is a reader plus a policy file rather than a
 * second classifier.
 */
export type PostIntent =
  | 'question' // wants an answer they do not have
  | 'comparison' // weighing options, ours possibly among them
  | 'complaint' // something went wrong and they are angry about it
  | 'pick-sharing' // posting their bets; no question asked
  | 'tool-request' // wants a thing that does a job
  | 'education' // explaining, or asking to be taught
  | 'banter'; // social. Not an opportunity and not a failure.

export const POST_INTENTS: readonly PostIntent[] = [
  'question',
  'comparison',
  'complaint',
  'pick-sharing',
  'tool-request',
  'education',
  'banter',
] as const;

export const INTENT_LABEL: Record<PostIntent, string> = {
  question: 'Asking a question',
  comparison: 'Comparing options',
  complaint: 'Complaint',
  'pick-sharing': 'Sharing picks',
  'tool-request': 'Looking for a tool',
  education: 'Explaining or learning',
  banter: 'Banter',
};

/**
 * Intents nothing may ever be drafted for.
 *
 * ⚠️ `complaint` IS NOT A WEAK OPPORTUNITY. "Brand X stole my money" is a
 * support and reputation event, and it leaves the marketing pipeline entirely —
 * it is not a thread to be helpful in with the right wording. A pipeline that
 * treats an angry customer as a placement is the single behaviour most likely to
 * get an account banned and a client's name attached to it.
 *
 * `banter` is excluded for the opposite, cheaper reason: there is nothing to
 * answer, and replying to it is how an account becomes noise.
 */
export const UNDRAFTABLE_INTENTS: readonly PostIntent[] = ['complaint', 'banter'] as const;

export function isDraftable(intent: PostIntent): boolean {
  return !(UNDRAFTABLE_INTENTS as readonly string[]).includes(intent);
}

export interface IntentReading {
  intent: PostIntent;
  /** The problem in the WRITER'S terms, one sentence. Feeds retrieval and is
   *  shown in review, where it is the fastest way to see a misread. */
  problem: string;
  /** Concepts to retrieve on — the thread's own words, not ours. */
  concepts: string[];
  /** Is the writer asking for something, or just talking? A pick-sharing post
   *  with a question inside it is still answerable. */
  asksSomething: boolean;
  /** 0-1, the model's own confidence. NOT a measurement; used for ordering and
   *  for a floor, never presented as a probability. */
  confidence: number;
}

/** What a post yields when the model could not be believed. Draftable is false
 *  by construction: an unreadable answer must not become a reply. */
export const UNREADABLE: IntentReading = {
  intent: 'banter',
  problem: '',
  concepts: [],
  asksSomething: false,
  confidence: 0,
};

export const INTENT_PROMPT_VERSION = 'covers-intent-v1';

export const INTENT_SYSTEM = `You read posts on a sports betting forum and say what the writer wants.

You are NOT deciding whether anything can be sold here, and you are not looking
for an angle. You are describing the post.

Answer with JSON only:
{
  "intent": "question" | "comparison" | "complaint" | "pick-sharing" | "tool-request" | "education" | "banter",
  "problem": "one sentence, in the writer's own terms, saying what they want or what went wrong",
  "concepts": ["short phrases naming what this is about, taken from the post's own words"],
  "asksSomething": true | false,
  "confidence": 0.0 to 1.0
}

Rules:
- "complaint" means something went wrong for them and they are unhappy about it.
  Use it even when the post also asks a question. Anger is the fact that matters.
- "pick-sharing" is posting bets with nothing asked. If they share picks AND ask
  something, the question wins.
- "banter" is social talk with nothing to answer.
- "concepts" must be phrases that appear in or directly paraphrase the post. Do
  not add topics the writer did not raise.
- If the post is too short or garbled to read, use confidence 0.`;

export function buildIntentPrompt(input: {
  sectionName: string;
  threadTitle: string;
  postBody: string;
  /** Two or three neighbouring posts, oldest first, for context only. */
  context?: string[];
}): string {
  const context = (input.context ?? []).filter((c) => c.trim()).slice(0, 3);

  return [
    `Section: ${input.sectionName}`,
    `Thread: ${input.threadTitle}`,
    context.length > 0 ? `\nEarlier in the thread:\n${context.map((c) => `- ${clip(c, 400)}`).join('\n')}` : '',
    `\nThe post to read:\n"""\n${clip(input.postBody, 2000)}\n"""`,
  ]
    .filter(Boolean)
    .join('\n');
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * Is this a subject, or is it a number?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * BETTING NOTATION IS NOT A CONCEPT
 *
 * The first live run extracted `3.5`, `1h +2.5(+102)`, `16-10-1 overall` and
 * `3&1 so far` as things the thread was "about". They are prices and records —
 * the writer's own words, faithfully, and useless twice over: they retrieve
 * nothing from a knowledge base, and on the gap board they become entries
 * claiming that people keep asking about "3.5".
 *
 * A concept has to carry a word. Anything that is mostly digits and betting
 * punctuation is dropped here rather than downstream, so it never reaches
 * retrieval either.
 * ════════════════════════════════════════════════════════════════════════════
 */
function isConcept(phrase: string): boolean {
  const solid = phrase.replace(/\s/g, '');
  if (solid.length === 0) return false;

  // "1h", "3&1", "+2.5(+102)" — notation with no real word in it. Three letters
  // is "ats" or "sgm", which ARE concepts.
  if (phrase.replace(/[^a-z]/g, '').length < 3) return false;

  // A quarter of it being digits means the words are decoration on a number:
  // "16-10-1 overall" is 36%, "3&1 so far" is 25%, "1h +2.5(+102)" is 50%.
  //
  // The known cost, stated rather than discovered: a concept genuinely NAMED by
  // a number — "1099 forms" for an accounting client — is dropped too. That is
  // acceptable here because the `problem` sentence is not filtered, so nothing
  // is lost to the person reviewing; only retrieval and the gap board are
  // protected from prices.
  const digits = solid.replace(/[^0-9]/g, '').length;
  return digits / solid.length < 0.25;
}

/**
 * Read the model's answer, or refuse it.
 *
 * ⚠️ AN UNRECOGNISED INTENT IS NOT COERCED TO A DEFAULT. Picking the nearest
 * valid value would turn a model that misunderstood the task into a confident
 * classification, and the two are indistinguishable downstream. It returns
 * UNREADABLE instead, which is undraftable and carries confidence 0.
 */
export function parseIntent(raw: unknown): IntentReading {
  if (!raw || typeof raw !== 'object') return UNREADABLE;
  const o = raw as Record<string, unknown>;

  const intent = typeof o.intent === 'string' ? o.intent.trim().toLowerCase() : '';
  if (!(POST_INTENTS as readonly string[]).includes(intent)) return UNREADABLE;

  const problem = typeof o.problem === 'string' ? o.problem.trim().slice(0, 400) : '';

  const concepts = Array.isArray(o.concepts)
    ? o.concepts
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 1)
        .map((c) => c.trim().toLowerCase().slice(0, 60))
        .filter(isConcept)
        .filter((c, i, all) => all.indexOf(c) === i)
        .slice(0, 12)
    : [];

  const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
    ? Math.max(0, Math.min(1, o.confidence))
    : 0;

  // A classification with no problem statement cannot be checked by the person
  // reviewing it, and retrieval has nothing to work from. Same rule the critic
  // applies to a choice with no reason.
  if (!problem && isDraftable(intent as PostIntent)) return UNREADABLE;

  return {
    intent: intent as PostIntent,
    problem,
    concepts,
    asksSomething: o.asksSomething === true,
    confidence,
  };
}
