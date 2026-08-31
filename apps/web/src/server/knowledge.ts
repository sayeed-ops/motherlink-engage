import 'server-only';

// The asset library and claim ledger — the thin server half.
//
// Everything that DECIDES anything lives in modules/knowledge and is pure:
// what a page says (extract), whether to believe the model about it (prompts),
// which assets a thread is about (retrieval), and whether a fact may still be
// stated (freshness). This file fetches, reads and writes, and nothing else.
// Same split as server/commentKarma.ts, for the same reason — the interesting
// half stays testable without Firestore or a network.
//
// ════════════════════════════════════════════════════════════════════════════
// FETCHING THE CLIENT'S OWN SITE IS NOT LIKE FETCHING REDDIT
//
// modules/reddit/redditFetch.ts goes through a rotating residential proxy with a
// browser User-Agent because Reddit blocks that network. None of that applies
// here and using it would be wrong twice over: it would spend metered proxy
// bandwidth on a page anybody can fetch, and it would hide our identity from a
// client whose own site we are reading with their permission.
//
// So this is a plain fetch with an honest User-Agent, a short timeout, and a
// size cap. The only thing it has in common with the Reddit path is that it
// refuses to follow its input anywhere interesting — see assertPublicHttpUrl.
// ════════════════════════════════════════════════════════════════════════════

import { FieldValue, type DocumentData, type Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './admin';
import { crawlFromHtml } from '@/modules/knowledge/extract';
import { assertPublicHttpUrl, KnowledgeFetchError } from '@/modules/knowledge/url';
import { SNAPSHOT_MAX_CHARS, type Asset, type AssetSnapshot, type Claim, type CrawledPage, type TextSource } from '@/modules/knowledge/types';

// The URL guard and its error type are PURE and live in modules/knowledge/url.ts
// so they can be unit-tested without firebase-admin. Re-exported here because
// every caller of fetchPage catches the same error.
export { KnowledgeFetchError, assertPublicHttpUrl } from '@/modules/knowledge/url';

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
/** A help article is a few tens of kilobytes. A megabyte of HTML is something
 *  else, and reading all of it into memory to throw most of it away is how a
 *  serverless function dies. */
const MAX_BYTES = 2_000_000;

const USER_AGENT = 'MotherlinkEngage/1.0 (+knowledge-ingest; contact via the site owner)';

/** Fetch one page and reduce it to text plus a hash. */
export async function fetchPage(rawUrl: string, nowMs: number): Promise<CrawledPage> {
  const url = assertPublicHttpUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new KnowledgeFetchError(
      502,
      aborted ? 'timeout' : 'unreachable',
      aborted ? 'That page took too long to respond.' : 'That page could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 403 is the one that made the manual route necessary: a real client help
    // centre behind a bot filter answers every server politely and refuses.
    // 401/429/451 are the same situation wearing different numbers — the page
    // exists and a person can see it, we just are not allowed to.
    const refusing = res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451;
    throw new KnowledgeFetchError(
      502,
      refusing ? 'blocked' : 'bad-status',
      refusing
        ? `That page refused us (HTTP ${res.status}) — it is almost certainly readable in a browser.`
        : `That page returned HTTP ${res.status}.`,
    );
  }

  const type = res.headers.get('content-type') ?? '';
  if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
    throw new KnowledgeFetchError(400, 'not-html', `That URL is ${type.split(';')[0]}, not a web page.`);
  }

  const html = await readCapped(res);
  const page = crawlFromHtml(url.toString(), html, nowMs);

  if (page.text.length < 200) {
    // Almost always a JavaScript-rendered page: HTTP 200, real HTML, no prose.
    // Say what it means rather than proposing an asset from nothing.
    throw new KnowledgeFetchError(
      400,
      'no-text',
      'That page has almost no readable text — it probably needs JavaScript to render.',
    );
  }
  return page;
}

