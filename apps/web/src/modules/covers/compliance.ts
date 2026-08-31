// Everything that has to READ the text — run after the variants are written,
// and again on the one that was chosen.
//
// PURE. No clock, no I/O, no model. Every check here is arithmetic or pattern
// matching over data the caller already holds.
//
// ════════════════════════════════════════════════════════════════════════════
// THE RULES ARE DIFFERENT PER VARIANT, AND THAT IS THE WHOLE FILE
//
// forum/reply/validate.ts can ban every brand mention and every link outright,
// because a karma account carries no narrative and there is never a reason for
// one to name a company. Here, one of the three variants exists to name the
// client, and the same check that protects variants 2 and 3 would reject
// variant 1 for doing its job.
//
// So the gate takes the variant kind as an input. `brand-mentioned` may name the
// client once, in a section that permits promotion, citing a live claim for
// every fact it states. `brand-informed` may use the knowledge and name nobody.
// `community-only` may do neither. A check that reads the same for all three
// would have to be the loosest of the three, which is how the strictest rule in
// the system quietly becomes the weakest.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// CLAIM VERIFICATION IS THE POINT
//
// "Never invent the data needed to make a point" is a sentence in a plan until
// something mechanical enforces it. Here is that mechanism: a sentence that
// states a fact must map to a claim that is LIVE, and the variants that cannot
// cite anything may not state facts at all. An expired claim fails exactly as an
// absent one does — a fact nobody has checked in ninety days is a fact nobody
// can defend, and the failure mode it guards against (a regulated client's own
// name attached to a product behaviour that stopped being true) is the most
// expensive one available.
// ════════════════════════════════════════════════════════════════════════════

import {
  extractClaims,
  firstSentence,
  sentencesOf,
  BANNED_OPENERS,
  BANNED_CLOSERS,
  ASSISTANT_TELLS,
  META_TELLS,
  LINK_RE,
  MARKDOWN_STRUCTURE_RE,
} from '@/modules/forum/reply/validate';
import { tokenise } from '@/modules/knowledge/retrieval';
import { countWords, isConfident, type SectionRegister } from './register';
import { checkJurisdiction, type JurisdictionPolicy } from './policy';
import { promotionPermitted, type CoversSection } from './sections';
import type { VariantDraft, VariantKind } from './variants';

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type ComplianceCode =
  // --- mechanical, shared with the Reddit gate ---
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'first-line-too-long'
  | 'banned-opener'
  | 'banned-closer'
  | 'assistant-tell'
  | 'meta'
  | 'formatting'
  // --- the honesty rule ---
  /** Claims to have personally done something. Never permitted, any variant. */
  | 'invented-experience'
  // --- claims ---
  /** States a fact with no live claim behind it. */
  | 'unbacked-assertion'
  /** Says something ABOUT THE CLIENT with no live claim behind it. */
  | 'unbacked-brand-claim'
  /** Cites a claim id that does not exist, or is not live. */
  | 'dead-claim'
  /** A variant that may not attribute, stating something that needs attribution. */
  | 'unattributed-proprietary'
  | 'appeal-to-authority'
  // --- brand and section ---
  /** Names the client in a variant or section where it may not. */
  | 'brand-named'
  /** A brand-mentioned variant that never names the client. */
  | 'brand-absent'
  /** Names the client more than the per-thread ceiling. */
  | 'brand-frequency'
  | 'section-forbids-promotion'
  | 'link-not-permitted'
  // --- jurisdiction, re-checked against the written text ---
  | 'jurisdiction';

export interface ComplianceFailure {
  code: ComplianceCode;
  detail: string;
}

/**
 * A decision for the reviewer, not a failure and never a silent edit.
 *
 * COVERS-PLAN.md § 07: where a material commercial relationship requires
 * disclosure, the draft is FLAGGED with the required wording attached. Quietly
 * appending the disclosure would mean the text a human approved is not the text
 * that gets posted, which defeats the review.
 */
export interface DisclosureFlag {
  required: boolean;
  wording: string;
  why: string;
}

export interface ClaimEvidence {
  claimId: string;
  text: string;
  sourceUrl: string;
  assetId: string;
  assetTitle: string;
  /** The sentence in the reply this claim is standing behind. Empty when the
   *  model declared the claim but no sentence needed it. */
  supports: string;
  /** Was it live at the moment this was checked? */
  live: boolean;
}

