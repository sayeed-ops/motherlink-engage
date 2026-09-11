// Stage two: read the QUESTION, and say which kind of reply could help.
//
// PURE — the prompt is built here and the reply is parsed here; the fetch and
// the model call live in server/shopifyAnalysis.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// THE QUESTION, NOT THE REPLIES — THE OPERATOR'S DESIGN, AND WHY IT HOLDS
//
// This replaced a stage that sent the question plus ~14,000 characters of
// replies for every picked thread, and then sent the same replies AGAIN when a
// draft was written. Most picked threads are never drafted, so most of that
// reading was paid for and thrown away.
//
// Now the analysis sees the opening post and the thread's FREE NUMBERS —
// replies, views, likes, solved, age — and no reply text. The replies are read
// once, at draft time, by the call that actually needs them to write something
// better than what is there.
//
// ⚠️ THE NUMBERS ARE NOT OPTIONAL. Without them an unanswered question and a
// solved one with thirty replies look identical, and the Open score is a guess.
// The model is told plainly that the replies exist and were not shown, so a
// score is a judgement about the question with the room's size in view — not a
// claim about what the room said.
//
// ⚠️ THREE SCORES, AND SOME OF THEM ARE NOT THE MODEL'S TO GIVE
//
// Growth and Brand are ZERO when the client is not described — arithmetic, not
// opinion; nothing can lend expertise nobody has written down. Brand is CAPPED
// AT 3 when no knowledge source matched the question: naming the client with
// nothing to back it is not a fit however relevant the company sounds, and the
// Brand draft is refused on the same condition. The prompt says both; the
// parser enforces both. An instruction is a request; this is the rule.
// ════════════════════════════════════════════════════════════════════════════

import { canDescribeClient, type ShopifyClientProfile } from './client';
import type { PromptSource } from './knowledge';
import { REPLY_MODES, type ReplyMode } from './modes';

/** Bumped when the prompt or the shape changes. Stored beside every analysis,
 *  so an older one is visibly stale rather than merely old. */
export const ASSESS_PROMPT_VERSION = 'shopify-assess-v1';

/** Brand at or above this, with a supporting source, is a brand opportunity —
 *  the filter the operator asked for as stage 5. */
export const BRAND_OPPORTUNITY_MIN = 7;

/** Brand's ceiling when no knowledge source matched. */
export const BRAND_CAP_WITHOUT_SOURCE = 3;

/** The opening post, budgeted. A question longer than this is rare, and past
 *  it the model is reading a story rather than a question. */
export const QUESTION_MAX_CHARS = 6000;

export interface ModeScore {
  /** 0–10. The model's opinion, never a measurement — used to sort and filter,
   *  and shown beside the reason so a person can disagree with it. */
  score: number;
  /** Why, in a sentence or two. */
  why: string;
  /** The approach a reply of this kind would take. Handed to THAT mode's
   *  draft, and to no other. Empty when the score is 0. */
  angle: string;
}

export interface BrandScore extends ModeScore {
  /** The matched sources that make the fit — always a subset of what the
   *  model was given, so a citation always points at a real source. */
  sourceIds: string[];
}

export type Suggestion = ReplyMode | 'skip';

export interface Assessment {
  /** The question in the asker's own terms, one sentence. */
  question: string;
  /** Who is asking, as far as the post reveals. */
  askerContext: string;
  /** What a genuinely good answer must cover, whoever writes it. Company-
   *  neutral, which is why every mode's draft may see it. */
  needs: string;
  scores: { open: ModeScore; growth: ModeScore; brand: BrandScore };
  suggested: Suggestion;
  /** 0–1, the model's own. A short or ambiguous post should lower it. */
  confidence: number;
}

/** The thread's free numbers, from the board listing and the topic payload. */
export interface ThreadCounts {
  replies: number;
  views: number;
  likes: number;
  solved: boolean;
  closed: boolean;
  /** Days since the topic was opened / since its last post. Null when the
   *  listing did not say. */
  daysOld: number | null;
  daysSinceLastPost: number | null;
}

