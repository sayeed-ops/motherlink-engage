// Writing a reply, in one of three modes.
//
// PURE — prompts built here, replies parsed here; the model call lives in
// server/shopifyDrafts.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// THREE MODES, AND ONLY ONE OF THEM ALWAYS WORKS
//
//   OPEN    names nobody, needs nothing, works on ANY thread. The goal is
//           ENGAGEMENT: be more useful than what is already there.
//   GROWTH  the client's expertise with the client absent. Needs something
//           genuinely worth adding.
//   BRAND   names the client. Needs a knowledge source that supports it.
//
// Reddit has the second and third. It has no equivalent of the first, and that
// is the gap: both of its modes are GATED — brand is downgraded without a
// supporting source, growth has to clear a score floor — so an ordinary thread
// that simply is not about the client produces nothing at all.
//
// ⚠️ OPEN INVERTS THE REPETITION RULE, ON PURPOSE
//
// Covers refused to repeat the room, and its drafts died on "generic advice
// that adds nothing to the thread". Growth and Brand keep that rule. OPEN does
// not: if four people gave a partial answer, a better complete one is exactly
// the play. `alreadySaid` is handed to this mode as THE BAR TO BEAT rather than
// a blocklist, and `wouldRepeat` does not gate it.
//
// The distinction that keeps that honest: beating an answer means being more
// useful to the person who asked — more specific, more complete, closer to the
// actual pain. It does not mean saying the same thing at greater length.
// ════════════════════════════════════════════════════════════════════════════

import type { ShopifyClientProfile } from './client';
import type { Understanding } from './understand';

export const REPLY_PROMPT_VERSION = 'shopify-reply-v1';