/** Read the body but stop at the cap, rather than buffering whatever arrives. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new KnowledgeFetchError(400, 'too-large', 'That page is too large to read.');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const ts = (v: unknown): Date | null =>
  v && typeof (v as Timestamp).toDate === 'function' ? (v as Timestamp).toDate() : null;

function toAsset(id: string, d: DocumentData): Asset {
  return {
    assetId: id,
    projectId: String(d.projectId ?? ''),
    title: String(d.title ?? ''),
    kind: d.kind ?? 'guide',
    purpose: String(d.purpose ?? ''),
    problems: Array.isArray(d.problems) ? d.problems : [],
    triggers: Array.isArray(d.triggers) ? d.triggers : [],
    exclusions: Array.isArray(d.exclusions) ? d.exclusions : [],
    sourceUrl: String(d.sourceUrl ?? ''),
    status: d.status ?? 'draft',
    proposedBy: d.proposedBy === 'human' ? 'human' : 'model',
    model: String(d.model ?? ''),
    promptVersion: String(d.promptVersion ?? ''),
    confirmedBy: d.confirmedBy ?? null,
    confirmedByName: d.confirmedByName ?? null,
    confirmedAt: ts(d.confirmedAt),
    // Absent means fetched: every asset written before the manual route existed
    // WAS read by the server, so the default is the truth about them rather than
    // a convenient guess. Anything pasted has the field written explicitly.
    textSource: d.textSource === 'pasted' ? 'pasted' : 'fetched',
    attestedBy: d.attestedBy ?? null,
    attestedByName: d.attestedByName ?? null,
    attestedAt: ts(d.attestedAt),
    fetchFailure: d.fetchFailure ?? null,
    sourceHash: String(d.sourceHash ?? ''),
    lastCrawledAt: ts(d.lastCrawledAt),
    sourceChangedAt: ts(d.sourceChangedAt),
    createdBy: String(d.createdBy ?? ''),
    createdAt: ts(d.createdAt) ?? new Date(0),
    updatedAt: ts(d.updatedAt) ?? new Date(0),
  };
}

function toClaim(id: string, d: DocumentData): Claim {
  return {
    claimId: id,
    projectId: String(d.projectId ?? ''),
    assetId: String(d.assetId ?? ''),
    text: String(d.text ?? ''),
    quote: String(d.quote ?? ''),
    sourceUrl: String(d.sourceUrl ?? ''),
    verifiedVia: d.verifiedVia === 'pasted' ? 'pasted' : 'fetched',
    verifiedAt: ts(d.verifiedAt) ?? new Date(0),
    expiresAt: ts(d.expiresAt) ?? new Date(0),
    createdBy: String(d.createdBy ?? ''),
    createdAt: ts(d.createdAt) ?? new Date(0),
    updatedAt: ts(d.updatedAt) ?? new Date(0),
  };
}

const assetsRef = (projectId: string) => adminDb().collection('projects').doc(projectId).collection('assets');
const claimsRef = (projectId: string) => adminDb().collection('projects').doc(projectId).collection('claims');

export async function listAssets(projectId: string): Promise<Asset[]> {
  const snap = await assetsRef(projectId).get();
  return snap.docs.map((d) => toAsset(d.id, d.data())).sort((a, b) => a.title.localeCompare(b.title));
}

export async function listClaims(projectId: string): Promise<Claim[]> {
  const snap = await claimsRef(projectId).get();
  return snap.docs.map((d) => toClaim(d.id, d.data()));
}

export async function getAsset(projectId: string, assetId: string): Promise<Asset | null> {
  const doc = await assetsRef(projectId).doc(assetId).get();
  return doc.exists ? toAsset(doc.id, doc.data() as DocumentData) : null;
}

/** Everything the library page and a scan both need, in two reads. */
/** Replace one asset's trigger list. Used by the trigger repair — see the
 *  route — and by nothing else: triggers are otherwise only written when an
 *  asset is created or merged into. */
export async function setAssetTriggers(
  projectId: string,
  assetId: string,
  triggers: string[],
): Promise<void> {
  await assetsRef(projectId)
    .doc(assetId)
    .update({ triggers, updatedAt: FieldValue.serverTimestamp() });
}

