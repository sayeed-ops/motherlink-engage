// The client asset library and the claim ledger.
//
// PURE — no 'server-only', no fetch, no Firestore. Retrieval and the freshness
// rules are tested directly, and the review UI renders these same shapes, so
// this file must import nothing that cannot run in a browser. Same convention as
// modules/forum/reader/types.ts.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS AT ALL, WHEN `sources` ALREADY DOES
//
// `projects/{id}/sources` is free text a person typed: a title, a summary, some
// bullet points. That is enough to decide whether a Reddit post is worth
// answering, which is all it was ever asked to do.
//
// It is not enough to write "Northwind's help documentation says cashout can
// disappear when the market suspends" and be certain that is true. Three things
// are missing and none of them can be retrofitted onto a summary field:
//
//   1. WHEN NOT TO USE IT. A source says what it covers. An asset also says what
//      it does not, and `exclusions` is the only field here that can veto a
//      match outright — see retrieval.ts. A library that can only say yes will
//      eventually say yes to everything.
//   2. AN ASSERTABLE FACT, SEPARATELY FROM THE THING IT CAME FROM. "Cashout
//      exists" is an asset. "Cashout can disappear when the market suspends" is
//      a claim, and a reply may state it only because a specific sentence on a
//      specific page said so on a specific date.
//   3. AN EXPIRY. Help-centre pages change without announcement. A fact with no
//      verified date is a fact nobody can defend three months later.
//
// The two are deliberately separate documents rather than an array on the asset:
// claims expire and are re-verified individually, and a claim whose page has
// changed must be able to go stale without dragging the whole asset out of use.
// ════════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** What kind of thing this is. Drives nothing mechanical — it is for the human
 *  scanning the library, and for the ingestion prompt to have a vocabulary. */
export type AssetKind =
  | 'feature' // a thing in the product: cashout, bet tracker, live streaming
  | 'tool' // something the client publishes for people to use
  | 'guide' // explanatory content: what margin is, how odds work
  | 'help' // help-centre / support documentation
  | 'data' // a published figure, table or report
  | 'policy'; // terms, limits, jurisdictions, payouts

export const ASSET_KINDS: readonly AssetKind[] = [
  'feature',
  'tool',
  'guide',
  'help',
  'data',
  'policy',
] as const;

export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  feature: 'Product feature',
  tool: 'Tool',
  guide: 'Guide',
  help: 'Help article',
  data: 'Published data',
  policy: 'Policy / terms',
};

/**
 * `draft` — the model proposed it from a crawled page and no human has agreed.
 * `active` — a person confirmed it. ONLY active assets are ever retrieved.
 * `retired` — deliberately withdrawn; kept so old drafts still explain themselves.
 *
 * The draft step is not ceremony. An asset is the thing that decides whether the
 * system is allowed to speak about a subject at all, and a model reading a
 * marketing page will cheerfully propose that the client is excellent at
 * everything.
 */
export type AssetStatus = 'draft' | 'active' | 'retired';

/**
 * How we came to have this page's text — and the field this system is least
 * willing to be vague about.
 *
 * `fetched` — the server requested the URL and read the response itself. The
 * quotes behind every claim were checked against text nobody else touched.
 *
 * `pasted` — the server COULD NOT read the page (a real 403 on a real client
 * help centre is what forced this to exist) and a named person supplied the
 * content from their own browser. The same extraction runs, the same quote check
 * runs, and the same human approval is required — but the text itself rests on
 * that person's word, not on an observation we made.
 *
 * `unverified` — DISCOVERED BUT NOT READ. The page was found by source
 * discovery, or a verification attempt failed, and nobody has supplied its
 * content by either route. There is no text, so there are no claims, and the
 * asset is not usable for anything: it is a to-do item wearing an asset's shape.
 *
 * THESE ARE NEVER MERGED AND NEVER INFERRED. A pasted asset that reported itself
 * as fetched — or an unread one that reported itself as either — would be the
 * system lying about its own evidence, which is worse than having no evidence:
 * an operator reading the library would trust it more than they should, and
 * there would be nothing on the screen to correct them. Everywhere this value is
 * rendered, it is rendered plainly.
 */
export type TextSource = 'fetched' | 'pasted' | 'unverified';

export const TEXT_SOURCE_LABEL: Record<TextSource, string> = {
  fetched: 'Read by the server',
  pasted: 'Supplied by hand',
  unverified: 'Not read yet',
};

/** `projects/{projectId}/assets/{assetId}` */
export interface Asset {
  assetId: string;
  projectId: string;

  /** Short human name. "Cashout availability", not "Cashout — everything you need to know". */
  title: string;
  kind: AssetKind;
  /** One or two sentences: what it is and who it helps. */
  purpose: string;

