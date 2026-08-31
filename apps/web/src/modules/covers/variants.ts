// Writing the replies — one to three of them, none of them chosen here.
//
// PURE. Prompt building and response parsing only; the model call lives in
// server/coversDrafts.ts. Same split as ./intent.ts and forum/reply/generate.ts,
// and for the same reason: everything that decides anything must be testable
// without a network.
//
// ════════════════════════════════════════════════════════════════════════════
// THREE KINDS OF REPLY, NOT THREE ATTEMPTS AT ONE
//
// The Reddit generator writes three executions of a single idea and the critic
// picks the best. This writes three DIFFERENT REPLIES that are each valid on
// their own terms — one that names the client, one shaped by what the client
// knows but naming nobody, and one that is simply a useful forum post. They are
// not competing drafts of the same thing, and the critic's job is correspondingly
// different: not "which is best written" but "which of these, if any, should
// exist".
//
// Only the ELIGIBLE ones are written. The mask was computed for free in phase 3
// (policy.ts § variantEligibility) and an ineligible variant never enters a
// prompt — the model work is skipped, not done and hidden.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// TWO CALLS, NOT ONE — AND THIS IS A DEVIATION FROM THE WRITTEN PLAN
//
// COVERS-PLAN.md § 05 says "one model call, producing between one and three
// replies". It is one call here only when community-only is the sole eligible
// variant, and otherwise two: the library-backed variants share a call, and
// community-only gets its own.
//
// The reason is the plan's own definition of variant 3 — it "does not draw on
// the library". A single call carrying the client's help-centre text in its
// context cannot produce a reply that did not draw on it; it can only produce
// one that does not CITE it, which is precisely the failure the plan names for
// variant 2 ("may not smuggle an unattributable proprietary figure into a reply
// that hides where it came from"). The separation is what makes "community-only"
// a fact about how the text was produced rather than a label on it.
//
// The cost is one extra call per opportunity that has both kinds eligible. That
// is a few calls per run, against a guarantee that would otherwise be untestable.
// ════════════════════════════════════════════════════════════════════════════

import type { Asset } from '@/modules/knowledge/types';
import type { SectionRegister } from './register';
import { countWords, renderRegister } from './register';
import type { VariantEligibility } from './policy';

// ---------------------------------------------------------------------------
// The three kinds
// ---------------------------------------------------------------------------

export type VariantKind = 'brand-mentioned' | 'brand-informed' | 'community-only';

export const VARIANT_KINDS: readonly VariantKind[] = [
  'brand-mentioned',
  'brand-informed',
  'community-only',
] as const;

export const VARIANT_LABEL: Record<VariantKind, string> = {
  'brand-mentioned': 'Brand mentioned',
  'brand-informed': 'Brand informed',
  'community-only': 'Community only',
};

/** How each kind maps onto the eligibility flags phase 3 computed. */
export const VARIANT_FLAG: Record<VariantKind, keyof VariantEligibility> = {
  'brand-mentioned': 'brandMentioned',
  'brand-informed': 'brandInformed',
  'community-only': 'communityOnly',
};

/** Which kinds draw on the client's library. The split that decides which
 *  prompt a variant belongs in — see the two-calls note above. */
export const LIBRARY_BACKED: readonly VariantKind[] = ['brand-mentioned', 'brand-informed'] as const;

export function isLibraryBacked(kind: VariantKind): boolean {
  return (LIBRARY_BACKED as readonly string[]).includes(kind);
}

/** The eligible kinds, in the order they are written. */
export function eligibleKinds(variants: VariantEligibility): VariantKind[] {
  return VARIANT_KINDS.filter((k) => variants[VARIANT_FLAG[k]]);
}

// ---------------------------------------------------------------------------
// What the generator is given, and what it returns
// ---------------------------------------------------------------------------

/**
 * One assertable fact, as the prompt sees it.
 *
 * ⚠️ ONLY LIVE CLAIMS BELONG HERE. An expired or stale claim is not assertable
 * and putting it in front of the model — even labelled — invites a reply built
 * on it that the compliance gate then has to reject. Filtering happens before
 * this file, in the caller, against freshness.ts.
 */
export interface PromptClaim {
  claimId: string;
  /** The fact, as a reply would state it. */
  text: string;
  sourceUrl: string;
  assetId: string;
  assetTitle: string;
}