export async function loadLibrary(projectId: string): Promise<{ assets: Asset[]; claims: Claim[] }> {
  const [assets, claims] = await Promise.all([listAssets(projectId), listClaims(projectId)]);
  return { assets, claims };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SaveAssetInput {
  projectId: string;
  title: string;
  kind: Asset['kind'];
  purpose: string;
  problems: string[];
  triggers: string[];
  exclusions: string[];
  sourceUrl: string;
  sourceHash: string;
  proposedBy: 'model' | 'human';
  model: string;
  promptVersion: string;
  claims: { text: string; quote: string }[];
  /** Confirming on save is the normal path: a human is looking at the proposal
   *  when they press the button, so requiring a second click to activate it
   *  would be ceremony rather than a check. */
  activate: boolean;
  /** How the text was obtained. Passed in rather than inferred — see TextSource. */
  textSource: TextSource;
  /** The failure that forced the manual route, for a pasted asset. */
  fetchFailure: string | null;
  /** The approved text itself. Stored as the snapshot so a later change can be
   *  compared — the only record that will ever exist for a pasted page. */
  snapshotText: string;
  actor: { uid: string; name: string };
  nowMs: number;
  expiresAtMs: number;
}

/**
 * Write one asset and its claims together.
 *
 * ONE BATCH, and that is the point: an asset whose claims failed to write is an
 * asset that silently cannot be cited, which looks identical to an asset whose
 * page genuinely asserts nothing. The two must never be confusable, so they
 * commit together or not at all.
 */
export async function saveAsset(input: SaveAssetInput): Promise<{ assetId: string; claimIds: string[] }> {
  const db = adminDb();
  const batch = db.batch();

  const assetDoc = assetsRef(input.projectId).doc();
  const now = new Date(input.nowMs);

  batch.set(assetDoc, {
    assetId: assetDoc.id,
    projectId: input.projectId,
    title: input.title,
    kind: input.kind,
    purpose: input.purpose,
    problems: input.problems,
    triggers: input.triggers,
    exclusions: input.exclusions,
    sourceUrl: input.sourceUrl,
    status: input.activate ? 'active' : 'draft',
    proposedBy: input.proposedBy,
    model: input.model,
    promptVersion: input.promptVersion,
    confirmedBy: input.activate ? input.actor.uid : null,
    confirmedByName: input.activate ? input.actor.name : null,
    confirmedAt: input.activate ? now : null,
    textSource: input.textSource,
    // A fetched asset has nobody attesting to anything — the server saw it.
    // Writing the actor here anyway would make the two routes indistinguishable
    // in the data, which is the one thing this field exists to prevent.
    attestedBy: input.textSource === 'pasted' ? input.actor.uid : null,
    attestedByName: input.textSource === 'pasted' ? input.actor.name : null,
    attestedAt: input.textSource === 'pasted' ? now : null,
    fetchFailure: input.fetchFailure,
    sourceHash: input.sourceHash,
    lastCrawledAt: input.textSource === 'fetched' ? now : null,
    sourceChangedAt: null,
    createdBy: input.actor.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const claimIds: string[] = [];
  for (const claim of input.claims) {
    const claimDoc = claimsRef(input.projectId).doc();
    claimIds.push(claimDoc.id);
    batch.set(claimDoc, {
      claimId: claimDoc.id,
      projectId: input.projectId,
      assetId: assetDoc.id,
      text: claim.text,
      quote: claim.quote,
      sourceUrl: input.sourceUrl,
      verifiedVia: input.textSource,
      verifiedAt: now,
      expiresAt: new Date(input.expiresAtMs),
      createdBy: input.actor.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // The snapshot rides the same batch: an asset whose text failed to store is an
  // asset nothing can ever be compared against, and for a pasted page that text
  // is irrecoverable — nobody can re-fetch it.
  //
  // An unverified asset has no text, so it gets no snapshot. Writing an empty
  // one would create a record asserting "this is what the page said" about a
  // page nobody has read.
  if (input.snapshotText) writeSnapshot(batch, input.projectId, assetDoc.id, {
    text: input.snapshotText,
    hash: input.sourceHash,
    textSource: input.textSource,
    capturedBy: input.actor.uid,
    capturedByName: input.actor.name,
    capturedAt: now,
  });

  await batch.commit();
  return { assetId: assetDoc.id, claimIds };
}

/** Thrown rather than returned: activating an unread asset is not a validation
 *  slip to report back, it is a rule the whole design rests on. */
export class UnverifiedAssetError extends Error {
  constructor() {
    super('That page has not been read yet, so there is nothing to confirm. Read it, or paste its content.');
    this.name = 'UnverifiedAssetError';
  }
}

export async function setAssetStatus(
  projectId: string,
  assetId: string,
  status: Asset['status'],
  actor: { uid: string; name: string },
  nowMs: number,
): Promise<void> {
  const activating = status === 'active';

  // The discovery/verification line, enforced at the only place it could be
  // crossed. "Active" means the system may build replies on this asset; an asset
  // whose page nobody has read has no content to build on, however confident its
  // guessed title looks.
  if (activating) {
    const current = await getAsset(projectId, assetId);
    if (current?.textSource === 'unverified') throw new UnverifiedAssetError();
  }

  await assetsRef(projectId)
    .doc(assetId)
    .update({
      status,
      // Re-confirming is what clears a staleness flag: somebody has now looked
      // at the changed page and agreed the asset still describes it. Nothing
      // else may clear it, or the flag would mean nothing.
      ...(activating
        ? {
            sourceChangedAt: null,
            confirmedBy: actor.uid,
            confirmedByName: actor.name,
            confirmedAt: new Date(nowMs),
          }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Record what a re-crawl found. Writes the flag; does not decide anything. */
export async function recordCrawl(
  projectId: string,
  assetId: string,
  page: { hash: string },
  changed: boolean,
  nowMs: number,
): Promise<void> {
  await assetsRef(projectId)
    .doc(assetId)
    .update({
      lastCrawledAt: new Date(nowMs),
      ...(changed ? { sourceHash: page.hash, sourceChangedAt: new Date(nowMs) } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Re-verify one claim: somebody has read the page and it still says this. */
export async function reverifyClaim(
  projectId: string,
  claimId: string,
  nowMs: number,
  expiresAtMs: number,
): Promise<void> {
  await claimsRef(projectId).doc(claimId).update({
    verifiedAt: new Date(nowMs),
    expiresAt: new Date(expiresAtMs),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Delete an asset and every claim that hangs off it.
 *
 *  Claims are deleted WITH it rather than orphaned: a claim with no asset can
 *  never be evaluated for freshness (staleness is a property of the asset's
 *  page), so an orphan is a fact that can never expire. */
export async function deleteAsset(projectId: string, assetId: string): Promise<number> {
  const db = adminDb();
  const claims = await claimsRef(projectId).where('assetId', '==', assetId).get();

  const batch = db.batch();
  claims.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(assetsRef(projectId).doc(assetId));
  await batch.commit();

  return claims.size;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const snapshotRef = (projectId: string, assetId: string) =>
  assetsRef(projectId).doc(assetId).collection('snapshot').doc('current');

/** Queue the snapshot write onto an existing batch. Truncates to fit a Firestore
 *  document and says so, rather than failing a save over a long page. */
function writeSnapshot(
  batch: FirebaseFirestore.WriteBatch,
  projectId: string,
  assetId: string,
  snap: Omit<AssetSnapshot, 'truncated'>,
): void {
  const truncated = snap.text.length > SNAPSHOT_MAX_CHARS;
  batch.set(snapshotRef(projectId, assetId), {
    ...snap,
    text: truncated ? snap.text.slice(0, SNAPSHOT_MAX_CHARS) : snap.text,
    truncated,
  });
}

export async function getSnapshot(projectId: string, assetId: string): Promise<AssetSnapshot | null> {
  const doc = await snapshotRef(projectId, assetId).get();
  if (!doc.exists) return null;
  const d = doc.data() as DocumentData;
  return {
    text: String(d.text ?? ''),
    hash: String(d.hash ?? ''),
    textSource: d.textSource === 'pasted' ? 'pasted' : 'fetched',
    capturedBy: String(d.capturedBy ?? ''),
    capturedByName: String(d.capturedByName ?? ''),
    capturedAt: ts(d.capturedAt) ?? new Date(0),
    truncated: d.truncated === true,
  };
}

/** Replace the stored text for an asset — a re-crawl that found a change, or a
 *  person re-pasting a page the server still cannot read. */
export async function putSnapshot(
  projectId: string,
  assetId: string,
  snap: Omit<AssetSnapshot, 'truncated'>,
): Promise<void> {
  const batch = adminDb().batch();
  writeSnapshot(batch, projectId, assetId, snap);
  await batch.commit();
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergeInput {
  projectId: string;
  assetId: string;
  triggers: string[];
  problems: string[];
  exclusions: string[];
  claims: { text: string; quote: string; sourceUrl: string }[];
  textSource: TextSource;
  actor: { uid: string; name: string };
  nowMs: number;
  expiresAtMs: number;
}

export interface MergeResult {
  triggers: number;
  problems: number;
  exclusions: number;
  claims: number;
}

/**
 * Fold a researched answer into an asset that already exists.
 *
 * THE REASON THE QUESTIONNAIRE DOES NOT BLOAT THE LIBRARY. A hundred questions
 * about a sportsbook circle the same dozen features from different angles, and
 * without this every angle would become its own asset — five entries for one
 * page, five near-identical retrieval hits, and a prompt budget spent on
 * repetition.
 *
 * UNION, NOT REPLACE. The existing asset is the one a person confirmed; a merge
 * adds what the new answer knows and removes nothing. Deduplication is on
 * normalised text so "Cashout disappeared" does not join "cashout disappeared".
 *
 * CLAIMS ARE APPENDED, NEVER DEDUPLICATED BY TEXT. Two claims that read alike
 * may cite different pages, and the ledger's whole job is to remember which
 * sentence on which page supports what — collapsing them would throw away the
 * evidence and keep the assertion.
 */
export async function mergeIntoAsset(input: MergeInput): Promise<MergeResult> {
  const db = adminDb();
  const assetRef = assetsRef(input.projectId).doc(input.assetId);
  const doc = await assetRef.get();
  if (!doc.exists) throw new Error('No such asset.');

  const current = toAsset(doc.id, doc.data() as DocumentData);
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const union = (existing: string[], incoming: string[], cap: number) => {
    const seen = new Set(existing.map(key));
    const added: string[] = [];
    for (const item of incoming) {
      if (seen.has(key(item))) continue;
      seen.add(key(item));
      added.push(item);
    }
    return { merged: [...existing, ...added].slice(0, cap), added: added.length };
  };

  const triggers = union(current.triggers, input.triggers, 16);
  const problems = union(current.problems, input.problems, 12);
  const exclusions = union(current.exclusions, input.exclusions, 10);

  const batch = db.batch();
  batch.update(assetRef, {
    triggers: triggers.merged,
    problems: problems.merged,
    exclusions: exclusions.merged,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const existingClaims = await claimsRef(input.projectId).where('assetId', '==', input.assetId).get();
  const existingQuotes = new Set(existingClaims.docs.map((d) => key(String(d.data().quote ?? ''))));

  let claimsAdded = 0;
  for (const claim of input.claims) {
    // The quote is the identity of a claim. Two claims backed by the same
    // sentence are the same fact however differently they are worded.
    if (existingQuotes.has(key(claim.quote))) continue;
    existingQuotes.add(key(claim.quote));

    const ref = claimsRef(input.projectId).doc();
    batch.set(ref, {
      claimId: ref.id,
      projectId: input.projectId,
      assetId: input.assetId,
      text: claim.text,
      quote: claim.quote,
      sourceUrl: claim.sourceUrl || current.sourceUrl,
      verifiedVia: input.textSource,
      verifiedAt: new Date(input.nowMs),
      expiresAt: new Date(input.expiresAtMs),
      createdBy: input.actor.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    claimsAdded++;
  }

  await batch.commit();

  return {
    triggers: triggers.added,
    problems: problems.added,
    exclusions: exclusions.added,
    claims: claimsAdded,
  };
}