  /** Problems this genuinely addresses, in the words a bettor would use. */
  problems: string[];
  /** Phrases in a thread that signal this asset is relevant. The main retrieval key. */
  triggers: string[];
  /**
   * When this asset is NOT relevant — the only field that can veto a match.
   *
   * Load-bearing, and the reason ingestion asks for it explicitly rather than
   * hoping the model volunteers it. "Cashout" is not relevant to a thread about
   * cashing OUT of a bank account, and without exclusions the trigger word alone
   * would match.
   */
  exclusions: string[];

  /** The page this came from. One asset, one source URL. */
  sourceUrl: string;

  status: AssetStatus;

  // --- provenance -------------------------------------------------------
  /** Who proposed it. A human-authored asset skips the draft step legitimately. */
  proposedBy: 'model' | 'human';
  /** Empty for a human-authored asset. */
  model: string;
  promptVersion: string;
  confirmedBy: string | null;
  confirmedByName: string | null;
  confirmedAt: Date | null;

  // --- provenance of the TEXT, as distinct from the asset ---------------
  /** Whether the server read this page or a person supplied it. Never inferred. */
  textSource: TextSource;
  /** For a pasted asset: who vouched that this is what the page says. Null for
   *  a fetched one, where nobody had to. */
  attestedBy: string | null;
  attestedByName: string | null;
  attestedAt: Date | null;
  /** The failure that sent this down the manual route, kept so the library can
   *  say WHY it could not be read rather than only that it was not. */
  fetchFailure: string | null;

  // --- freshness --------------------------------------------------------
  /**
   * Hash of the extracted page text at the last crawl.
   *
   * The whole freshness loop rests on this one field: a re-crawl that produces a
   * different hash means the page said something else today than it said when a
   * human agreed to this asset, and every claim taken from it is now unverified
   * — see freshness.ts.
   */
  sourceHash: string;
  lastCrawledAt: Date | null;
  /** Set by a re-crawl that found a different hash. Cleared on re-confirmation. */
  sourceChangedAt: Date | null;

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * How long a claim stays assertable without being looked at again.
 *
 * 90 days is a judgement, not a measurement, and it is deliberately shorter than
 * feels necessary. The failure it guards against is the expensive one: a reply
 * that confidently states a product behaviour that stopped being true, under the
 * client's own name, in public, in a regulated vertical. Re-verifying is a
 * re-crawl and a diff — cheap. Being wrong is not.
 */
export const CLAIM_TTL_DAYS = 90;

/** Days before expiry at which a claim starts asking to be re-verified. */
export const CLAIM_EXPIRING_DAYS = 14;

/**
 * `projects/{projectId}/claims/{claimId}` — one assertable fact.
 *
 * A draft may state a fact ONLY by citing one of these. That rule is enforced in
 * the compliance gate, and it is the mechanical form of "never invent the data
 * needed to make a point".
 */
export interface Claim {
  claimId: string;
  projectId: string;
  /** The asset this fact belongs to. Claims never float free. */
  assetId: string;

  /** The fact, as the reply would state it. One sentence, no hedging. */
  text: string;
  /**
   * The exact sentence on the page that supports it, verbatim.
   *
   * Not decoration: it is what a re-verification compares against, and what a
   * reviewer reads when deciding whether the model paraphrased honestly. A claim
   * whose quote cannot be found on the page any more is exactly the case the
   * freshness loop exists to catch.
   */
  quote: string;
  sourceUrl: string;

  /**
   * How the text this quote was checked against was obtained.
   *
   * Stored on the CLAIM as well as the asset, and not derived from it: a claim
   * verified against a fetched page keeps that standing even if the asset is
   * later re-attested by hand, and vice versa. The question "what was the
   * evidence when this fact was accepted" has to survive later edits to
   * anything else.
   */
  verifiedVia: TextSource;