export interface VariantDraft {
  kind: VariantKind;
  text: string;
  words: number;
  /**
   * The claims the model says it relied on.
   *
   * ⚠️ A DECLARATION, NOT A VERIFICATION. The model saying "I used c3" is where
   * the evidence trail starts, not where it ends — ./compliance.ts checks that
   * every factual assertion in the text maps to a live claim, and an unbacked
   * assertion fails whatever this array says. Kept because it is what a reviewer
   * reads to understand why the system believed the sentence was safe.
   */
  claimIds: string[];
}

export const VARIANT_PROMPT_VERSION = 'covers-variants-v1';

// ---------------------------------------------------------------------------
// The honesty rule
// ---------------------------------------------------------------------------

/**
 * Applies to all three variants, and is stated in every prompt.
 *
 * COVERS-PLAN.md § The honesty rule: variants 2 and 3 exist for genuine
 * participation, NOT for manufacturing the appearance of an unrelated customer.
 * A model told to "write as a helpful member of the forum" will reach for "I've
 * been using them for years" because that is what a persuasive forum post looks
 * like, and it is a claim nobody has approved and nobody could defend.
 *
 * Enforced twice by design — here as a constraint, and in ./compliance.ts as a
 * validator. A prompt rule alone is a request.
 */
export const HONESTY_RULE = `NEVER CLAIM FIRST-HAND EXPERIENCE. Do not write "I use", "I've withdrawn from", "I've been betting with them", "my account", "when I signed up", or anything else that asserts you personally did a thing. You have not. You may reason, explain, compare and ask — you may not remember.`;

const NO_INVENTION_RULE = `Never invent a number, a figure, a date, a limit or a percentage. If a fact is not in the material you were given or in the thread itself, write the reply without it.`;

const SHARED_RULES = `- One idea per reply. Answer the question that was asked and stop.
- The first sentence carries it. Nobody reads past a first line that does not land.
- No sign-offs. No "hope this helps", no offers to explain further, no "let me know".
- Do not restate the question back at them.
- Do not tell anyone they are wrong. If the right point is already there badly put, say it clearly without announcing a correction.
- Write inside the register described below. Those are measurements of this specific section, not preferences — match them.
- You are allowed to be unremarkable. A short, ordinary, useful reply is a valid answer and often the right one.`;

// ---------------------------------------------------------------------------
// The library-backed prompt
// ---------------------------------------------------------------------------

export const BRAND_SYSTEM = `You write replies on a sports betting forum on behalf of a client. You are given what the client can genuinely help with, and you write the reply that helps.

You are NOT advertising. A reply that would not be worth posting without a campaign behind it is a bad reply, and you should write a worse-for-marketing, better-for-the-reader version instead.

${HONESTY_RULE}

${NO_INVENTION_RULE}

You will be asked for one or two KINDS of reply. Each kind has its own rules, given below. Write each requested kind exactly once.

${SHARED_RULES}

Output STRICT JSON:
{"variants": [{"kind": "<the kind you were asked for>", "text": "<the reply>", "claimIds": ["<ids of the claims you relied on>"]}]}

claimIds must list every CLAIM whose fact you stated. If you stated no facts from the claim list, use an empty array. Never cite a claim id you were not given.
No prose, no markdown, no explanation outside the JSON.`;

const KIND_RULES: Record<VariantKind, string> = {
  'brand-mentioned': `KIND "brand-mentioned" — you may name the client.
- Name them only where naming them carries INFORMATION: a mechanism, a documented behaviour, a specific thing they do. "Northwind does X, which is what you are asking about" is a reason. "Northwind is great" is an advert.
- Every fact you state about the client must come from the CLAIMS list, and you must cite its id. No claim, no fact.
- Mention them once. A reply that names them twice reads as a placement.
- Do not include a URL unless the LINKS line below says links are permitted.`,

  'brand-informed': `KIND "brand-informed" — the client's knowledge, and their name nowhere.
- Do not name the client. Not once, not as "a book I know", not as a hint.
- USE the material to work out WHICH PART of the conversation is worth answering, what the person is really asking, and what the right words for it are. That is what this variant is for.
- DO NOT restate a CLAIM as if it were general knowledge. Ask yourself of every factual sentence: "would this still be safely true if I did not know which company we meant?" If the answer is no, it is that company's fact and it does not belong in this reply.
- HEDGING DOES NOT FIX IT. "Most books usually do X" where X is one company's own procedure is worse than naming them, not better — the reader now believes it of the whole market.
- Your three options for such a fact: write something genuinely general instead, leave it for the brand-mentioned reply where it can be attributed, or leave it out. All three are fine. Writing less is fine.
- Never include a URL.`,

  'community-only': `KIND "community-only" — an ordinary useful post.
- You have been given no client material and you must not ask for any. Answer from what is in the thread and from general reasoning about betting.
- Name no brand, book, operator or product at all.
- Never include a URL.
- If it would not be worth posting without a campaign behind it, it is not worth posting. Write the version that would be.`,
};