export interface Steer {
  /** What the reviewer said — "think about it from an agency's side". */
  comment: string;
  /** The assessment being reconsidered, so the model knows what it is being
   *  asked to change. */
  previous: Assessment;
}

export interface AssessInput {
  title: string;
  board: string;
  /** The opening post as plain text. */
  question: string;
  askedBy: string;
  counts: ThreadCounts;
  client: ShopifyClientProfile;
  /** The shortlist from matchSources — never the whole list. */
  sources: readonly PromptSource[];
  steer?: Steer | null;
}

/** What each mode can even be scored for, before any model is asked. */
export function scorableModes(client: ShopifyClientProfile, matchedSources: number) {
  const growth = client.companyDescription.trim().length > 0;
  const brand = canDescribeClient(client);
  return {
    open: true,
    growth,
    brand,
    /** Brand can be DRAFTED only with a supporting source. Scoring it without
     *  one is still useful — "this would be a fit if we had a page on it" is a
     *  knowledge gap — but the score is capped. */
    brandSupported: brand && matchedSources > 0,
  };
}

export const SYSTEM_PROMPT = [
  'You read ONE question from the Shopify Community forum and judge what kind of',
  'reply could help — before anyone reads the replies.',
  '',
  'You are shown the opening post and the thread\'s numbers: replies, views,',
  'likes, whether it is solved, how old it is. You are NOT shown the replies.',
  'Judge what you can see, and let the numbers weigh: a solved thread with thirty',
  'replies leaves less room than an unanswered one, and an old quiet thread may',
  'not be worth reviving. Where the replies could change the picture, say so.',
  '',
  'Score three kinds of reply, 0–10 each, with a reason a colleague could argue',
  'with:',
  '',
  'OPEN — the most useful answer in the thread, from a knowledgeable merchant who',
  'represents nobody. High when the question is clear and answerable and a',
  'specific, practical answer would genuinely help — the asker, and whoever finds',
  'the thread later. Low when it is vague, off-topic, a support ticket only',
  'Shopify can resolve, a rant, spam, or already settled.',
  '⚠️ Write the OPEN reason and angle as if the company below did not exist.',
  'Never mention the company, its product or its sources there.',
  '',
  'GROWTH — the company\'s expertise brought to bear WITHOUT naming the company.',
  'High when the company\'s field has something to add that an ordinary merchant',
  'would not know. Low when the question is outside that field.',
  '',
  'BRAND — naming the company. High ONLY when naming it would genuinely help this',
  'merchant: the company directly addresses the stated problem, and a knowledge',
  'source below supports saying so. Say WHY it fits or does not — which source,',
  'and what about the question makes a mention helpful rather than an advert.',
  'Think about how it would be received: a product plug in a thread asking for a',
  'how-to scores low even when the product is relevant.',
  `If no knowledge source is listed, BRAND must be ${BRAND_CAP_WITHOUT_SOURCE} or lower.`,
  'If no company is described, GROWTH and BRAND are 0.',
  '',
  'For each, `angle` is the approach that kind of reply would take, in one',
  'sentence. Empty when the score is 0.',
  '`needs` is what a genuinely good answer must cover, whoever writes it — never',
  'mention the company in it.',
  '`suggested` is the kind of reply you would write, or "skip" if none is worth it.',
  '',
  'Rules:',
  '- Judge the question, not the topic. "SEO" is a topic; "why did my collection',
  '  pages drop out of Google after I changed theme" is a question.',
  '- Use the whole range. Not everything is a 5–7.',
  '- Do not invent facts about the company beyond what is given.',
  '',
  'Reply with JSON only, no prose, in exactly this shape:',
  '{',
  '  "question": "one sentence, in the asker\'s terms",',
  '  "askerContext": "who appears to be asking",',
  '  "needs": "what a good answer must cover",',
  '  "open": {"score": 0, "why": "…", "angle": "…"},',
  '  "growth": {"score": 0, "why": "…", "angle": "…"},',
  '  "brand": {"score": 0, "why": "…", "angle": "…", "sourceIds": ["…"]},',
  '  "suggested": "open" | "growth" | "brand" | "skip",',
  '  "confidence": 0.0',
  '}',
].join('\n');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ago = (days: number | null): string =>
  days === null ? 'unknown' : days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;