  /** When a human last agreed this is what the page says. */
  verifiedAt: Date;
  /** verifiedAt + CLAIM_TTL_DAYS, stored so a query can find what is due. */
  expiresAt: Date;

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A claim's usability right now. DERIVED, never stored — see freshness.ts.
 *
 * Stored status was the alternative and it is a trap: the value changes with the
 * passage of time alone, so a stored copy is wrong the moment nothing happens,
 * and "nothing happens" is the normal state of a knowledge base.
 */
export type ClaimStatus =
  | 'live' // assertable
  | 'expiring' // assertable, but due for re-verification
  | 'expired' // TTL passed — NOT assertable
  | 'stale'; // its page changed since verification — NOT assertable

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  live: 'Verified',
  expiring: 'Due for review',
  expired: 'Expired',
  stale: 'Source changed',
};

/** The two states in which a claim may be stated in a reply. */
export const ASSERTABLE: readonly ClaimStatus[] = ['live', 'expiring'] as const;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** What the model proposes from one crawled page, before a human agrees. */
export interface AssetProposal {
  title: string;
  kind: AssetKind;
  purpose: string;
  problems: string[];
  triggers: string[];
  exclusions: string[];
  claims: ClaimProposal[];
}

export interface ClaimProposal {
  text: string;
  /** Must appear in the page text. Verified mechanically before a human sees it. */
  quote: string;
}

/** One fetched page, normalised. The input to ingestion and to a re-crawl. */
export interface CrawledPage {
  url: string;
  title: string;
  /** Visible text, whitespace-collapsed. */
  text: string;
  /** Stable hash of `text`. Two crawls of an unchanged page must agree. */
  hash: string;
  fetchedAtMs: number;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The approved text an asset was built from — `projects/{p}/assets/{a}/snapshot/current`.
 *
 * IN A SUBCOLLECTION, NOT A FIELD ON THE ASSET, and that is a performance
 * decision with teeth: the library page lists every asset, and a page of text on
 * each would mean downloading the client's entire help centre to render a list
 * of titles.
 *
 * It is stored for BOTH routes. For a fetched page it makes a later re-crawl
 * able to show what actually changed rather than only that the hash moved. For a
 * pasted one it is the only record that exists — the server cannot go and look
 * again, so a future comparison means a person pasting again and diffing against
 * this.
 */
export interface AssetSnapshot {
  text: string;
  hash: string;
  textSource: TextSource;
  capturedBy: string;
  capturedByName: string;
  capturedAt: Date;
  /** True when the stored text was cut to fit. A truncated snapshot can still
   *  be diffed, but it must not be read as the whole page. */
  truncated: boolean;
}

/**
 * How much snapshot text to keep.
 *
 * A Firestore document is capped at ~1 MiB and UTF-8 runs to four bytes a
 * character, so 100k characters is comfortably inside it with room for the rest
 * of the document. Longer pages keep their first 100k: enough to diff
 * meaningfully, and the `truncated` flag stops anyone reading it as complete.
 */
export const SNAPSHOT_MAX_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

/**
 * What an operator has decided about a discovered page.
 *
 * `new` — found, classified, nobody has looked.
 * `added` — promoted to an asset. `assetId` says which.
 * `ignored` — deliberately not wanted. Never offered again, and dropped from
 *   future discovery runs before they cost anything.
 * `review` — interesting, not now. The difference from `new` is that somebody
 *   HAS looked; without it, a queue of two hundred rows can only be worked by
 *   deciding every one of them in a single sitting.
 */
export type DiscoveryStatus = 'new' | 'added' | 'ignored' | 'review';

export const DISCOVERY_STATUS_LABEL: Record<DiscoveryStatus, string> = {
  new: 'Not looked at',
  added: 'Added',
  ignored: 'Ignored',
  review: 'Kept for later',
};

/** `projects/{projectId}/discoveries/{discoveryId}` — a candidate page.
 *
 *  NOT AN ASSET, and the separation is the feature. A discovery records that a
 *  URL exists and what it appears to be for; it carries no text, no claims and
 *  no evidence. Promoting one creates an asset, and only then does the existing
 *  verification decide whether anything can be cited from it. */
export interface Discovery {
  discoveryId: string;
  projectId: string;

  url: string;
  /** Locale- and tracking-stripped key. The uniqueness rule for a run. */
  dedupeKey: string;
  /** Link text seen pointing here — the best pre-fetch signal there is. */
  anchors: string[];
  source: 'sitemap' | 'link';

  // --- what it appears to be for. A GUESS, from the URL and anchors only. ---
  usefulFor: string;
  kind: AssetKind;
  /** 0-100, the classifier's own confidence that the page is what it looks like. */
  confidence: number;
  /** The classifier's view on whether a page read is worth spending here. */
  worthReading: boolean;
  /** Path-shape score from triage, before any model saw it. Ordering only. */
  pathScore: number;

  status: DiscoveryStatus;
  /** Set when status is 'added'. */
  assetId: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;

  model: string;
  promptVersion: string;
  discoveredAt: Date;
}

/** One discovery run, for the summary line and for not re-running blindly. */
export interface DiscoveryRun {
  domains: string[];
  /** URLs seen before triage. */
  seen: number;
  /** Candidates that survived triage and deduplication. */
  candidates: number;
  /** New discovery documents written. */
  written: number;
  /** Already known — in the library, or previously decided on. */
  skipped: number;
  pagesFetched: number;
  notes: string[];
}
