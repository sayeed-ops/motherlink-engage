// The interchange with an outside researcher: a brief out, structured findings
// back.
//
// PURE. Text generation and defensive parsing; nothing here fetches anything.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO PROBLEMS, DELIBERATELY SEPARATED
//
//   KNOWLEDGE DISCOVERY   — what might this client have that helps?
//   EVIDENCE ACQUISITION  — what public source proves it?
//
// The old design fused them: discovery WAS crawling the client's site, so a
// client whose site refuses our server had no onboarding at all. Stake returns
// 403 to every request for stake.com, including robots.txt, which would have
// made the flagship demo client unonboardable.
//
// Split, they are both tractable. Discovery can come from a search-enabled model
// outside this stack, from a person who knows the client, or from pasted
// material. Evidence can come from whichever of those happens to carry a
// checkable source. Neither depends on the client's homepage answering us.
// ════════════════════════════════════════════════════════════════════════════
//
// ════════════════════════════════════════════════════════════════════════════
// THE CLIENT IS DATA. There is no client-specific anything in this file — no
// names, no verticals, no categories, no field names. Swapping the client is
// changing two strings on a form, and the brief reshapes itself around whatever
// the conversation map found.
// ════════════════════════════════════════════════════════════════════════════

import type { AssetKind } from '@/modules/knowledge/types';
import { ASSET_KINDS } from '@/modules/knowledge/types';
import type { CoversNeed } from './conversationMap';

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export interface BriefInput {
  clientName: string;
  clientDomain: string;
  needs: readonly CoversNeed[];
  /** Where the audience was measured, for the researcher's context. */
  postsAnalysed: number;
  sections: readonly string[];
}

export const RESEARCH_SCHEMA_VERSION = 'covers-research-v1';

/**
 * The JSON shape the researcher is asked to return.
 *
 * Embedded in the brief verbatim rather than described in prose, because a
 * model given a shape returns that shape and a model given a description
 * returns its own. Kept small: every field here maps onto something the asset
 * library already stores, so nothing has to be invented on import.
 */
export const RESEARCH_SCHEMA = `{
  "client": "<the client name>",
  "generatedFor": "covers",
  "capabilities": [
    {
      "title": "<short name of the tool, feature, resource or documented behaviour>",
      "whatItIs": "<one sentence: what kind of thing this is>",
      "whatItDoes": "<one or two sentences: what it actually does>",
      "whyUseful": "<why a bettor in the conversations below would care>",
      "coversNeeds": ["<needId from the list above, or omit if none>"],
      "conversationExamples": ["<phrases a forum post would contain when this is relevant>"],
      "problemsSolved": ["<the problem in the bettor's words>"],
      "notRelevantWhen": ["<when mentioning this would be forced or wrong>"],
      "clientSpecificFacts": [
        { "text": "<a single factual statement about the client>",
          "quote": "<the sentence on the source page that supports it, verbatim>",
          "sourceUrl": "<the page it came from>" }
      ],
      "sources": ["<public URLs that evidence this capability>"],
      "verificationState": "verified | unverified",
      "confidence": "high | medium | low",
      "notes": "<anything a reviewer should know>"
    }
  ]
}`;

/**
 * The brief, as text a person pastes into a search-enabled assistant.
 *
 * ⚠️ IT ASKS FOR CAPABILITIES, NOT FOR SUPPORT POLICY. The old deep interview
 * generated ~100 generic business questions and the answers were dominated by
 * password resets and KYC documents — true, useless in a betting thread, and
 * they crowded out everything worth knowing. The brief is built from what the
 * forum actually discusses, so the questions are the forum's questions.
 */