export const REPLY_MODES = ['open', 'growth', 'brand'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export const MODE_LABEL: Record<ReplyMode, string> = {
  open: 'Open',
  growth: 'Growth',
  brand: 'Brand',
};

export const MODE_HELP: Record<ReplyMode, string> = {
  open: 'The most useful answer in the thread. Names nobody, needs nothing, works anywhere.',
  growth: "The client's expertise with the client absent. Builds standing, never mentions them.",
  brand: 'Names the client. Only where a knowledge source actually supports it.',
};

export interface ReplyDraft {
  mode: ReplyMode;
  /** What would be posted. Plain text — the forum takes markdown, but a reply
   *  that needs formatting to land is usually a reply that is too long. */
  text: string;
  words: number;
  /** One sentence on what this reply is doing, for the person reviewing it. */
  angle: string;
  /** Sources leaned on, by id. Empty for `open`, which is given none. */
  usedSourceIds: string[];
  /** The model's own answer to "is this better than what is already there?".
   *  Not a measurement; shown beside the draft so a reviewer can disagree. */
  betterBecause: string;
}

export const UNWRITABLE: ReplyDraft = {
  mode: 'open',
  text: '',
  words: 0,
  angle: '',
  usedSourceIds: [],
  betterBecause: '',
};

/** A knowledge source, reduced to what a prompt needs. Mirrors the project-level
 *  `sources` collection Reddit already fills — Shopify reads the same store
 *  rather than growing a second one. */
export interface PromptSource {
  sourceId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  answerAngles: string[];
}

const SHARED_RULES = [
  'Write it as a forum reply, not an article. No headings, no bullet lists',
  'unless the answer genuinely is a list, no sign-off, no "Great question!".',
  'Merchants can tell. Short and specific beats long and hedged.',
  'Do not invent numbers, prices, dates or features. If you do not know, say',
  'what you would check rather than guessing.',
  'Never claim to have personally used something you have not been told about.',
];

export const SYSTEM_BY_MODE: Record<ReplyMode, string> = {
  // ── OPEN ─────────────────────────────────────────────────────────────────
  open: [
    'You are a knowledgeable member of the Shopify merchant community writing a',
    'reply to one thread. Your goal is ENGAGEMENT: write the most useful answer',
    'in that thread.',
    '',
    '⚠️ You will be shown what has already been said. That is THE BAR TO BEAT,',
    'not a list to avoid. If others gave partial or vague answers, give the',
    'complete, specific one. Overlapping with them is fine — being no better',
    'than them is not.',
    '',
    'What "better" means here, in order:',
    '- Speaks to the actual pain, including the part they did not spell out.',
    '- Specific where the thread is vague: the setting, the field, the number,',
    '  the order of operations.',
    '- Tells them what to do next, not what the landscape looks like.',
    '- Honest about trade-offs. A reply that admits when something is fiddly is',
    '  more credible than one that does not.',
    '',
    'You represent nobody. Do not mention any company, product or tool as a',
    'recommendation unless the thread already raised it, and never link anything.',
    ...SHARED_RULES,
    '',
    'Reply with JSON only: {"text":"…","angle":"…","betterBecause":"…"}',
  ].join('\n'),

  // ── GROWTH ───────────────────────────────────────────────────────────────
  growth: [
    'You are a knowledgeable practitioner replying to one thread. You work for a',
    'company whose expertise is described below, and you are drawing on that',
    'expertise WITHOUT MENTIONING THE COMPANY AT ALL.',
    '',
    'The company name, its product, and any link to it must not appear. If the',
    'only useful thing you could say is "use our product", say nothing useful',
    'instead — return an empty text and explain why in `angle`.',
    '',
    'Unlike an open reply, do not restate what the thread already covers. Add',
    'the thing the expertise gives you that the room does not have.',
    ...SHARED_RULES,
    '',
    'Reply with JSON only: {"text":"…","angle":"…","betterBecause":"…","usedSourceIds":[]}',
  ].join('\n'),

  // ── BRAND ────────────────────────────────────────────────────────────────
  brand: [
    'You are replying to one thread on behalf of the company described below,',
    'and you MAY name it — but only where naming it is genuinely the answer.',
    '',
    'Rules that are not suggestions:',
    '- Every factual claim about the company must come from the knowledge',
    '  sources given. Nothing inferred, nothing remembered, nothing assumed.',
    '- Follow the brand mention style exactly.',
    '- One mention. A reply that names the company twice reads as an advert.',
    '- Be useful first. The mention has to be the smaller part of the reply.',
    '- If the honest answer is that the company does not solve this, say so and',
    "  return an empty text — a forced mention costs more than it earns.",
    ...SHARED_RULES,
    '',
    'Reply with JSON only: {"text":"…","angle":"…","betterBecause":"…","usedSourceIds":["…"]}',
  ].join('\n'),
};

export interface ReplyPromptInput {
  mode: ReplyMode;
  title: string;
  /** The conversation, already rendered and budgeted by discussion.ts. */
  discussion: string;
  understanding: Understanding;
  /** Absent for `open` — the mode is given no client context at all, so a
   *  reply that "represents nobody" is written by something that has not been
   *  told who it would otherwise be representing. */
  client?: ShopifyClientProfile;
  sources?: readonly PromptSource[];
  /** Roughly how long the reply should be, from the thread's own register. */
  targetWords: number;
}

export function buildReplyPrompt(input: ReplyPromptInput): string {
  const u = input.understanding;
  const parts: string[] = [
    `THREAD: ${input.title}`,
    '',
    input.discussion,
    '',
    '── WHAT THIS THREAD IS ──',
    `They are asking: ${u.concern}`,
  ];

  if (u.askerContext) parts.push(`Who is asking: ${u.askerContext}`);

  if (u.offered.length) {
    parts.push(
      '',
      input.mode === 'open'
        ? `── ANSWERS ALREADY GIVEN — THIS IS THE BAR TO BEAT (${u.offered.length}) ──`
        : `── ANSWERS ALREADY GIVEN, DO NOT RESTATE (${u.offered.length}) ──`,
      ...u.offered.map((o) => `- ${o.approach}${o.endorsed ? ' [the thread endorsed this]' : ''}`),
    );
  }

  if (u.alreadySaid.length) {
    parts.push(
      '',
      input.mode === 'open'
        ? '── POINTS THE THREAD HAS COVERED. Beat these; repeating them adds nothing, but going deeper on one of them does. ──'
        : '── POINTS ALREADY MADE. Do not repeat these. ──',
      ...u.alreadySaid.map((a) => `- ${a}`),
    );
  }

  if (u.whatIsMissing) parts.push('', `── NOBODY HAS SAID ──`, u.whatIsMissing);

  if (input.mode !== 'open' && input.client) {
    parts.push(
      '',
      '── THE COMPANY ──',
      `What they do: ${input.client.companyDescription}`,
      `Who they serve: ${input.client.targetCustomer}`,
      `What they sell: ${input.client.productService}`,
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
        ...s.answerAngles.slice(0, 3).map((a) => `  angle: ${a}`),
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

  const r = raw as Record<string, unknown>;
  const text = str(r.text, 6000);

  return {
    mode,
    text,
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    angle: str(r.angle, 400),
    // Ids are echoed back by the model, so they are strings we CHECK rather
    // than trust — the caller filters them against the sources it supplied.
    usedSourceIds: Array.isArray(r.usedSourceIds)
      ? r.usedSourceIds.map((s) => str(s, 80)).filter(Boolean).slice(0, 20)
      : [],
    betterBecause: str(r.betterBecause, 400),
  };
}

/** Nothing was written. Distinct from a bad reply: growth and brand are both
 *  told to return empty rather than force something, and that is a decision to
 *  record rather than an error. */
export const isEmpty = (d: ReplyDraft): boolean => d.text.trim().length === 0;

/**
 * Which modes are even possible for this thread.
 *
 * ⚠️ `open` IS ALWAYS AVAILABLE. That is the whole point of it — a mode that
 * can be unavailable is a mode that leaves an ordinary thread with no reply,
 * which is the gap Reddit has.
 */
export function availableModes(input: {
  hasClientProfile: boolean;
  matchedSourceCount: number;
  understanding: Understanding;
}): ReplyMode[] {
  const modes: ReplyMode[] = ['open'];
  if (input.hasClientProfile) modes.push('growth');
  // Reddit's posture, chosen deliberately over Covers': a supporting source is
  // enough to name the client. Covers required a live citable claim and the
  // result was a mode that could never fire, because its library held none.
  if (input.hasClientProfile && input.matchedSourceCount > 0) modes.push('brand');
  return modes;
}
