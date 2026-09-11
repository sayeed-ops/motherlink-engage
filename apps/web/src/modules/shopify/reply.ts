// Writing a reply, in one of three modes.
//
// PURE — prompts built here, replies parsed here; the model call lives in
// server/shopifyDrafts.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// THE REPLIES ARE READ HERE, AND ONLY HERE
//
// The analysis (assess.ts) saw the question and the numbers. This call is the
// first to see what the room actually said — once, when a person has asked for
// a reply — and it does two things in one JSON answer: says what the replies
// already offer (the digest, digest.ts), and writes something better.
//
// ⚠️ EACH MODE IS HANDED ITS OWN BRIEF AND NO OTHER. The analysis wrote a reason
// and an angle for all three; Open gets Open's, Brand gets Brand's. Open in
// particular is never given the client, the sources, or the reasoning about
// them — a reply that represents nobody has to be written by something that
// has not been told who it would otherwise be representing.
//
// ⚠️ OPEN INVERTS THE REPETITION RULE, ON PURPOSE. What the replies offer is
// the BAR TO BEAT: overlapping is fine, being no better is not. Growth and
// Brand keep the rule — they add what the room does not have.
// ════════════════════════════════════════════════════════════════════════════

import type { ShopifyClientProfile } from './client';
import type { Assessment } from './assess';
import { EMPTY_DIGEST, ENGAGEMENT_SHAPES, parseDigest, type ThreadDigest } from './digest';
import type { PromptSource } from './knowledge';
import type { ReplyMode } from './modes';

export { REPLY_MODES, MODE_LABEL, MODE_HELP, type ReplyMode } from './modes';
export type { PromptSource } from './knowledge';

export const REPLY_PROMPT_VERSION = 'shopify-reply-v2';

export interface ReplyDraft {
  mode: ReplyMode;
  /** What would be posted. Plain text. */
  text: string;
  words: number;
  /** One sentence on what this reply is doing, for the person reviewing it. */
  angle: string;
  /** Sources leaned on, by id. Empty for `open`, which is given none. */
  usedSourceIds: string[];
  /** The model's own answer to "is this better than what is already there?". */
  betterBecause: string;
  /** What the replies already said, as this call read them. */
  digest: ThreadDigest;
}

export const UNWRITABLE: ReplyDraft = {
  mode: 'open',
  text: '',
  words: 0,
  angle: '',
  usedSourceIds: [],
  betterBecause: '',
  digest: EMPTY_DIGEST,
};

const SHARED_RULES = [
  'Write it as a forum reply, not an article. No headings, no bullet lists',
  'unless the answer genuinely is a list, no sign-off, no "Great question!".',
  'Merchants can tell. Short and specific beats long and hedged.',
  'Do not invent numbers, prices, dates or features. If you do not know, say',
  'what you would check rather than guessing.',
  'Never claim to have personally used something you have not been told about.',
];

const DIGEST_SHAPE =
  `"thread":{"engagement":${ENGAGEMENT_SHAPES.map((s) => `"${s}"`).join('|')},` +
  '"offered":[{"approach":"…","byUsername":"…","postNumber":2,"endorsed":false}],' +
  '"alreadySaid":["…"],"whatIsMissing":"…"}';

const READ_FIRST = [
  'Before writing, read the replies and report them in `thread`: what each',
  'answer offered and by whom (usernames and post numbers exactly as given),',
  'which points are repeated enough that saying them again adds nothing, and',
  'what nobody has said that would genuinely help. Report the thread, not your',
  'own knowledge — if nobody offered it, it is not in `offered`.',
];

export const SYSTEM_BY_MODE: Record<ReplyMode, string> = {
  // ── OPEN ─────────────────────────────────────────────────────────────────
  open: [
    'You are a knowledgeable member of the Shopify merchant community writing a',
    'reply to one thread. Your goal is ENGAGEMENT: write the most useful answer',
    'in that thread.',
    '',
    ...READ_FIRST,
    '',
    '⚠️ What the replies already offer is THE BAR TO BEAT, not a list to avoid.',
    'If others gave partial or vague answers, give the complete, specific one.',
    'Overlapping with them is fine — being no better than them is not.',
    '',
    'What "better" means here, in order:',
    '- Speaks to the actual pain, including the part they did not spell out.',
    '- Specific where the thread is vague: the setting, the field, the number,',
    '  the order of operations.',
    '- Tells them what to do next, not what the landscape looks like.',
    '- Honest about trade-offs.',
    '',
    'You represent nobody. Do not mention any company, product or tool as a',
    'recommendation unless the thread already raised it, and never link anything.',
    ...SHARED_RULES,
    '',
    `Reply with JSON only: {${DIGEST_SHAPE},"text":"…","angle":"…","betterBecause":"…"}`,
  ].join('\n'),

  // ── GROWTH ───────────────────────────────────────────────────────────────
  growth: [
    'You are a knowledgeable practitioner replying to one thread. You work for a',
    'company whose expertise is described below, and you are drawing on that',
    'expertise WITHOUT MENTIONING THE COMPANY AT ALL.',
    '',
    ...READ_FIRST,
    '',
    'The company name, its product, and any link to it must not appear. If the',
    'only useful thing you could say is "use our product", say nothing useful',
    'instead — return an empty text and explain why in `angle`.',
    '',
    'Do not restate what the replies already cover. Add the thing the expertise',
    'gives you that the room does not have.',
    ...SHARED_RULES,
    '',
    `Reply with JSON only: {${DIGEST_SHAPE},"text":"…","angle":"…","betterBecause":"…","usedSourceIds":[]}`,
  ].join('\n'),

  // ── BRAND ────────────────────────────────────────────────────────────────
  brand: [
    'You are replying to one thread on behalf of the company described below,',
    'and you MAY name it — but only where naming it is genuinely the answer.',
    '',
    ...READ_FIRST,
    '',
    'Rules that are not suggestions:',
    '- Every factual claim about the company must come from the knowledge',
    '  sources given. Nothing inferred, nothing remembered, nothing assumed.',
    '- Follow the brand mention style exactly.',
    '- One mention. A reply that names the company twice reads as an advert.',
    '- Be useful first. The mention has to be the smaller part of the reply.',
    '- Do not restate what the replies already cover.',
    '- If the honest answer is that the company does not solve this, say so and',
    '  return an empty text — a forced mention costs more than it earns.',
    ...SHARED_RULES,
    '',
    `Reply with JSON only: {${DIGEST_SHAPE},"text":"…","angle":"…","betterBecause":"…","usedSourceIds":["…"]}`,
  ].join('\n'),
};