function trim(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface VariantPromptInput {
  sectionName: string;
  threadTitle: string;
  /** The post being answered. */
  postBody: string;
  /** Neighbouring posts, oldest first, for context. */
  context?: string[];
  /** The intent classifier's one-sentence reading of what they want. */
  problem: string;
  register: SectionRegister;
  length: { min: number; max: number; target: number };
  /** Matched assets, best first. Only what retrieval returned — never the
   *  whole library. */
  assets: readonly Asset[];
  /** Live claims for those assets. May be empty: an asset with no live claim is
   *  usable and not citable, and brand-informed can still be written from it. */
  claims: readonly PromptClaim[];
  /** The client's own names, so brand-mentioned can use them and the compliance
   *  gate can look for them. */
  brandNames: readonly string[];
  /** True only in a section tagged `promote`. */
  linksPermitted: boolean;
}

function renderAssets(assets: readonly Asset[]): string {
  if (!assets.length) return '(none)';
  return assets
    .slice(0, 5)
    .map(
      (a, i) =>
        `[A${i + 1}] ${a.title} (${a.kind})\n  what it is for: ${trim(a.purpose, 300)}\n  problems it addresses: ${a.problems.slice(0, 6).join('; ') || '(none listed)'}${
          a.exclusions.length ? `\n  NOT relevant to: ${a.exclusions.slice(0, 4).join('; ')}` : ''
        }`,
    )
    .join('\n\n');
}

function renderClaims(claims: readonly PromptClaim[]): string {
  if (!claims.length) {
    // Said out loud rather than left as an empty section. A model shown a
    // heading with nothing under it fills the gap; a model told there is
    // nothing to cite writes a reply that does not need one.
    return '(none — this client has NO verified facts available for this thread. You may not state any fact about them. Write a reply that does not need one, or write less.)';
  }
  return claims
    .map((c) => `[${c.claimId}] ${trim(c.text, 300)}\n  from: ${c.assetTitle}`)
    .join('\n');
}

function renderContext(context: string[] | undefined): string[] {
  const items = (context ?? []).filter((c) => c.trim()).slice(0, 3);
  if (!items.length) return [];
  return ['EARLIER IN THE THREAD:', ...items.map((c) => `- ${trim(c, 400)}`), ''];
}

/**
 * The prompt for the variants that draw on the library.
 *
 * `kinds` must contain only library-backed kinds; passing community-only here
 * is a programming error and the function says so rather than quietly writing a
 * community reply with the client's help centre in its context.
 */
export function buildBrandPrompt(
  kinds: readonly VariantKind[],
  input: VariantPromptInput,
): { system: string; user: string } {
  const asked = kinds.filter(isLibraryBacked);
  if (asked.length === 0 || asked.length !== kinds.length) {
    throw new Error('buildBrandPrompt takes brand-mentioned and brand-informed only');
  }

  const user = [
    `SECTION: ${input.sectionName}`,
    `THREAD: ${trim(input.threadTitle, 300)}`,
    '',
    ...renderContext(input.context),
    'THE POST YOU ARE ANSWERING:',
    `"""\n${trim(input.postBody, 2000)}\n"""`,
    '',
    `WHAT THEY WANT: ${input.problem}`,
    '',
    `THE CLIENT IS CALLED: ${input.brandNames.join(', ') || '(not configured — do not name them)'}`,
    `LINKS: ${input.linksPermitted ? 'permitted in this section, and only if they asked for a resource' : 'NOT permitted. Do not include a URL.'}`,
    '',
    'WHAT THE CLIENT HAS THAT IS RELEVANT:',
    renderAssets(input.assets),
    '',
    'VERIFIED CLAIMS — the ONLY facts about the client you may state:',
    renderClaims(input.claims),
    '',
    'HOW PEOPLE WRITE HERE (measured from this thread — copy it):',
    ...renderRegister(input.register, input.length),
    '',
    'WRITE THESE KINDS:',
    ...asked.map((k) => KIND_RULES[k]),
    '',
    `Respond with JSON: {"variants": [${asked.map((k) => `{"kind": "${k}", "text": "…", "claimIds": []}`).join(', ')}]}`,
  ].join('\n');

  return { system: BRAND_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// The community-only prompt — deliberately knows nothing about the client
// ---------------------------------------------------------------------------

export const COMMUNITY_SYSTEM = `You write one reply on a sports betting forum, as an ordinary member of it.

There is no client, no product and no angle. Somebody asked something and you are answering it because you know something useful about it.

${HONESTY_RULE}

${NO_INVENTION_RULE}

- Name no brand, book, sportsbook, operator, app or product.
- Never include a URL.
- If the honest answer is "it depends, and here is what it depends on", write that.

${SHARED_RULES}

Output STRICT JSON: {"variants": [{"kind": "community-only", "text": "<the reply>", "claimIds": []}]}
No prose, no markdown, no explanation outside the JSON.`;

/**
 * The community-only prompt.
 *
 * ⚠️ IT RECEIVES NO ASSETS AND NO CLAIMS, and that omission is the feature. See
 * the two-calls note at the top of this file: a reply that "does not draw on the
 * library" has to be written by something that has not read it.
 */
export function buildCommunityPrompt(input: VariantPromptInput): { system: string; user: string } {
  const user = [
    `SECTION: ${input.sectionName}`,
    `THREAD: ${trim(input.threadTitle, 300)}`,
    '',
    ...renderContext(input.context),
    'THE POST YOU ARE ANSWERING:',
    `"""\n${trim(input.postBody, 2000)}\n"""`,
    '',
    `WHAT THEY WANT: ${input.problem}`,
    '',
    'HOW PEOPLE WRITE HERE (measured from this thread — copy it):',
    ...renderRegister(input.register, input.length),
    '',
    KIND_RULES['community-only'],
    '',
    'Respond with JSON: {"variants": [{"kind": "community-only", "text": "…", "claimIds": []}]}',
  ].join('\n');

  return { system: COMMUNITY_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strip the wrappers models add when told not to. */
function unwrap(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  t = t.replace(/^(?:variant|reply|option)\s*\d*\s*[:.)-]\s*/i, '');
  t = t.replace(/^\d+[.)]\s+/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Read the model's answer, or drop what cannot be read.
 *
 * ⚠️ A VARIANT OF A KIND THAT WAS NOT ASKED FOR IS DISCARDED, NOT RELABELLED.
 * A model that returns a `brand-mentioned` reply when only `brand-informed` was
 * requested has not misfiled a good draft — it has written the one thing the
 * eligibility mask said may not be written here, and keeping it under a
 * different label would smuggle it past the mask that exists to stop it.
 *
 * Never throws. An empty array is a legitimate outcome meaning "nothing usable
 * was written", which downstream reads as NONE with no critic call.
 */
export function parseVariants(raw: unknown, asked: readonly VariantKind[]): VariantDraft[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { variants?: unknown }).variants)
      ? (raw as { variants: unknown[] }).variants
      : null;
  if (!list) return [];

  const wanted = new Set(asked);
  const seen = new Set<VariantKind>();
  const out: VariantDraft[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;

    const kind = typeof o.kind === 'string' ? (o.kind.trim().toLowerCase() as VariantKind) : null;
    if (!kind || !wanted.has(kind) || seen.has(kind)) continue;

    const text = typeof o.text === 'string' ? unwrap(o.text) : '';
    if (!text) continue;

    const claimIds = Array.isArray(o.claimIds)
      ? o.claimIds
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map((c) => c.trim())
          .filter((c, i, all) => all.indexOf(c) === i)
          .slice(0, 12)
      : [];

    seen.add(kind);
    out.push({ kind, text, words: countWords(text), claimIds });
  }

  return out;
}