export interface ComplianceResult {
  ok: boolean;
  failures: ComplianceFailure[];
  disclosure: DisclosureFlag;
  /**
   * The evidence trail, assembled for the reviewer.
   *
   * This is what the review screen shows beside the draft: for every fact the
   * reply states, the claim that backs it and the page that claim came from. A
   * gate that only returns pass/fail makes a human approve a factual assertion
   * on the system's word, which is the one thing this whole design is built to
   * avoid.
   */
  evidence: ClaimEvidence[];
  /** Sentences that state a fact, with whether each one found backing. */
  assertions: { sentence: string; backedBy: string | null }[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A claim as the gate sees it — with its liveness already decided by
 *  freshness.ts, because that needs a clock and this file has none. */
export interface CheckableClaim {
  claimId: string;
  text: string;
  sourceUrl: string;
  assetId: string;
  assetTitle: string;
  /** `live` only. `expiring` is assertable and is passed as live by the caller;
   *  expired and stale arrive as false and fail. */
  live: boolean;
}

export interface ComplianceContext {
  section: string;
  sections: readonly CoversSection[];
  register: SectionRegister;
  length: { min: number; max: number; target: number };
  /** Every claim that was offered to the generator, live or not. Dead ones are
   *  included ON PURPOSE: a reply citing an expired claim must fail with
   *  `dead-claim` rather than with the vaguer `unbacked-assertion`, because the
   *  two have completely different fixes. */
  claims: readonly CheckableClaim[];
  /** The client's names and aliases. */
  brandNames: readonly string[];
  jurisdiction: JurisdictionPolicy;
  /** The thread text, re-checked for jurisdiction alongside the reply. */
  threadText: string;
  /** Wording to attach when a disclosure is required. Empty disables the flag
   *  rather than inventing standard text — the required words come from the
   *  client's counsel, not from this file. */
  disclosureWording?: string;
}

/** How many times one reply may name the client. One. A reply that names them
 *  twice reads as a placement however well it is written. */
export const BRAND_MENTION_CEILING = 1;

/**
 * How much of a claim's language a sentence must share before we accept that
 * the claim is what backs it.
 *
 * A declared claim id is the model's word; this is the check on it. Half the
 * claim's content tokens present in the sentence is a low bar deliberately — the
 * reply is supposed to paraphrase rather than quote — but it is high enough that
 * citing an unrelated claim to get a number past the gate does not work.
 */
export const CLAIM_OVERLAP = 0.5;

// ---------------------------------------------------------------------------
// The honesty rule, as a validator
// ---------------------------------------------------------------------------

/**
 * First-person experience, which nobody has approved.
 *
 * ⚠️ TARGETED AT VERBS OF DOING, NOT AT THE FIRST PERSON. "I think", "I'd say",
 * "I don't know" are how ordinary people write and banning them would produce
 * the stilted register that gives a machine away. What is banned is the claim to
 * have DONE the thing: used the product, deposited, withdrawn, been a customer.
 * The persona machinery in botTell.ts has the same instinct — an unspecified
 * person claiming first-hand experience is claiming something nobody approved.
 */
const EXPERIENCE_TELLS: readonly [RegExp, string][] = [
  [/\bi(?:'ve| have)\s+(?:been\s+)?(?:used|using|bet|betting|with)\b/i, 'claims to have used a book'],
  [/\bi\s+(?:use|used|bet|wager|deposit|deposited|withdraw|withdrew|cashed)\b/i, 'claims to have done it'],
  [/\bi(?:'ve| have)\s+(?:withdrawn|deposited|cashed out|signed up|joined)\b/i, 'claims an account action'],
  [/\bmy\s+(?:account|withdrawal|deposit|balance|bonus|payout|bet slip|betslip)\b/i, 'claims to hold an account'],
  [/\bwhen i (?:signed up|joined|opened)\b/i, 'claims to have signed up'],
  [/\bi(?:'m| am) a (?:customer|user|member) (?:of|at|with)\b/i, 'claims to be a customer'],
  [/\bin my experience with\b/i, 'claims first-hand experience of a specific thing'],
  [/\bi\s+(?:got|received|was given)\s+(?:the|a|my)\s+(?:bonus|payout|refund)\b/i, 'claims to have received something'],
];

export function inventedExperience(text: string): ComplianceFailure[] {
  return EXPERIENCE_TELLS.filter(([re]) => re.test(text)).map(([, why]) => ({
    code: 'invented-experience' as const,
    detail: `${why} — nobody has recorded this as true`,
  }));
}

// ---------------------------------------------------------------------------
// Claim mapping
// ---------------------------------------------------------------------------

function overlaps(sentence: string, claimText: string): boolean {
  const claimTokens = [...new Set(tokenise(claimText))];
  if (claimTokens.length === 0) return false;
  const inSentence = new Set(tokenise(sentence));
  const hits = claimTokens.filter((t) => inSentence.has(t)).length;
  return hits / claimTokens.length >= CLAIM_OVERLAP;
}

const brandRe = (name: string) =>
  new RegExp(`\\b${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');

function brandMentions(text: string, names: readonly string[]): number {
  let n = 0;
  for (const name of names) {
    if (!name.trim()) continue;
    n += (text.match(brandRe(name)) ?? []).length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Every check that applies to one written variant.
 *
 * FAILURES ARE COLLECTED, NEVER SHORT-CIRCUITED. The review screen has to show
 * an operator every reason at once — "too long" on its own hides that the same
 * reply also stated a number nothing backs, and an operator who fixes the length
 * and re-runs learns the second problem one round trip later.
 */
export function checkCompliance(draft: VariantDraft, ctx: ComplianceContext): ComplianceResult {
  const failures: ComplianceFailure[] = [];
  const add = (code: ComplianceCode, detail: string) => failures.push({ code, detail });

  const body = draft.text.trim();
  const evidence: ClaimEvidence[] = [];
  const assertions: { sentence: string; backedBy: string | null }[] = [];

  const disclosure: DisclosureFlag = {
    required: false,
    wording: ctx.disclosureWording ?? '',
    why: '',
  };

  if (!body) {
    return {
      ok: false,
      failures: [{ code: 'empty', detail: 'nothing to post' }],
      disclosure,
      evidence,
      assertions,
    };
  }

  // ── mechanical: length, measured from this thread rather than chosen ──────
  const words = countWords(body);
  if (words < ctx.length.min) {
    add('too-short', `${words} words, this section runs ${ctx.length.min}–${ctx.length.max}`);
  }
  if (words > ctx.length.max) {
    add('too-long', `${words} words, this section runs ${ctx.length.min}–${ctx.length.max}`);
  }

  const opener = firstSentence(body);
  const openerCap = Math.max(25, Math.round(ctx.length.target * 0.5));
  if (countWords(opener) > openerCap) {
    add('first-line-too-long', `first sentence is ${countWords(opener)} words, cap is ${openerCap}`);
  }
  for (const [re, why] of BANNED_OPENERS) if (re.test(opener)) add('banned-opener', why);
  for (const [re, why] of BANNED_CLOSERS) if (re.test(body)) add('banned-closer', why);
  for (const [re, why] of ASSISTANT_TELLS) if (re.test(body)) add('assistant-tell', why);
  for (const [re, why] of META_TELLS) if (re.test(body)) add('meta', why);

  if (isConfident(ctx.register) && ctx.register.markdownRate < 0.15 && MARKDOWN_STRUCTURE_RE.test(body)) {
    add('formatting', 'bullets or headings in a section that writes plain prose');
  }

  // ── the honesty rule ──────────────────────────────────────────────────────
  failures.push(...inventedExperience(body));

  // ── brand and section ─────────────────────────────────────────────────────
  const mentions = brandMentions(body, ctx.brandNames);
  const mayPromote = promotionPermitted(ctx.sections, ctx.section);

  if (draft.kind === 'brand-mentioned') {
    // Re-checked here even though the mask ran in phase 3, because the mask ran
    // before the text existed and this is the last thing between a model's
    // output and a public forum that treats promotion outside one section as
    // bannable.
    if (!mayPromote) {
      add('section-forbids-promotion', `${ctx.section} does not permit promotion`);
    }
    if (mentions === 0) {
      // Not a harmless mislabel: the whole eligibility chain, the scoring and
      // the reviewer's reading of this draft all rest on the label being true.
      add('brand-absent', 'a brand-mentioned reply that never names the client');
    }
    if (mentions > BRAND_MENTION_CEILING) {
      add('brand-frequency', `names the client ${mentions} times, ceiling is ${BRAND_MENTION_CEILING}`);
    }
    if (mentions > 0 && ctx.disclosureWording?.trim()) {
      disclosure.required = true;
      disclosure.why = 'This reply names the client, and this project has disclosure wording configured.';
    }
  } else if (mentions > 0) {
    add('brand-named', `a ${draft.kind} reply names the client ${mentions} time(s)`);
  }

  // ── links ─────────────────────────────────────────────────────────────────
  if (LINK_RE.test(body)) {
    const permitted = draft.kind === 'brand-mentioned' && mayPromote;
    if (!permitted) {
      add(
        'link-not-permitted',
        draft.kind === 'brand-mentioned'
          ? `links are not permitted in ${ctx.section}`
          : `a ${draft.kind} reply may never link`,
      );
    }
  }

  // ── jurisdiction, against the reply as well as the thread ────────────────
  // The gate ran in phase 3 against the post. It runs again here because the
  // REPLY can put the client in front of somebody the post only hinted at, and
  // because a variant that draws on the client is the only thing that makes the
  // hint matter.
  if (draft.kind !== 'community-only') {
    const verdict = checkJurisdiction(`${ctx.threadText}\n${body}`, ctx.jurisdiction);
    if (verdict.blocked) {
      add('jurisdiction', `places somebody in ${verdict.matched.join(', ')}, which the client cannot serve`);
    }
  }

  // ── claims ────────────────────────────────────────────────────────────────
  const byId = new Map(ctx.claims.map((c) => [c.claimId, c]));

  for (const declared of draft.claimIds) {
    const claim = byId.get(declared);
    if (!claim) {
      add('dead-claim', `cites ${declared}, which was never offered to it`);
      continue;
    }
    if (!claim.live) {
      // Distinguished from `unbacked-assertion` on purpose: the fix for this is
      // re-verifying a page, and the fix for that is writing a different reply.
      add('dead-claim', `cites ${declared} ("${claim.assetTitle}"), which is not live`);
    }
  }

  const canCite = draft.kind === 'brand-mentioned';
  const liveDeclared = draft.claimIds
    .map((id) => byId.get(id))
    .filter((c): c is CheckableClaim => Boolean(c?.live));

  for (const claim of extractClaims(body)) {
    if (claim.defensible) continue;

    // "studies show", "experts agree" — an appeal to a source we do not have,
    // and no claim can rescue it because the reply is citing something else.
    if (/\b(studies|research|experts|statistics|data|science)\b/i.test(claim.text)) {
      add('appeal-to-authority', `cites a source we do not have: "${claim.text.slice(0, 80)}"`);
      assertions.push({ sentence: claim.text, backedBy: null });
      continue;
    }

    if (!canCite) {
      // Variants 2 and 3 have no way to say where a figure came from, so a
      // figure is exactly what they may not state. This is the mechanical form
      // of the plan's rule about smuggling an unattributable proprietary number
      // into a reply that hides its source.
      const looksProprietary = ctx.claims.some((c) => overlaps(claim.text, c.text));
      add(
        looksProprietary ? 'unattributed-proprietary' : 'unbacked-assertion',
        looksProprietary
          ? `states a client-specific fact with no way to attribute it: "${claim.text.slice(0, 80)}"`
          : `states a number as general fact: "${claim.text.slice(0, 80)}"`,
      );
      assertions.push({ sentence: claim.text, backedBy: null });
      continue;
    }

    const backing = liveDeclared.find((c) => overlaps(claim.text, c.text));
    if (!backing) {
      add('unbacked-assertion', `no live claim backs: "${claim.text.slice(0, 80)}"`);
      assertions.push({ sentence: claim.text, backedBy: null });
      continue;
    }

    assertions.push({ sentence: claim.text, backedBy: backing.claimId });
    evidence.push({
      claimId: backing.claimId,
      text: backing.text,
      sourceUrl: backing.sourceUrl,
      assetId: backing.assetId,
      assetTitle: backing.assetTitle,
      supports: claim.text,
      live: true,
    });
  }

  // ── the variants that cannot attribute may not restate a claim ──────────
  //
  // ════════════════════════════════════════════════════════════════════════
  // BRAND-INFORMED MAY USE THE LIBRARY. IT MAY NOT LAUNDER IT.
  //
  // The live run selected a brand-informed reply reading "Some books still offer
  // reload bonuses to existing customers, usually claimed via the promotions
  // page without a code". Every check passed. It carries no number, so
  // extractClaims called it a defensible assertion; it names nobody, so the
  // brand rules did not fire; it is hedged into "some books ... usually", so it
  // reads as general advice.
  //
  // It is not general advice. "Claimed via the promotions page, no code" is one
  // client's procedure, taken from one claim on one of their pages, with the
  // client's name removed and a hedge bolted on. That is the plan's smuggling
  // case exactly, and the hedge makes it worse rather than better: the reader
  // now believes it of the whole market.
  //
  // THE RULE, as the operator stated it: if a factual statement depends on a
  // client claim and would not be safely true without knowing which client we
  // mean, it may not appear in brand-informed. The three ways out are all open —
  // rewrite it as genuinely general advice, move it to brand-mentioned WITH
  // attribution, or drop the statement — and the failure detail names all three.
  //
  // ⚠️ WHAT THIS DOES *NOT* DO: it does not stop brand-informed using the
  // library. Retrieval still decides which asset is relevant, the asset's
  // purpose and problems still shape which part of the conversation gets
  // answered, and the terminology still comes from it. Only RESTATEMENT of a
  // specific claim is blocked. Using an asset to know that a thread about
  // "bonuses that never appear" is really about reload eligibility is the
  // variant working; reproducing the claim's own sentence with the name filed
  // off is not.
  //
  // ⚠️ THE KNOWN COST, stated rather than discovered: a claim that records
  // something UNIVERSALLY true — market mechanics rather than client policy —
  // will also block a genuinely general sentence about it. This is a restatement
  // test, not a test of whether a fact is universal, and nothing here can tell
  // those apart. The failure names the claim it collided with, so a reviewer
  // sees the collision and can retire a claim that was never client-specific.
  // The alternative — letting overlap pass because the fact might be universal —
  // is the failure this whole block exists to stop.
  // ════════════════════════════════════════════════════════════════════════
  if (!canCite) {
    for (const sentence of sentencesOf(body)) {
      // Already reported above, with a more specific code.
      if (assertions.some((a) => a.sentence === sentence)) continue;

      const source = ctx.claims.find((c) => overlaps(sentence, c.text));
      if (!source) continue;

      add(
        'unattributed-proprietary',
        `restates ${source.claimId} ("${source.assetTitle}") as general advice: "${sentence.slice(0, 80)}" — ` +
          'rewrite it as genuinely general, move it to brand-mentioned with attribution, or drop the statement',
      );
      assertions.push({ sentence, backedBy: null });
    }
  }

  // ── every sentence that NAMES the client is a claim about the client ─────
  //
  // ════════════════════════════════════════════════════════════════════════
  // FOUND BY THE FIRST LIVE GENERATION RUN, AND IT WAS THE IMPORTANT ONE
  //
  // A brand-mentioned reply reading "Northwind still runs reload bonuses for
  // existing customers, claimed from the promotions page without a code" passed
  // this gate reporting "states no facts". Every check above it was working:
  // extractClaims classifies a sentence as needing backing when it carries a
  // NUMBER, an appeal to authority, or a specific measurement, and that sentence
  // carries none of them. It is prose. It is also a precise assertion about a
  // regulated client's product, published under their name, and the plan's rule
  // is "every factual assertion maps to a live claim id" — not every numeric one.
  //
  // The numeric heuristic is right for the Reddit path, where the account names
  // no company and the risk is an invented statistic. It is the wrong instrument
  // here, where the risk is a confident qualitative statement about a product
  // that stopped behaving that way. So: NAMING THE CLIENT AND SAYING SOMETHING
  // IS ITSELF THE ASSERTION, and it needs a live claim behind it whether or not
  // a number appears in it.
  //
  // Only `brand-mentioned` reaches this — the other two may not name the client
  // at all, and `brand-named` above has already failed them if they did.
  // ════════════════════════════════════════════════════════════════════════
  if (draft.kind === 'brand-mentioned') {
    for (const sentence of sentencesOf(body)) {
      if (brandMentions(sentence, ctx.brandNames) === 0) continue;
      // Already handled above, with a more specific code.
      if (assertions.some((a) => a.sentence === sentence)) continue;

      const backing = liveDeclared.find((c) => overlaps(sentence, c.text));
      if (!backing) {
        add(
          'unbacked-brand-claim',
          `says something about the client with no live claim behind it: "${sentence.slice(0, 80)}"`,
        );
        assertions.push({ sentence, backedBy: null });
        continue;
      }

      assertions.push({ sentence, backedBy: backing.claimId });
      evidence.push({
        claimId: backing.claimId,
        text: backing.text,
        sourceUrl: backing.sourceUrl,
        assetId: backing.assetId,
        assetTitle: backing.assetTitle,
        supports: sentence,
        live: true,
      });
    }
  }

  // Claims the model declared that no assertion needed. Kept in the evidence
  // trail rather than dropped: "it read this and did not need to state it" is
  // useful to a reviewer, and its absence would make the trail look incomplete.
  for (const claim of liveDeclared) {
    if (evidence.some((e) => e.claimId === claim.claimId)) continue;
    evidence.push({
      claimId: claim.claimId,
      text: claim.text,
      sourceUrl: claim.sourceUrl,
      assetId: claim.assetId,
      assetTitle: claim.assetTitle,
      supports: '',
      live: true,
    });
  }

  return { ok: failures.length === 0, failures, disclosure, evidence, assertions };
}

/** Sentence count, exposed for the review screen's "what did it assert" panel. */
export function sentenceCount(text: string): number {
  return sentencesOf(text).length;
}