export interface ReplyPromptInput {
  mode: ReplyMode;
  title: string;
  /** The whole conversation, rendered and budgeted by discussion.ts. */
  discussion: string;
  assessment: Assessment;
  /** Absent for `open` — see the header. */
  client?: ShopifyClientProfile;
  sources?: readonly PromptSource[];
  targetWords: number;
}

export function buildReplyPrompt(input: ReplyPromptInput): string {
  const a = input.assessment;
  const brief = a.scores[input.mode];

  const parts: string[] = [
    `THREAD: ${input.title}`,
    '',
    input.discussion,
    '',
    '── WHAT THE QUESTION IS ──',
    `They are asking: ${a.question}`,
    a.askerContext ? `Who is asking: ${a.askerContext}` : '',
    a.needs ? `A good answer must cover: ${a.needs}` : '',
    '',
    `── YOUR BRIEF ──`,
    brief.why ? `Why this kind of reply fits: ${brief.why}` : '',
    brief.angle ? `The approach: ${brief.angle}` : '',
    '',
    input.mode === 'open'
      ? '── THE REPLIES ABOVE ARE THE BAR TO BEAT. Overlap is fine; going deeper on a point they made is good; being no better is not. ──'
      : '── THE REPLIES ABOVE: DO NOT RESTATE WHAT THEY COVER. Add what the room does not have. ──',
  ];

  if (input.mode !== 'open' && input.client) {
    parts.push(
      '',
      '── THE COMPANY ──',
      `What they do: ${input.client.companyDescription}`,
      input.client.targetCustomer ? `Who they serve: ${input.client.targetCustomer}` : '',
      input.client.productService ? `What they sell: ${input.client.productService}` : '',
    );
    if (input.mode === 'brand' && input.client.brandMentionStyle) {
      parts.push(`How they may be mentioned: ${input.client.brandMentionStyle}`);
    }
    if (input.client.forbiddenPhrases.length) {
      parts.push(`Phrases that must never appear: ${input.client.forbiddenPhrases.join('; ')}`);
    }
  }

  if (input.mode !== 'open' && input.sources?.length) {
    parts.push('', `── KNOWLEDGE SOURCES (${input.sources.length}) ──`);
    for (const s of input.sources) {
      parts.push(
        `[${s.sourceId}] ${s.title}`,
        s.summary ? `  ${s.summary}` : '',
        ...s.keyPoints.slice(0, 6).map((k) => `  • ${k}`),
        ...s.answerAngles.slice(0, 3).map((x) => `  angle: ${x}`),
      );
    }
  }

  parts.push('', `Aim for roughly ${input.targetWords} words. Write the reply.`);
  return parts.filter((p) => p !== '').join('\n');
}

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

export function parseReply(content: string, mode: ReplyMode): ReplyDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch {
    return { ...UNWRITABLE, mode };
  }

  const r = (raw ?? {}) as Record<string, unknown>;
  const text = str(r.text, 6000);

  return {
    mode,
    text,
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    angle: str(r.angle, 400),
    // Ids are echoed back by the model, so they are strings we CHECK rather
    // than trust — the caller filters them against the sources it supplied.
    usedSourceIds: Array.isArray(r.usedSourceIds) ? r.usedSourceIds.map((s) => str(s, 80)).filter(Boolean).slice(0, 20) : [],
    betterBecause: str(r.betterBecause, 400),
    digest: parseDigest(r.thread),
  };
}

/** Nothing was written. Distinct from a bad reply: growth and brand are both
 *  told to return empty rather than force something. */
export const isEmpty = (d: ReplyDraft): boolean => d.text.trim().length === 0;

/**
 * Which modes can be drafted for this thread.
 *
 * ⚠️ `open` IS ALWAYS AVAILABLE. A mode that can be unavailable is a mode that
 * leaves an ordinary thread with no reply — the gap Reddit has.
 *
 * Brand needs the client described well enough to name (what they do AND what
 * they sell) and at least one knowledge source that speaks to this thread.
 * Reddit's posture, chosen over Covers', whose citable-claim gate never fired.
 */
export function availableModes(input: { client: ShopifyClientProfile; supportingSourceCount: number }): ReplyMode[] {
  const modes: ReplyMode[] = ['open'];
  const described = input.client.companyDescription.trim().length > 0;
  if (described) modes.push('growth');
  if (described && input.client.productService.trim().length > 0 && input.supportingSourceCount > 0) modes.push('brand');
  return modes;
}
