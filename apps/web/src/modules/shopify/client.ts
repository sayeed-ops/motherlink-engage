// Who the client is, in this module's own words.
//
// PURE. Validation included — these fields reach a prompt, and two of them
// (`brandMentionStyle`, `forbiddenPhrases`) are the only thing standing between
// a generated reply and a sentence the client would not sign.
//
// ════════════════════════════════════════════════════════════════════════════
// ITS OWN COPY, AND A DELIBERATE SYNC RATHER THAN A SHARED RECORD
//
// Reddit keeps the same fields in `projects/{id}/modules/reddit`. Reading those
// directly was the cheaper option and is the wrong one: it makes a Shopify-only
// project fill in a form labelled Reddit, and it silently couples two platforms
// that may want to sound different — a merchant forum is not a subreddit, and
// the register that works in one can read as corporate in the other.
//
// So this is a copy, and `syncedFromRedditAtMs` records when it was last pulled
// across. A copy nobody can tell is stale is worse than no copy, which is why
// the timestamp is stored rather than the fact of having synced once.
// ════════════════════════════════════════════════════════════════════════════

export interface ShopifyClientProfile {
  /** What the company does, in a sentence or two. */
  companyDescription: string;
  /** Who they serve. Shapes register more than content. */
  targetCustomer: string;
  /** What they actually sell. */
  productService: string;
  /**
   * How the client may be named when a reply names them.
   *
   * Free text on purpose: "never claim we are the cheapest", "always say
   * 'we' not 'they'", "link the docs page, not the pricing page". A dropdown
   * could not hold any of those.
   */
  brandMentionStyle: string;
  /**
   * ⚠️ THE ONE FIELD THAT IS CHECKED RATHER THAN SUGGESTED. Everything else
   * here is context a model may weigh; these are strings a reply may not
   * contain, enforced after generation. A prompt instruction is a request; this
   * is a rule.
   */
  forbiddenPhrases: string[];
  /** When these fields were last copied from the Reddit module. Null means
   *  never — they were typed here. */
  syncedFromRedditAtMs: number | null;
}

export function emptyClientProfile(): ShopifyClientProfile {
  return {
    companyDescription: '',
    targetCustomer: '',
    productService: '',
    brandMentionStyle: '',
    forbiddenPhrases: [],
    syncedFromRedditAtMs: null,
  };
}

const text = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

export function normaliseClientProfile(raw: unknown): ShopifyClientProfile {
  const r = (raw ?? {}) as Partial<ShopifyClientProfile>;
  const ms = Number(r.syncedFromRedditAtMs);

  return {
    companyDescription: text(r.companyDescription, 2000),
    targetCustomer: text(r.targetCustomer, 1000),
    productService: text(r.productService, 1000),
    brandMentionStyle: text(r.brandMentionStyle, 2000),
    forbiddenPhrases: Array.isArray(r.forbiddenPhrases)
      ? r.forbiddenPhrases
          .map((p) => text(p, 200))
          .filter(Boolean)
          // Case-insensitive dedup: "Best in class" and "best in class" are one
          // rule, and the check below is case-insensitive anyway.
          .filter((p, i, all) => all.findIndex((o) => o.toLowerCase() === p.toLowerCase()) === i)
          .slice(0, 100)
      : [],
    syncedFromRedditAtMs: Number.isFinite(ms) && ms > 0 ? ms : null,
  };
}

/**
 * Is there enough here to let a reply name the client?
 *
 * Deliberately about the DESCRIPTION rather than the style: a reply that names
 * a company nobody has described will describe it wrongly. The mention style
 * may legitimately be empty — "no particular rules" is an answer.
 */
export const canDescribeClient = (p: ShopifyClientProfile): boolean =>
  p.companyDescription.trim().length > 0 && p.productService.trim().length > 0;