export function buildAssessPrompt(input: AssessInput): string {
  const c = input.counts;
  const q =
    input.question.length > QUESTION_MAX_CHARS
      ? `${input.question.slice(0, QUESTION_MAX_CHARS).trimEnd()}… [rest of the post not shown]`
      : input.question;

  const parts: string[] = [
    `THREAD: ${input.title}`,
    input.board ? `Board: ${input.board}` : '',
    `Numbers: ${plural(c.replies, 'reply', 'replies')} · ${plural(c.views, 'view')} · ${plural(c.likes, 'like')} · ` +
      `${c.solved ? 'SOLVED — an answer has been accepted' : 'not solved'}${c.closed ? ' · CLOSED to new replies' : ''} · ` +
      `asked ${ago(c.daysOld)} · last post ${ago(c.daysSinceLastPost)}`,
    c.replies > 0 ? `(The ${plural(c.replies, 'reply', 'replies')} exist but are not shown to you.)` : '(Nobody has replied yet.)',
    '',
    `── THE QUESTION (post #1, by ${input.askedBy || 'unknown'}) ──`,
    q,
  ];

  const able = scorableModes(input.client, input.sources.length);
  parts.push('', '── THE COMPANY ──');
  if (!able.growth) {
    parts.push('None described. GROWTH and BRAND are 0.');
  } else {
    parts.push(
      `What they do: ${input.client.companyDescription}`,
      input.client.targetCustomer ? `Who they serve: ${input.client.targetCustomer}` : '',
      input.client.productService ? `What they sell: ${input.client.productService}` : 'What they sell: not described — BRAND is 0.',
      input.client.brandMentionStyle ? `How they may be mentioned: ${input.client.brandMentionStyle}` : '',
    );
  }

  if (able.brand) {
    if (input.sources.length) {
      parts.push('', `── KNOWLEDGE SOURCES THAT MATCHED THIS QUESTION (${input.sources.length}) ──`);
      for (const s of input.sources) {
        parts.push(
          `[${s.sourceId}] ${s.title}`,
          s.summary ? `  ${s.summary}` : '',
          ...s.keyPoints.slice(0, 4).map((k) => `  • ${k}`),
        );
      }
    } else {
      parts.push('', `── KNOWLEDGE SOURCES ──`, `None matched this question. BRAND must be ${BRAND_CAP_WITHOUT_SOURCE} or lower.`);
    }
  }

  if (input.steer?.comment.trim()) {
    const p = input.steer.previous;
    parts.push(
      '',
      '── RECONSIDER ──',
      'You assessed this thread before:',
      ...REPLY_MODES.map((m) => `  ${m.toUpperCase()} ${p.scores[m].score} — ${p.scores[m].why}`),
      `  suggested: ${p.suggested}`,
      '',
      `The reviewer asks you to think again: "${input.steer.comment.trim()}"`,
      'Take the comment seriously — it may be a different angle, a fact you did not',
      'have, or a disagreement. Change a score where the comment warrants it, keep it',
      'where it does not, and say in each reason what changed and why.',
    );
  }

  parts.push('', 'Assess this question.');
  return parts.filter((p) => p !== '').join('\n');
}

/** What an analysis yields when the model could not be believed. Inert: an
 *  unreadable answer must not look like a thread with nothing in it. */