export function buildResearchBrief(input: BriefInput): string {
  const client = input.clientName.trim() || '<client>';
  const domain = input.clientDomain.trim();

  // ⚠️ THE WEBSITE LEADS, NOT THE NAME. A name can be ambiguous, shared, or a
  // workspace label somebody typed in a hurry — the first version of this brief
  // opened with "Client: test project", which told an outside researcher
  // nothing. A domain identifies a company unambiguously, so it goes first and
  // the researcher is told to confirm who this is from it before answering.
  const header = [
    'CLIENT RESEARCH BRIEF',
    '',
    domain
      ? `THE CLIENT: ${client}\nWEBSITE: ${domain}\n\nStart by visiting that website and confirming which company this is —\nthe name above may be shortened or informal. Everything below is about\nthat company.`
      : `THE CLIENT: ${client}\n\n⚠️ No website was supplied. If this name is ambiguous, say so rather than\nresearching the wrong company.`,
    '',
    'AUDIENCE: the Covers.com sports betting forum',
    '',
    `We read ${input.postsAnalysed} real discussions across ${input.sections.length} section(s) ` +
      `(${input.sections.join(', ') || 'n/a'}) and found the recurring needs below.`,
    '',
    'For EACH need, research what this client genuinely offers that would help.',
    'Prefer things a bettor can USE or LEARN FROM: tools, calculators, trackers,',
    'dashboards, public data, statistics, research, guides, documented mechanics,',
    'product features. Support and account policy count only where they answer a',
    'question the forum actually asks.',
    '',
    'IT IS A CORRECT ANSWER TO SAY THE CLIENT HAS NOTHING USEFUL FOR A NEED.',
    'Do not force a connection. An empty result for a need is a finding.',
    '',
  ].join('\n');

  const needs = input.needs.length
    ? input.needs
        .map((n, i) =>
          [
            `NEED ${i + 1} — ${n.title}   [needId: ${n.needId}]`,
            `  What people are trying to do: ${n.whatPeopleWant}`,
            n.phrases.length ? `  Things people say: ${n.phrases.map((p) => `"${p}"`).join(', ')}` : '',
            n.valueAreas.length ? `  Kinds of thing that could help: ${n.valueAreas.join(', ')}` : '',
            `  Seen in: ${n.posts} post(s) across ${n.threads} thread(s)`,
            n.examples.length ? `  Examples:\n${n.examples.map((e) => `    - ${e}`).join('\n')}` : '',
            '',
            `  RESEARCH OBJECTIVE: does ${client} provide any tool, feature, dashboard,`,
            `  tracker, data source, guide, documented behaviour or public resource that`,
            `  helps with this? For each thing found, say what it does, why it helps this`,
            `  need, whether it is public or customer-only, its limitations, and the`,
            `  source that evidences it.`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n')
    : '(No needs have been mapped yet — build the conversation map first.)';

  // ── the reverse pass, and it costs nothing extra ───────────────────────────
  // Covers → Client finds what the sample asked about. Client → Covers stops the
  // sample becoming the ceiling of what the system can know. Asking for both in
  // one brief means one round trip rather than two.
  const reverse = [
    '',
    'THEN, SEPARATELY — the other direction:',
    `List anything else genuinely useful that ${client} offers which the needs above`,
    'did not cause you to look for. Free tools, calculators, trackers, public data,',
    'research, unusual features, educational material. For each one, say which of the',
    'needs above it might serve, or "none" if it serves none of them.',
    '',
    'RULES',
    '- Every capability must have at least one public source URL you actually found.',
    '- If you believe something exists but cannot find a source, include it with',
    '  "verificationState": "unverified" and say so in notes. Do not drop it and do',
    '  not dress it up.',
    '- "clientSpecificFacts" must quote the source sentence verbatim. If you cannot',
    '  quote it, leave the array empty rather than paraphrasing into a fact.',
    '- Do not invent figures, dates, limits or percentages.',
    '',
    'Return JSON ONLY, in exactly this shape:',
    '',
    RESEARCH_SCHEMA,
  ].join('\n');

  return `${header}${needs}${reverse}\n`;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

export type VerificationState = 'verified' | 'unverified';
export type Confidence = 'high' | 'medium' | 'low';

/** One researched capability, parsed and cleaned. */
export interface ResearchCapability {
  title: string;
  whatItIs: string;
  whatItDoes: string;
  whyUseful: string;
  /** Need ids from the map. Unknown ids are dropped rather than invented. */
  coversNeeds: string[];
  conversationExamples: string[];
  problemsSolved: string[];
  notRelevantWhen: string[];
  facts: { text: string; quote: string; sourceUrl: string }[];
  sources: string[];
  verificationState: VerificationState;
  confidence: Confidence;
  notes: string;
}

export interface ImportResult {
  client: string;
  capabilities: ResearchCapability[];
  /** The paste was not valid JSON and had to be repaired to be read. Reported so
   *  a person can glance over what came out. */
  repaired: boolean;
  /**
   * Need ids the research referred to that the map does not contain.
   *
   * ⚠️ REPORTED, NOT SWALLOWED. They are dropped — inventing a link to a need
   * that does not exist would overstate coverage — but dropping them silently
   * means "8 of 14 needs covered" can quietly be wrong, and the operator would
   * have no way to tell a researcher that used stale need ids from one whose
   * findings genuinely did not match.
   */
  unknownNeeds: string[];
  /** Rows that could not be read, with why. Reported rather than silently
   *  dropped — a researcher whose output half-parses should find out. */
  rejected: { index: number; reason: string }[];
}

const strings = (v: unknown, max: number, cap: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, cap))
        .filter((x, i, all) => all.indexOf(x) === i)
        .slice(0, max)
    : [];

const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.trim().slice(0, cap) : '');

/**
 * Read a researcher's JSON, or refuse the parts that cannot be read.
 *
 * ⚠️ NEVER THROWS, and a malformed row is dropped with a reason rather than
 * repaired. The alternative — filling gaps with defaults — produces a
 * confident-looking capability nobody researched, which is the same failure as
 * a model inventing one.
 *
 * ⚠️ `verificationState` DEFAULTS TO `unverified`. A row that does not say is a
 * row nobody checked, and the safe reading of silence is that no evidence
 * exists. Verified additionally requires at least one source URL — a claim of
 * verification with nothing to point at is not verification.
 */
export function parseResearchImport(raw: unknown, knownNeedIds: readonly string[] = []): ImportResult {
  const read = typeof raw === 'string' ? safeJson(raw) : { value: raw, repaired: false };
  const root = read.value;

  if (!root || typeof root !== 'object') {
    return {
      client: '',
      capabilities: [],
      repaired: false,
      unknownNeeds: [],
      rejected: [
        {
          index: -1,
          reason:
            'The paste is not valid JSON, and could not be repaired. The usual cause is a quotation ' +
            'mark inside a sentence — check for a stray " in the middle of a "quote" or "notes" value.',
        },
      ],
    };
  }

  const o = root as Record<string, unknown>;
  const list = Array.isArray(o.capabilities)
    ? o.capabilities
    : Array.isArray(root)
      ? (root as unknown[])
      : null;

  if (!list) {
    return {
      client: str(o.client, 120),
      capabilities: [],
      repaired: read.repaired,
      unknownNeeds: [],
      rejected: [{ index: -1, reason: 'The JSON parsed, but there is no "capabilities" array in it.' }],
    };
  }

  const known = new Set(knownNeedIds);
  const capabilities: ResearchCapability[] = [];
  const rejected: ImportResult['rejected'] = [];
  const unknownNeeds = new Set<string>();

  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const c = item as Record<string, unknown>;

    const title = str(c.title, 120);
    if (!title) {
      rejected.push({ index, reason: 'no title' });
      return;
    }

    const sources = strings(c.sources, 8, 500).filter(isHttpish);

    // A fact without a verbatim quote cannot be checked against its page, and an
    // unquotable fact is a paraphrase wearing a claim's shape. Dropped here so it
    // never reaches the claim ledger.
    const facts = Array.isArray(c.clientSpecificFacts)
      ? c.clientSpecificFacts
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
          .map((f) => ({
            text: str(f.text, 400),
            quote: str(f.quote, 600),
            sourceUrl: str(f.sourceUrl, 500),
          }))
          .filter((f) => f.text && f.quote && isHttpish(f.sourceUrl))
          .slice(0, 8)
      : [];

    const declared = str(c.verificationState, 20).toLowerCase();
    const verificationState: VerificationState =
      declared === 'verified' && sources.length > 0 ? 'verified' : 'unverified';

    const confidenceRaw = str(c.confidence, 10).toLowerCase();
    const confidence: Confidence =
      confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'low';

    capabilities.push({
      title,
      whatItIs: str(c.whatItIs, 400),
      whatItDoes: str(c.whatItDoes, 600),
      whyUseful: str(c.whyUseful, 600),
      // An unrecognised need id is dropped rather than kept: it would render as
      // a link to a need that does not exist and quietly overstate coverage.
      // Recorded on the way out so the drop is visible.
      coversNeeds: strings(c.coversNeeds, 6, 80).filter((n) => {
        if (known.size === 0 || known.has(n)) return true;
        unknownNeeds.add(n);
        return false;
      }),
      conversationExamples: strings(c.conversationExamples, 12, 80),
      problemsSolved: strings(c.problemsSolved, 8, 200),
      notRelevantWhen: strings(c.notRelevantWhen, 6, 200),
      facts,
      sources,
      verificationState,
      confidence,
      notes: str(c.notes, 1000),
    });
  });

  return {
    client: str(o.client, 120),
    capabilities,
    rejected,
    repaired: read.repaired,
    unknownNeeds: [...unknownNeeds],
  };
}