/**
 * Forbidden phrases found in a piece of text.
 *
 * ⚠️ CASE-INSENSITIVE AND SUBSTRING, NOT WORD-BOUNDARY. A client who forbids
 * "guaranteed" means the word wherever it appears, including inside
 * "guaranteed-best" — and a rule that a hyphen defeats is not a rule. The cost
 * is a false positive on an innocent substring, which is the right way round:
 * the reply is reviewed by a person either way, and a phrase flagged wrongly
 * costs a glance while one missed costs the client's name.
 */
export function findForbidden(text: string, phrases: readonly string[]): string[] {
  const hay = text.toLowerCase();
  return phrases.filter((p) => p.trim() && hay.includes(p.trim().toLowerCase()));
}

/** The Reddit module's shape, as far as this module cares. Structural rather
 *  than imported so a Reddit refactor cannot break the Shopify build. */
export interface RedditClientFields {
  companyDescription?: unknown;
  targetCustomer?: unknown;
  productService?: unknown;
  brandMentionStyle?: unknown;
  forbiddenPhrases?: unknown;
}

/** The fields a pasted JSON may set. Anything else in it is reported back as
 *  ignored rather than silently dropped. */
const IMPORTABLE = ['companyDescription', 'targetCustomer', 'productService', 'brandMentionStyle', 'forbiddenPhrases'] as const;

export interface ClientImport {
  /** The form after the JSON was laid over it. Not saved — a person reviews it
   *  and presses Save, the same as Reddit's "Fill form". */
  client: ShopifyClientProfile;
  /** Which of our fields the JSON actually set. */
  filled: string[];
  /** Keys it carried that belong somewhere else — `targetSubreddits`,
   *  `keywords`, `name`. Named so the same JSON that set up Reddit can be pasted
   *  here without anyone wondering where the subreddits went. */
  ignored: string[];
}

export class ClientImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientImportError';
  }
}

/**
 * Pasted JSON → the client form, laid over what is already there.
 *
 * ⚠️ A FIELD THE JSON DOES NOT MENTION KEEPS ITS VALUE. This is the one place
 * an import is a merge rather than a replacement, because it lands in a form a
 * person is about to review — unlike "Copy from Reddit", which is a sync and
 * must not leave anyone unable to say where a value came from.
 *
 * Fenced JSON is accepted: every model fences it, and the prompt we hand out
 * asks for exactly one fenced block.
 */
export function clientFromJson(text: string, current: ShopifyClientProfile): ClientImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
  } catch {
    throw new ClientImportError('That is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClientImportError('Expected one JSON object, like the schema in the copied prompt.');
  }

  const r = raw as Record<string, unknown>;
  const filled = IMPORTABLE.filter((k) =>
    k === 'forbiddenPhrases' ? Array.isArray(r[k]) : typeof r[k] === 'string' && (r[k] as string).trim() !== '',
  );
  if (!filled.length) {
    throw new ClientImportError(
      `None of the client fields were in it. Expected at least one of: ${IMPORTABLE.join(', ')}.`,
    );
  }

  const merged: Record<string, unknown> = { ...current };
  for (const k of filled) merged[k] = r[k];

  return {
    // Normalised, so a pasted list of forty duplicate phrases arrives as the
    // form would store it rather than as the model wrote it.
    client: { ...normaliseClientProfile(merged), syncedFromRedditAtMs: current.syncedFromRedditAtMs },
    filled: [...filled],
    ignored: Object.keys(r).filter((k) => !(IMPORTABLE as readonly string[]).includes(k)),
  };
}

/**
 * Reddit's client fields → ours.
 *
 * The sync is a REPLACEMENT, not a merge, and that is the honest behaviour: a
 * merge would leave the operator unable to say which half of the result came
 * from where, and "sync" that quietly keeps some old values is the kind of
 * thing nobody notices until a forbidden phrase is missing from the list.
 */
export function fromReddit(raw: RedditClientFields, nowMs: number): ShopifyClientProfile {
  return {
    ...normaliseClientProfile(raw),
    syncedFromRedditAtMs: nowMs,
  };
}