export const UNREADABLE: Assessment = {
  question: '',
  askerContext: '',
  needs: '',
  scores: {
    open: { score: 0, why: '', angle: '' },
    growth: { score: 0, why: '', angle: '' },
    brand: { score: 0, why: '', angle: '', sourceIds: [] },
  },
  suggested: 'skip',
  confidence: 0,
};

export const isUnreadable = (a: Assessment): boolean => !a.question;

const str = (v: unknown, max = 400): string => String(v ?? '').trim().slice(0, max);

const score = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 0;
};

function modeScore(v: unknown): ModeScore {
  const r = (v ?? {}) as Record<string, unknown>;
  const s = score(r.score);
  return { score: s, why: str(r.why, 500), angle: s > 0 ? str(r.angle, 400) : '' };
}

/**
 * The model's reply → an Assessment, with the rules that are not its to break.
 *
 * `offeredSourceIds` is the shortlist it was given: a source id it invents is
 * dropped, so a Brand citation always points at something held.
 */
export function parseAssessment(
  content: string,
  ctx: { client: ShopifyClientProfile; offeredSourceIds: readonly string[] },
): Assessment {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch {
    return UNREADABLE;
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const question = str(r.question);
  if (!question) return UNREADABLE;

  const able = scorableModes(ctx.client, ctx.offeredSourceIds.length);
  const brandRaw = (r.brand ?? {}) as Record<string, unknown>;

  const open = modeScore(r.open);
  let growth = modeScore(r.growth);
  let brand: BrandScore = {
    ...modeScore(r.brand),
    sourceIds: Array.isArray(brandRaw.sourceIds)
      ? [...new Set(brandRaw.sourceIds.map((s) => str(s, 80)))].filter((id) => ctx.offeredSourceIds.includes(id))
      : [],
  };

  if (!able.growth) {
    growth = { score: 0, why: 'No client details yet — fill in Client details to score this.', angle: '' };
  }
  if (!able.brand) {
    brand = {
      score: 0,
      why: able.growth
        ? 'The client has no "what they sell" yet — a reply cannot name what it cannot describe.'
        : 'No client details yet — fill in Client details to score this.',
      angle: '',
      sourceIds: [],
    };
  } else if (!able.brandSupported && brand.score > BRAND_CAP_WITHOUT_SOURCE) {
    brand = { ...brand, score: BRAND_CAP_WITHOUT_SOURCE };
  }

  const scores = { open, growth, brand };
  const confidence = Number(r.confidence);

  return {
    question,
    // 400, not 200: a 200 cap cut real answers mid-word on screen ("…branding
    // decisi"). A limit on storage, not a request for brevity.
    askerContext: str(r.askerContext, 400),
    needs: str(r.needs, 600),
    scores,
    suggested: pickSuggestion(r.suggested, scores, able),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
  };
}

/** The model's suggestion, if it is one it may make; otherwise the best
 *  available score, or skip when nothing clears 3. */
function pickSuggestion(
  v: unknown,
  scores: Assessment['scores'],
  able: ReturnType<typeof scorableModes>,
): Suggestion {
  const usable = (m: ReplyMode) => m === 'open' || (m === 'growth' ? able.growth : able.brandSupported);
  const s = String(v ?? '');
  if (s === 'skip') return 'skip';
  if ((REPLY_MODES as readonly string[]).includes(s) && usable(s as ReplyMode) && scores[s as ReplyMode].score > 0) {
    return s as ReplyMode;
  }
  const best = REPLY_MODES.filter(usable).sort((a, b) => scores[b].score - scores[a].score)[0];
  return best && scores[best].score > 3 ? best : 'skip';
}

/** Is this a brand opportunity — the stage 5 filter. */
export const isBrandOpportunity = (a: Assessment, brandSupported: boolean): boolean =>
  brandSupported && a.scores.brand.score >= BRAND_OPPORTUNITY_MIN;

/** The highest of the three, for ordering a list. */
export const topScore = (a: Assessment): number =>
  Math.max(a.scores.open.score, a.scores.growth.score, a.scores.brand.score);