/**
 * Escape stray double quotes that appear INSIDE a JSON string.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ASSISTANT OUTPUT DOES THIS ROUTINELY, AND IT KILLS THE WHOLE DOCUMENT
 *
 * A real paste contained:
 *
 *   "quote": "The “Vault" is a secured storage solution for your funds."
 *
 * The model opened the inner quotation with a curly “ and closed it with a
 * straight ", which terminates the JSON string early and invalidates the entire
 * file. Seventeen correctly-researched capabilities were rejected because of one
 * punctuation mark in one of them.
 *
 * The repair is unambiguous because JSON's own grammar constrains it: a closing
 * quote is ALWAYS followed by whitespace and then one of , : } ] or the end of
 * input. A quote followed by anything else cannot be a delimiter, so it must be
 * literal content and can be escaped. Nothing valid is changed by this — a
 * document that parses strictly never reaches here.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function repairJsonQuotes(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch !== '"') {
      out += ch;
      continue;
    }

    if (!inString) {
      inString = true;
      out += ch;
      continue;
    }

    // Inside a string and looking at a quote: is it the delimiter, or content?
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const next = j < text.length ? text[j] : '';

    if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
      inString = false;
      out += ch;
    } else {
      // Cannot be a delimiter — the grammar has no production for it.
      out += '\\"';
    }
  }

  return out;
}

/** Trailing commas before a closing brace or bracket. The other thing models do. */
function dropTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

export interface JsonReadResult {
  value: unknown;
  /** True when strict parsing failed and a repair was needed. Surfaced to the
   *  operator rather than hidden — a document that had to be repaired is one to
   *  glance over before approving what came out of it. */
  repaired: boolean;
}

function safeJson(text: string): JsonReadResult {
  const trimmed = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();

  try {
    return { value: JSON.parse(trimmed), repaired: false };
  } catch {
    // fall through
  }

  // A researcher often returns prose around the JSON. Take the outermost braces
  // rather than refusing the whole paste.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const sliced = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;

  try {
    return { value: JSON.parse(sliced), repaired: first > 0 || last < trimmed.length - 1 };
  } catch {
    // fall through
  }

  for (const candidate of [repairJsonQuotes(sliced), dropTrailingCommas(repairJsonQuotes(sliced))]) {
    try {
      return { value: JSON.parse(candidate), repaired: true };
    } catch {
      // keep trying
    }
  }

  return { value: null, repaired: false };
}

function isHttpish(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

// ---------------------------------------------------------------------------
// Becoming candidate knowledge
// ---------------------------------------------------------------------------

/** What one capability becomes in the library, before anybody approves it. */
export interface CandidateAsset {
  title: string;
  kind: AssetKind;
  purpose: string;
  problems: string[];
  /** ⚠️ THE RETRIEVAL KEY. `conversationExamples` land here because they are the
   *  phrases a thread contains when this is relevant — which is exactly what a
   *  trigger is. The phase-1 importer put whole interview questions here instead
   *  and made 64 assets unreachable by any post; short phrases are the fix. */
  triggers: string[];
  exclusions: string[];
  sourceUrl: string;
  coversNeeds: string[];
  confidence: Confidence;
  notes: string;
  /** Claim PROPOSALS. Never live claims — see below. */
  facts: { text: string; quote: string; sourceUrl: string }[];
  verificationState: VerificationState;
}

/** Guessed from the language, and it drives nothing mechanical — it is for the
 *  person scanning the library. Wrong is cheap; absent is not, because the
 *  ingestion vocabulary expects one. */
function kindOf(c: ResearchCapability): AssetKind {
  const text = `${c.title} ${c.whatItIs} ${c.whatItDoes}`.toLowerCase();
  if (/\b(calculator|tracker|dashboard|tool|simulator|converter)\b/.test(text)) return 'tool';
  if (/\b(guide|how to|explainer|tutorial|academy|learn)\b/.test(text)) return 'guide';
  if (/\b(help|support|faq|documentation|docs)\b/.test(text)) return 'help';
  if (/\b(data|statistics|stats|report|odds feed|research)\b/.test(text)) return 'data';
  if (/\b(terms|policy|limits|rules|licence|license|jurisdiction)\b/.test(text)) return 'policy';
  return (ASSET_KINDS.includes('feature') ? 'feature' : ASSET_KINDS[0]) as AssetKind;
}

/**
 * A researched capability, as candidate library knowledge.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️ NOTHING HERE BECOMES A LIVE CLAIM, EVER
 *
 * `facts` are carried through as PROPOSALS. A claim becomes assertable only
 * when its quote has been checked against text the server read or a named
 * person pasted — which is `textSource` and `attestedBy`, and neither can be
 * satisfied by an import. The rule the phase-1 importer already follows
 * ("claims are never imported") is the same rule, and it is what stops a
 * search-enabled model's confident sentence turning into a fact this system
 * will state in public under a regulated client's name.
 *
 * An imported capability is therefore `status: 'draft'` and — until somebody
 * verifies a source — `textSource: 'unverified'`, which makes it usable for
 * shaping a reply and NOT citable in one. That distinction is the whole
 * knowledge design and this is where it gets enforced on the way in.
 * ════════════════════════════════════════════════════════════════════════════
 */
export function toCandidateAsset(c: ResearchCapability): CandidateAsset {
  const purpose = [c.whatItIs, c.whatItDoes, c.whyUseful].filter(Boolean).join(' ').trim();

  return {
    title: c.title,
    kind: kindOf(c),
    purpose: purpose.slice(0, 800),
    problems: c.problemsSolved,
    triggers: c.conversationExamples,
    exclusions: c.notRelevantWhen,
    sourceUrl: c.sources[0] ?? '',
    coversNeeds: c.coversNeeds,
    confidence: c.confidence,
    notes: c.notes,
    facts: c.facts,
    verificationState: c.verificationState,
  };
}

/** Needs with at least one candidate against them. The coverage number the
 *  review screen reports, computed rather than claimed. */
export function needsCovered(
  candidates: readonly { coversNeeds: readonly string[] }[],
  needIds: readonly string[],
): string[] {
  const hit = new Set(candidates.flatMap((c) => c.coversNeeds));
  return needIds.filter((id) => hit.has(id));
}
